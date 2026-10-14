package com.morsenepal.notifications

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

class MorseMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val id = message.data["messageId"]?.takeIf { it.length in 1..128 } ?: return
    val userId = NotificationStore.read(this, "credentials")?.optString("userId")?.takeIf { it.isNotBlank() } ?: return
    // Push contains routing IDs only. The revocable device capability retrieves authorized message content.
    NotificationWorker.enqueueMessage(this, id, userId)
  }

  override fun onNewToken(token: String) {
    if (runCatching { NotificationStore.write(this, "fcm", JSONObject().put("token", token)) }.isFailure) return
    val registered = NotificationStore.read(this, "credentials")?.optString("deviceId")
    NativeNotificationEvents.emit("onTokenChanged", mapOf("token" to token, "deviceId" to (registered ?: NotificationStore.deviceId(this))))
    NotificationStore.read(this, "credentials")?.optString("userId")?.takeIf { it.isNotBlank() }?.let {
      NotificationWorker.enqueueToken(this, it)
    }
  }
}
