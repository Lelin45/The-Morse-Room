package com.morsenepal.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.core.app.RemoteInput
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class NotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    // Capture before Keystore, SharedPreferences, notification IPC or audio work can delay the next tap.
    val arrivedAt = SystemClock.elapsedRealtime()
    val epoch = NotificationStore.accountEpoch.get()
    val key = intent.getStringExtra("key") ?: return
    if (key == "stop") {
      context.stopService(Intent(context, MorsePlaybackService::class.java))
      return
    }
    if (!MorseNotifications.unlocked(context)) return
    val messageId = intent.getStringExtra("messageId") ?: return
    val text = if (key == "text") RemoteInput.getResultsFromIntent(intent)
      ?.getCharSequence(MorseNotifications.REPLY_KEY)?.toString() else null
    val pending = goAsync()
    NotificationActionDispatcher.receive(context.applicationContext, messageId, key, text, arrivedAt, epoch) { pending.finish() }
  }
}

/** One ordered model queue. Only snapshots are coalesced; input events are never debounced. */
internal object NotificationActionDispatcher {
  private data class Entry(val message: JSONObject, val epoch: Long)
  private val executor = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "MorseNotificationInput") }
  private val messages = linkedMapOf<String, Entry>()
  private val dirty = linkedSetOf<String>()
  private var scheduledFlush: ScheduledFuture<*>? = null
  private const val SNAPSHOT_MILLIS = 250L

  fun receive(context: Context, messageId: String, key: String, text: String?, arrivedAt: Long, epoch: Long, finish: () -> Unit) {
    executor.execute {
      try {
        if (NotificationStore.accountEpoch.get() != epoch || !MorseNotifications.unlocked(context)) return@execute
        val message = entry(context, messageId, epoch) ?: return@execute
        if (message.optBoolean("sending") && key in listOf("text", "morse", "dit", "dah", "space", "backspace", "send")) return@execute
        var immediate = key !in listOf("dit", "dah", "space", "backspace")
        when (key) {
          "reveal" -> message.put("revealed", !message.optBoolean("revealed"))
          "reply" -> message.put("replyMode", "choose").put("status", "Choose text or Morse")
          "morse" -> {
            message.put("replyMode", "morse").put("status", "")
            MorsePlaybackService.prepareEditor(context, messageId)
          }
          "back" -> {
            message.put("replyMode", "message").put("status", "")
            context.stopService(Intent(context, MorsePlaybackService::class.java))
          }
          "listen" -> {
            MorsePlaybackService.listen(context, messageId, MorseCodec.encode(message.optString("text").take(1000)), NotificationAudioSettings.read(context))
            return@execute
          }
          "text" -> {
            if (text == null) return@execute
            if (text.isBlank() || text.length > 1000 || MorseCodec.encode(text).isBlank())
              message.put("status", "Include letters or numbers, up to 1,000 characters.")
            else { queueReply(context, message, JSONObject().put("kind", "text").put("text", text)); return@execute }
          }
          "dit", "dah", "space", "backspace" -> {
            if (message.optString("replyMode") != "morse") return@execute
            val draft = MorseDraft(message.optString("draft"), message.optLong("lastTap", 0L))
            try {
              val settings = NotificationAudioSettings.read(context)
              val next = when (key) {
                "space" -> draft.word()
                "backspace" -> draft.backspace(arrivedAt)
                else -> draft.mark(if (key == "dit") '.' else '-', arrivedAt, settings)
              }
              message.put("draft", next.signal).put("lastTap", next.lastTapMillis).put("status", "")
              if (key == "dit" || key == "dah") MorsePlaybackService.tone(context, messageId,
                if (key == "dit") "." else "-", settings, draft.gapUnitsBefore(next))
            } catch (error: IllegalArgumentException) { message.put("status", error.message); immediate = true }
          }
          "send" -> {
            try {
              MorseCodec.decodeDraft(message.optString("draft"))
              queueReply(context, message, JSONObject().put("kind", "morse").put("morse", message.optString("draft")))
              return@execute
            } catch (error: IllegalArgumentException) { message.put("status", error.message ?: "Check your Morse message.") }
          }
          else -> return@execute
        }
        dirty.add(messageId)
        if (immediate) flush(context) else scheduleFlush(context)
      } catch (_: Exception) {
        // A failed audio route never discards an already accepted draft.
        messages[messageId]?.message?.put("status", "Audio could not start. Your Morse draft is saved.")
        dirty.add(messageId)
        runCatching { flush(context) }
      } finally { finish() }
    }
  }

  private fun entry(context: Context, id: String, epoch: Long): JSONObject? {
    messages[id]?.takeIf { it.epoch == epoch &&
      System.currentTimeMillis() - it.message.optLong("savedAt", 0L) <= 7L * 24 * 60 * 60 * 1000 }?.let { return it.message }
    val message = MorseNotifications.currentMessage(context, id) ?: return null
    if (messages.size >= 20) messages.remove(messages.keys.first())
    messages[id] = Entry(message, epoch)
    return message
  }

  private fun scheduleFlush(context: Context) {
    if (scheduledFlush == null) scheduledFlush = executor.schedule({ flush(context) }, SNAPSHOT_MILLIS, TimeUnit.MILLISECONDS)
  }

  private fun flush(context: Context) {
    scheduledFlush?.cancel(false)
    scheduledFlush = null
    for (id in dirty.toList()) {
      val cached = messages[id] ?: continue
      synchronized(NotificationStore) {
        if (cached.epoch == NotificationStore.accountEpoch.get() &&
          NotificationStore.read(context, "credentials")?.optString("userId") == cached.message.optString("userId")) {
          MorseNotifications.save(context, cached.message)
          MorseNotifications.show(context, cached.message)
        } else messages.remove(id)
      }
    }
    dirty.clear()
  }

  private fun queueReply(context: Context, message: JSONObject, body: JSONObject) {
    if (message.optBoolean("sending")) return
    synchronized(NotificationStore) {
      val id = message.getString("id")
      val cached = messages[id] ?: return
      if (cached.epoch != NotificationStore.accountEpoch.get() ||
        NotificationStore.read(context, "credentials")?.optString("userId") != message.optString("userId")) return
      val clientId = UUID.randomUUID().toString()
      body.put("messageId", id).put("conversationId", message.getString("conversationId")).put("clientId", clientId)
      NotificationStore.write(context, "reply:$clientId", JSONObject().put("body", body)
        .put("userId", message.getString("userId")).put("messageId", id))
      message.put("status", "Sending reply...").put("sending", true)
      dirty.add(id)
      // Commit the sending guard and full draft before WorkManager can complete a fast request.
      flush(context)
      context.stopService(Intent(context, MorsePlaybackService::class.java))
      NotificationWorker.enqueueReply(context, clientId, message.getString("userId"))
    }
  }

  /** Worker completion merges into the same model, so a delayed snapshot cannot revive an old draft. */
  fun updateFromWorker(context: Context, messageId: String, userId: String, change: (JSONObject) -> Unit) {
    val epoch = NotificationStore.accountEpoch.get()
    executor.submit {
      if (NotificationStore.read(context, "credentials")?.optString("userId") != userId ||
        epoch != NotificationStore.accountEpoch.get()) return@submit
      val message = entry(context, messageId, epoch) ?: return@submit
      change(message)
      dirty.add(messageId)
      flush(context)
    }.get(5, TimeUnit.SECONDS)
  }
}
