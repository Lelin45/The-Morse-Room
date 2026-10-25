package com.morsenepal.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.RemoteInput
import org.json.JSONObject

class NotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
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

/** Both inline text and the compact editor share one model; I/O cannot block individual marks. */
internal object NotificationActionDispatcher {
  private val main = Handler(Looper.getMainLooper())

  fun receive(context: Context, messageId: String, key: String, text: String?, arrivedAt: Long, epoch: Long, finish: () -> Unit) {
    val finished = java.util.concurrent.atomic.AtomicBoolean(false)
    val complete = { if (finished.compareAndSet(false, true)) runCatching { finish() }; Unit }
    main.post {
      runCatching { NotificationReplySession.action(context, messageId, key, text, arrivedAt, epoch, complete) }
        .onFailure { complete() }
    }
  }

  fun updateFromWorker(context: Context, messageId: String, userId: String, change: (JSONObject) -> Unit) =
    NotificationReplySession.updateFromWorker(context, messageId, userId, change)
}
