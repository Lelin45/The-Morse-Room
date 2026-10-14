package com.morsenepal.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.util.UUID

class NotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val key = intent.getStringExtra("key") ?: return
    if (key == "stop") {
      context.stopService(Intent(context, MorsePlaybackService::class.java))
      return
    }
    // Custom RemoteViews are also checked here, because their PendingIntents cannot declare authentication.
    if (!MorseNotifications.unlocked(context)) return
    val messageId = intent.getStringExtra("messageId") ?: return
    val message = MorseNotifications.currentMessage(context, messageId) ?: return
    if (message.optBoolean("sending") && key in listOf("text", "morse", "dit", "dah", "space", "backspace", "send")) return
    when (key) {
      "reveal" -> message.put("revealed", !message.optBoolean("revealed"))
      "reply" -> message.put("replyMode", "choose").put("status", "Choose text or Morse")
      "morse" -> message.put("replyMode", "morse").put("status", "")
      "back" -> message.put("replyMode", "message").put("status", "")
      "listen" -> {
        play(context, messageId)
        return
      }
      "text" -> {
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(MorseNotifications.REPLY_KEY)?.toString() ?: return
        if (text.isBlank() || text.length > 1000 || MorseCodec.encode(text).isBlank()) {
          message.put("status", "Include letters or numbers, up to 1,000 characters.")
        } else queueReply(context, message, JSONObject().put("kind", "text").put("text", text))
      }
      "dit", "dah" -> {
        val now = SystemClock.elapsedRealtime()
        var draft = message.optString("draft")
        val previous = message.optLong("lastTap", 0L)
        val separator = draft.isNotBlank() && !draft.endsWith('/') && previous > 0 && (now < previous || now - previous >= 650)
        if (draft.length + (if (separator) 2 else 1) > 6000) message.put("status", "Keep your Morse message to 6,000 symbols.")
        else {
          if (separator) draft += "/"
          draft += if (key == "dit") "." else "-"
          message.put("draft", draft).put("lastTap", now).put("status", "")
          play(context, messageId, if (key == "dit") "." else "-")
        }
      }
      "space" -> {
        val draft = message.optString("draft").trimEnd('/')
        if (draft.isNotBlank() && draft.length <= 5998) message.put("draft", "$draft//").put("status", "")
      }
      "backspace" -> {
        val draft = message.optString("draft")
        message.put("draft", if (draft.endsWith("//")) draft.dropLast(2) else draft.dropLast(1)).put("status", "")
        message.put("lastTap", SystemClock.elapsedRealtime())
      }
      "send" -> {
        try {
          MorseCodec.decodeDraft(message.optString("draft"))
          queueReply(context, message, JSONObject().put("kind", "morse").put("morse", message.optString("draft")))
        } catch (error: IllegalArgumentException) { message.put("status", error.message ?: "Check your Morse message.") }
      }
      else -> return
    }
    MorseNotifications.save(context, message)
    MorseNotifications.show(context, message)
  }

  private fun queueReply(context: Context, message: JSONObject, body: JSONObject) {
    val messageId = message.getString("id")
    if (message.optBoolean("sending")) return
    val clientId = UUID.randomUUID().toString()
    body.put("messageId", messageId).put("conversationId", message.getString("conversationId")).put("clientId", clientId)
    NotificationStore.write(context, "reply:$clientId", JSONObject().put("body", body)
      .put("userId", message.getString("userId")).put("messageId", messageId))
    NotificationWorker.enqueueReply(context, clientId, message.getString("userId"))
    message.put("status", "Sending reply...").put("sending", true)
  }

  private fun play(context: Context, id: String, tone: String? = null) {
    try {
      val intent = Intent(context, MorsePlaybackService::class.java).putExtra("messageId", id)
      if (tone != null) intent.putExtra("tone", tone)
      ContextCompat.startForegroundService(context, intent)
    } catch (_: Exception) {
      MorseNotifications.currentMessage(context, id)?.let {
        it.put("status", "Audio could not start. Try Listen again.")
        MorseNotifications.save(context, it)
        MorseNotifications.show(context, it)
      }
    }
  }
}
