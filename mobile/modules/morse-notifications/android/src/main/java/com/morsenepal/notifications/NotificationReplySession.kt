package com.morsenepal.notifications

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Main-thread editor model. Keystore, durable writes and notification IPC use a separate queue. */
internal object NotificationReplySession {
  data class Snapshot(
    val messageId: String, val title: String, val incomingText: String, val incomingMorse: String,
    val draftText: String, val draftMorse: String, val mode: String, val status: String,
    val sending: Boolean, val sent: Boolean
  )

  private data class Entry(
    val context: Context, val message: JSONObject, val epoch: Long, var draft: NotificationReplyDraft,
    val observers: MutableSet<(Snapshot?) -> Unit> = linkedSetOf(), var saveTask: Runnable? = null,
    var notifyOnSave: Boolean = false
  ) {
    val id: String = message.getString("id")
    val userId: String = message.getString("userId")
  }

  private val main = Handler(Looper.getMainLooper())
  private val persistence = Executors.newSingleThreadExecutor { task -> Thread(task, "MorseReplyStorage") }
  private val entries = linkedMapOf<String, Entry>()
  private const val SAVE_DELAY = 300L

  fun open(context: Context, messageId: String): Snapshot? {
    check(Looper.myLooper() == Looper.getMainLooper())
    if (!MorseNotifications.unlocked(context)) return null
    return load(context, messageId)?.let(::snapshot)
  }

  /** Background delivery can finish while locked; only displaying/editing requires an unlocked device. */
  private fun load(context: Context, messageId: String): Entry? {
    entries[messageId]?.let {
      if (it.epoch == NotificationStore.accountEpoch.get() &&
        System.currentTimeMillis() - it.message.optLong("savedAt", 0L) <= 7L * 24 * 60 * 60 * 1000) return it
      invalidate(messageId)
    }
    val epoch = NotificationStore.accountEpoch.get()
    val message = MorseNotifications.currentMessage(context, messageId) ?: return null
    if (epoch != NotificationStore.accountEpoch.get()) return null
    if (entries.size >= 20) entries.entries.firstOrNull { it.value.observers.isEmpty() }?.let {
      persist(it.value)
      entries.remove(it.key)
    }
    val entry = Entry(context.applicationContext, message, epoch, draftFrom(message))
    entries[messageId] = entry
    NotificationAudioSettings.read(context)
    return entry
  }

  fun listen(messageId: String, observer: (Snapshot?) -> Unit): AutoCloseable {
    check(Looper.myLooper() == Looper.getMainLooper())
    val entry = active(messageId)
    entry?.observers?.add(observer)
    observer(entry?.let(::snapshot))
    return AutoCloseable { onMain { entries[messageId]?.observers?.remove(observer) } }
  }

  fun editText(messageId: String, text: String) = edit(messageId) { it.editText(text) }
  fun space(messageId: String) = edit(messageId) { it.word() }
  fun backspace(messageId: String, timestampMs: Long) = edit(messageId) { it.backspace(timestampMs) }

  fun mark(messageId: String, mark: Char, timestampMs: Long) {
    val entry = editable(messageId) ?: return
    if (entry.draft.mode != "morse") return
    val settings = NotificationAudioSettings.read(entry.context)
    try {
      val previous = entry.draft.morse
      entry.draft = entry.draft.mark(mark, timestampMs, settings)
      entry.message.put("status", "").put("replySent", false)
      changed(entry)
      runCatching { MorsePlaybackService.tone(entry.context, messageId, mark.toString(), settings,
        previous.gapUnitsBefore(entry.draft.morse)) }
    } catch (error: IllegalArgumentException) { status(entry, error.message ?: "Check your Morse message.") }
  }

  fun switchMode(messageId: String, mode: String) {
    val entry = editable(messageId) ?: return
    val before = entry.draft.mode
    try {
      entry.draft = entry.draft.switchMode(mode)
      entry.message.put("status", "").put("replySent", false)
      changed(entry)
      if (mode == "morse") runCatching { MorsePlaybackService.prepareEditor(entry.context, messageId) }
      else if (before == "morse") entry.context.stopService(Intent(entry.context, MorsePlaybackService::class.java))
    } catch (error: IllegalArgumentException) { status(entry, error.message ?: "Complete the Morse letter before switching.") }
  }

  fun close(messageId: String) {
    val entry = entries[messageId]?.takeIf { it.epoch == NotificationStore.accountEpoch.get() } ?: return
    entry.saveTask?.let(main::removeCallbacks)
    entry.saveTask = null
    entry.message.put("replyMode", "message")
    persist(entry, notify = true)
    entry.context.stopService(Intent(entry.context, MorsePlaybackService::class.java))
  }

  fun send(messageId: String, completion: () -> Unit = {}) {
    val entry = editable(messageId) ?: run { completion(); return }
    val body = try {
      val text = entry.draft.textForSending()
      if (entry.draft.mode == "morse") JSONObject().put("kind", "morse").put("morse", entry.draft.morse.signal)
      else JSONObject().put("kind", "text").put("text", text)
    } catch (error: IllegalArgumentException) {
      status(entry, error.message ?: "Check your message.")
      completion()
      return
    }
    val clientId = UUID.randomUUID().toString()
    val userId = entry.message.getString("userId")
    body.put("messageId", messageId).put("conversationId", entry.message.getString("conversationId")).put("clientId", clientId)
    entry.message.put("sending", true).put("replySent", false).put("status", "Sending reply...")
      .put("pendingReplyId", clientId)
    entry.saveTask?.let(main::removeCallbacks)
    entry.saveTask = null
    syncMessage(entry)
    publish(entry)
    val saved = savedMessage(entry)
    val pending = JSONObject().put("body", body).put("userId", userId).put("messageId", messageId)
    persistence.execute {
      try {
        val accepted = synchronized(NotificationStore) {
          if (!sameAccount(entry)) false else {
            MorseNotifications.save(entry.context, saved)
            NotificationStore.write(entry.context, "reply:$clientId", pending)
            true
          }
        }
        if (!accepted) { onMain { invalidate(messageId) }; return@execute }
        MorseNotifications.show(entry.context, saved)
        NotificationWorker.enqueueReply(entry.context, clientId, userId).result.get(8, TimeUnit.SECONDS)
      } catch (_: Exception) {
        onMain {
          active(messageId)?.takeIf { it === entry }?.let {
            it.message.put("sending", false)
            status(it, "Reply could not be queued. Your draft is saved here.")
          }
        }
      } finally { completion() }
    }
    entry.context.stopService(Intent(entry.context, MorsePlaybackService::class.java))
  }

  /** Existing inline actions and the compact editor share a single draft. */
  fun action(context: Context, messageId: String, key: String, text: String?, timestamp: Long, epoch: Long, completion: () -> Unit) {
    var sendingAsync = false
    try {
      if (epoch != NotificationStore.accountEpoch.get() || open(context, messageId) == null) return
      val entry = active(messageId) ?: return
      when (key) {
      "reveal" -> { entry.message.put("revealed", !entry.message.optBoolean("revealed")); changed(entry, notify = true) }
      "reply" -> { entry.message.put("replyMode", "choose").put("status", ""); changed(entry, notify = true) }
      "back" -> { entry.message.put("replyMode", "message").put("status", ""); changed(entry, notify = true) }
      "listen" -> MorsePlaybackService.listen(context, messageId,
        MorseCodec.encode(entry.message.optString("text").take(1000)), NotificationAudioSettings.read(context))
      "text" -> {
        if (entry.message.optBoolean("sending") || text == null) return
        try {
          entry.draft = entry.draft.copy(mode = "text").editText(text)
          sendingAsync = true
          send(messageId, completion)
        }
        catch (error: IllegalArgumentException) { status(entry, error.message ?: "Check your message.", notify = true) }
      }
      "morse" -> { switchMode(messageId, "morse"); changed(entry, notify = true) }
      "dit", "dah" -> mark(messageId, if (key == "dit") '.' else '-', timestamp)
      "space" -> space(messageId)
      "backspace" -> backspace(messageId, timestamp)
      "send" -> { sendingAsync = true; send(messageId, completion) }
      }
    } finally {
      // Inline RemoteInput has no foreground Activity. Keep the receiver alive until durable work exists.
      if (!sendingAsync) completion()
    }
  }

  fun updateFromWorker(context: Context, messageId: String, userId: String, change: (JSONObject) -> Unit) {
    val epoch = NotificationStore.accountEpoch.get()
    val done = CountDownLatch(1)
    val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
    onMain {
      var queued = false
      try {
        if (epoch != NotificationStore.accountEpoch.get()) return@onMain
        val entry = load(context, messageId)?.takeIf { it.userId == userId } ?: return@onMain
        change(entry.message)
        entry.draft = draftFrom(entry.message)
        syncMessage(entry)
        publish(entry)
        entry.saveTask?.let(main::removeCallbacks)
        entry.saveTask = null
        persist(entry, notify = true) { error -> failure.set(error); done.countDown() }
        queued = true
      } finally { if (!queued) done.countDown() }
    }
    if (Looper.myLooper() != Looper.getMainLooper()) {
      check(done.await(10, TimeUnit.SECONDS)) { "Reply state update timed out." }
      failure.get()?.let { throw IllegalStateException("Reply state could not be saved.", it) }
    }
  }

  fun clearAll() = onMain { for (id in entries.keys.toList()) invalidate(id) }

  private fun edit(messageId: String, change: (NotificationReplyDraft) -> NotificationReplyDraft) {
    val entry = editable(messageId) ?: return
    try {
      entry.draft = change(entry.draft)
      entry.message.put("status", "").put("replySent", false)
      changed(entry)
    } catch (error: IllegalArgumentException) { status(entry, error.message ?: "Check your message.") }
  }

  private fun editable(messageId: String): Entry? = active(messageId)?.takeUnless { it.message.optBoolean("sending") }

  private fun active(messageId: String): Entry? {
    check(Looper.myLooper() == Looper.getMainLooper())
    val entry = entries[messageId] ?: return null
    if (entry.epoch != NotificationStore.accountEpoch.get() ||
      System.currentTimeMillis() - entry.message.optLong("savedAt", 0L) > 7L * 24 * 60 * 60 * 1000) {
      invalidate(messageId)
      return null
    }
    if (!MorseNotifications.unlocked(entry.context)) {
      entry.saveTask?.let(main::removeCallbacks)
      entry.saveTask = null
      persist(entry)
      for (observer in entry.observers.toList()) runCatching { observer(null) }
      entry.observers.clear()
      return null
    }
    return entry
  }

  private fun invalidate(messageId: String) {
    val entry = entries.remove(messageId) ?: return
    entry.saveTask?.let(main::removeCallbacks)
    for (observer in entry.observers.toList()) runCatching { observer(null) }
    entry.observers.clear()
  }

  private fun changed(entry: Entry, notify: Boolean = false, immediate: Boolean = false) {
    syncMessage(entry)
    publish(entry)
    entry.notifyOnSave = entry.notifyOnSave || notify
    if (immediate) {
      entry.saveTask?.let(main::removeCallbacks)
      entry.saveTask = null
      val notifyNow = entry.notifyOnSave
      entry.notifyOnSave = false
      persist(entry, notifyNow)
    } else if (entry.saveTask == null) {
      val task = Runnable {
        entry.saveTask = null
        if (active(entry.message.getString("id")) === entry) {
          val notifyNow = entry.notifyOnSave
          entry.notifyOnSave = false
          persist(entry, notifyNow)
        }
      }
      entry.saveTask = task
      main.postDelayed(task, SAVE_DELAY)
    }
  }

  private fun status(entry: Entry, message: String, notify: Boolean = false) {
    entry.message.put("status", message)
    changed(entry, notify)
  }

  private fun publish(entry: Entry) {
    if (!MorseNotifications.unlocked(entry.context)) {
      for (observer in entry.observers.toList()) runCatching { observer(null) }
      entry.observers.clear()
      return
    }
    val value = snapshot(entry)
    for (observer in entry.observers.toList()) runCatching { observer(value) }
  }

  private fun persist(entry: Entry, notify: Boolean = false, completion: ((Throwable?) -> Unit)? = null) {
    val saved = savedMessage(entry)
    persistence.execute {
      try {
        val accepted = synchronized(NotificationStore) {
          if (!sameAccount(entry)) false else { MorseNotifications.save(entry.context, saved); true }
        }
        if (accepted && notify) MorseNotifications.show(entry.context, saved)
        completion?.invoke(null)
      } catch (error: Exception) {
        onMain { active(entry.id)?.takeIf { it === entry }?.let {
          it.message.put("status", "Your draft is open, but could not be saved. Please try again.")
          publish(it)
        } }
        completion?.invoke(error)
      }
    }
  }

  private fun sameAccount(entry: Entry): Boolean = entry.epoch == NotificationStore.accountEpoch.get() &&
    NotificationStore.read(entry.context, "credentials")?.optString("userId") == entry.userId

  private fun syncMessage(entry: Entry) {
    entry.message.put("draft", entry.draft.morse.signal).put("lastTap", entry.draft.morse.lastTapMillis)
      .put("draftText", entry.draft.text).put("editorMode", entry.draft.mode)
      .put("sourceText", entry.draft.sourceText ?: JSONObject.NULL).put("sourceMorse", entry.draft.sourceMorse ?: JSONObject.NULL)
  }

  private fun savedMessage(entry: Entry): JSONObject {
    syncMessage(entry)
    return JSONObject(entry.message.toString())
  }

  private fun draftFrom(message: JSONObject) = NotificationReplyDraft(
    text = message.optString("draftText"),
    morse = MorseDraft(message.optString("draft"), message.optLong("lastTap", 0L)),
    mode = message.optString("editorMode").takeIf { it == "text" || it == "morse" }
      ?: if (message.optString("replyMode") == "morse") "morse" else "text",
    sourceText = if (message.isNull("sourceText")) null else message.optString("sourceText"),
    sourceMorse = if (message.isNull("sourceMorse")) null else message.optString("sourceMorse")
  )

  private fun snapshot(entry: Entry): Snapshot {
    val message = entry.message
    return Snapshot(message.getString("id"),
      message.optString("conversationName").ifBlank { "@" + message.optString("senderUsername", "friend") }.take(80),
      message.optString("text"), message.optString("morse").ifBlank { MorseCodec.encode(message.optString("text")) },
      entry.draft.text, entry.draft.morse.signal, entry.draft.mode, message.optString("status"),
      message.optBoolean("sending"), message.optBoolean("replySent"))
  }

  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
  }
}
