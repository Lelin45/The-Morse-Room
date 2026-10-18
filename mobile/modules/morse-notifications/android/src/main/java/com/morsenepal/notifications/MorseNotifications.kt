package com.morsenepal.notifications

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import org.json.JSONObject

internal object MorseNotifications {
  const val CHANNEL = "morse_messages_v1"
  const val PLAYBACK_CHANNEL = "morse_playback_v1"
  const val REPLY_KEY = "morse_notification_reply"
  const val ROUTE_KEY = "morse_notification_conversation"

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(CHANNEL, "Morse messages", NotificationManager.IMPORTANCE_DEFAULT).apply {
      description = "Messages from your Morse chat friends and groups"
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    })
    manager.createNotificationChannel(NotificationChannel(PLAYBACK_CHANNEL, "Morse playback", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Audio you choose to play from a message notification"
      setSound(null, null)
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
    })
  }

  fun enabled(context: Context): Boolean {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
    if (Build.VERSION.SDK_INT >= 26 && context.getSystemService(NotificationManager::class.java)
      .getNotificationChannel(CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE) return false
    return true
  }

  fun unlocked(context: Context): Boolean = !(context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked
  fun id(messageId: String): Int = ("morse-message:$messageId".hashCode() and 0x3fffffff) + 100

  fun currentMessage(context: Context, messageId: String): JSONObject? {
    val credentials = NotificationStore.read(context, "credentials") ?: return null
    val message = NotificationStore.read(context, "message:$messageId") ?: return null
    if (System.currentTimeMillis() - message.optLong("savedAt", 0L) > 7L * 24 * 60 * 60 * 1000) {
      NotificationStore.remove(context, "message:$messageId")
      NotificationManagerCompat.from(context).cancel(id(messageId))
      return null
    }
    return message.takeIf {
      it.optString("userId") == credentials.optString("userId") && it.optString("id") == messageId
    }
  }

  fun save(context: Context, message: JSONObject) {
    NotificationStore.write(context, "message:" + message.getString("id"), message)
  }

  fun show(context: Context, message: JSONObject, incoming: Boolean = false) {
    if (!enabled(context)) return
    val userId = NotificationStore.read(context, "credentials")?.optString("userId") ?: return
    if (message.optString("userId") != userId) return
    ensureChannels(context)
    val messageId = message.getString("id")
    val revealed = message.optBoolean("revealed", false)
    val mode = message.optString("replyMode", "message")
    val text = message.optString("text").take(1000)
    val signal = message.optString("morse").ifBlank { MorseCodec.encode(text) }
    val body = if (revealed) text else signal
    val title = message.optString("conversationName").ifBlank { "@" + message.optString("senderUsername", "friend") }.take(80)
    val status = message.optString("status")
    val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
      flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
      putExtra(ROUTE_KEY, message.optString("conversationId"))
      putExtra("morse_notification_message", messageId)
      putExtra("morse_notification_user", userId)
    }
    val public = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.morse_notification_icon)
      .setContentTitle("Morse Room: Learn & Chat").setContentText("New Morse message").build()
    val builder = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.morse_notification_icon).setContentTitle(title).setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setColor(Color.rgb(52, 245, 140)).setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(public)
      .setOnlyAlertOnce(true).setSilent(!incoming).setAutoCancel(true)
      .setWhen(message.optLong("savedAt", System.currentTimeMillis()))
      .setAllowSystemGeneratedContextualActions(false)
    if (status.isNotBlank()) builder.setSubText(status.take(100))
    if (open != null) builder.setContentIntent(PendingIntent.getActivity(context, id(messageId), open,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    when (mode) {
      "choose" -> {
        builder.addAction(action(context, messageId, "text", "Text reply", remoteInput = true))
        builder.addAction(action(context, messageId, "morse", "Morse reply"))
        builder.addAction(action(context, messageId, "back", "Back"))
      }
      "morse" -> {
        val editor = RemoteViews(context.packageName, R.layout.morse_notification_editor)
        editor.setTextViewText(R.id.morse_reply_title, "Reply to $title")
        val draft = message.optString("draft")
        editor.setTextViewText(R.id.morse_reply_draft, if (draft.isBlank()) "Tap dit or dah" else (if (draft.length > 80) "…" else "") + draft.takeLast(80))
        editor.setTextViewText(R.id.morse_reply_status, status.ifBlank { "A short pause separates letters. Space separates words." })
        for ((view, key) in listOf(R.id.morse_reply_dit to "dit", R.id.morse_reply_dah to "dah",
          R.id.morse_reply_space to "space", R.id.morse_reply_backspace to "backspace", R.id.morse_reply_send to "send")) {
          editor.setOnClickPendingIntent(view, pendingAction(context, messageId, key))
          editor.setBoolean(view, "setEnabled", !message.optBoolean("sending"))
        }
        builder.setStyle(NotificationCompat.DecoratedCustomViewStyle()).setCustomBigContentView(editor)
        builder.addAction(action(context, messageId, "text", "Text reply", remoteInput = true))
        builder.addAction(action(context, messageId, "back", "Back"))
      }
      else -> {
        builder.addAction(action(context, messageId, "reveal", if (revealed) "Hide text" else "Show text"))
        builder.addAction(action(context, messageId, "listen", "Listen"))
        builder.addAction(action(context, messageId, "reply", "Reply"))
      }
    }
    try { NotificationManagerCompat.from(context).notify(id(messageId), builder.build()) } catch (_: SecurityException) { }
  }

  fun pendingAction(context: Context, messageId: String, key: String, mutable: Boolean = false): PendingIntent {
    val intent = Intent(context, NotificationActionReceiver::class.java)
      .setAction("com.morsenepal.notifications.$key")
      .addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
      .setData(Uri.parse("morse-notification://action/" + Uri.encode(messageId) + "/" + key))
      .putExtra("messageId", messageId).putExtra("key", key)
    val flag = if (mutable) (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0) else PendingIntent.FLAG_IMMUTABLE
    return PendingIntent.getBroadcast(context, (messageId + ":" + key).hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or flag)
  }

  private fun action(context: Context, messageId: String, key: String, title: String, remoteInput: Boolean = false): NotificationCompat.Action {
    val builder = NotificationCompat.Action.Builder(0, title, pendingAction(context, messageId, key, remoteInput))
      .setShowsUserInterface(false)
    if (remoteInput) builder.addRemoteInput(RemoteInput.Builder(REPLY_KEY).setLabel("Reply in text").build())
      .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY).setAllowGeneratedReplies(false)
    // System UI closes the notification shade for authentication-required actions,
    // even when the phone is already unlocked. These are background broadcasts:
    // the receiver checks isDeviceLocked, and Android authenticates RemoteInput.
    // The private publicVersion contains no message or reply controls on the lock screen.
    if (Build.VERSION.SDK_INT >= 31) builder.setAuthenticationRequired(false)
    return builder.build()
  }

  fun cancelAll(context: Context) {
    NotificationManagerCompat.from(context).cancelAll()
    context.stopService(Intent(context, MorsePlaybackService::class.java))
  }
}
