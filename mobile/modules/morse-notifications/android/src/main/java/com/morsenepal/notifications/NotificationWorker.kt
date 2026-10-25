package com.morsenepal.notifications

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

class NotificationWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
  override fun doWork(): Result {
    val expectedUser = inputData.getString("userId") ?: return Result.success()
    if (NotificationStore.read(applicationContext, "credentials")?.optString("userId") != expectedUser) return Result.success()
    val operation = inputData.getString("operation") ?: return Result.success()
    val id = inputData.getString("id") ?: return Result.success()
    try {
      when (operation) {
        "message" -> {
          if (!MorseNotifications.enabled(applicationContext)) return Result.success()
          MorseNotifications.currentMessage(applicationContext, id)?.let { cached ->
            // Duplicate FCM delivery must not erase a reply draft or re-alert the same message.
            MorseNotifications.show(applicationContext, cached)
            return Result.success()
          }
          val message = NotificationApi.message(applicationContext, id, expectedUser)
          if (message.optString("id") != id || message.optString("conversationId").isBlank()) return Result.failure()
          message.put("userId", expectedUser).put("savedAt", System.currentTimeMillis()).put("replyMode", "message")
          // The server gives original text; all notification signal generation stays letters/numbers only.
          message.put("text", message.optString("text").take(1000))
          if (message.optString("morse").isBlank()) message.put("morse", MorseCodec.encode(message.optString("text")))
          MorseNotifications.save(applicationContext, message)
          NotificationStore.pruneMessages(applicationContext)
          MorseNotifications.show(applicationContext, message, incoming = true)
          NativeNotificationEvents.emit("onMessageReceived", mapOf("messageId" to id, "conversationId" to message.optString("conversationId")))
        }
        "reply" -> {
          val pending = NotificationStore.read(applicationContext, "reply:$id") ?: return Result.success()
          if (pending.optString("userId") != expectedUser) return Result.success()
          NotificationApi.reply(applicationContext, pending.getJSONObject("body"), expectedUser)
          completeReply(id, "Reply sent", clearDraft = true)
        }
        "token" -> {
          val token = NotificationStore.read(applicationContext, "fcm")?.optString("token") ?: return Result.success()
          NotificationApi.updateToken(applicationContext, token, expectedUser)
        }
      }
      return Result.success()
    } catch (error: NotificationApiException) {
      if (error.status == 429 || error.status >= 500) return retryOrFinish(operation, id)
      if (operation == "reply") completeReply(id, when (error.status) {
        401 -> "Open the app to renew sign-in, then try again."
        403 -> "You cannot reply to this conversation."
        404 -> "This conversation is no longer available."
        else -> "Reply was not sent. Check your message and try again."
      })
      return Result.success()
    } catch (_: Exception) { return retryOrFinish(operation, id) }
  }

  private fun retryOrFinish(operation: String, id: String): Result {
    if (runAttemptCount >= 5) {
      if (operation == "reply") completeReply(id, "Reply was not sent. Try again when connected.")
      return Result.failure()
    }
    if (operation == "reply") {
      val pending = NotificationStore.read(applicationContext, "reply:$id")
      pending?.optString("messageId")?.let { messageId ->
        NotificationActionDispatcher.updateFromWorker(applicationContext, messageId, pending.optString("userId")) { message ->
          if (ownsReply(message, pending, id)) message.put("status", "Waiting for a connection...")
        }
      }
    }
    return Result.retry()
  }

  private fun completeReply(replyId: String, status: String, clearDraft: Boolean = false) {
    val pending = NotificationStore.read(applicationContext, "reply:$replyId") ?: return
    NotificationActionDispatcher.updateFromWorker(applicationContext, pending.optString("messageId"), pending.optString("userId")) { message ->
      // A delayed/retried completion must not overwrite a newer reply for the same notification.
      if (ownsReply(message, pending, replyId)) {
        message.put("sending", false).put("status", status)
        message.remove("pendingReplyId")
        if (clearDraft) message.put("draft", "").put("draftText", "").put("replyMode", "message").put("lastTap", 0L)
          .put("sourceText", org.json.JSONObject.NULL).put("sourceMorse", org.json.JSONObject.NULL).put("replySent", true)
      }
    }
    NotificationStore.remove(applicationContext, "reply:$replyId")
  }

  private fun ownsReply(message: org.json.JSONObject, pending: org.json.JSONObject, replyId: String): Boolean {
    val active = message.optString("pendingReplyId")
    return active == replyId || (active.isBlank() && message.optBoolean("sending") &&
      pending.optJSONObject("body")?.optString("clientId") == replyId)
  }

  companion object {
    const val TAG = "morse-notifications"
    fun enqueueMessage(context: Context, id: String, userId: String) { enqueue(context, "message", id, userId, true) }
    fun enqueueReply(context: Context, id: String, userId: String) = enqueue(context, "reply", id, userId, true)
    fun enqueueToken(context: Context, userId: String) { enqueue(context, "token", "refresh", userId, false) }
    private fun enqueue(context: Context, operation: String, id: String, userId: String, expedited: Boolean): androidx.work.Operation {
      val builder = OneTimeWorkRequestBuilder<NotificationWorker>()
        .setInputData(workDataOf("operation" to operation, "id" to id, "userId" to userId))
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS).addTag(TAG)
      if (expedited) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      return WorkManager.getInstance(context).enqueueUniqueWork("$TAG:$userId:$operation:$id", ExistingWorkPolicy.KEEP, builder.build())
    }
  }
}
