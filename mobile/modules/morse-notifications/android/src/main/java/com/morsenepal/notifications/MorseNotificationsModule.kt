package com.morsenepal.notifications

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.work.WorkManager
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.util.UUID

class MorseNotificationsModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "Android app context is unavailable." }

  override fun definition() = ModuleDefinition {
    Name("MorseNotifications")
    Events("onTokenChanged", "onNotificationOpen", "onStateChange", "onMessageReceived")

    OnCreate {
      NativeNotificationEvents.sink = { name, payload -> sendEvent(name, payload) }
      MorseNotifications.ensureChannels(context)
      NotificationStore.pruneMessages(context)
    }
    OnDestroy { NativeNotificationEvents.sink = null }
    OnNewIntent { intent -> saveRoute(intent) }
    OnActivityEntersForeground {
      appContext.currentActivity?.intent?.let { saveRoute(it) }
      sendEvent("onStateChange", state())
    }

    AsyncFunction("getStateAsync") { state() }

    AsyncFunction("getFCMTokenAsync") { promise: Promise ->
      if (!firebaseConfigured() || !MorseNotifications.enabled(context)) promise.resolve(null)
      else try {
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
          try {
            NotificationStore.write(context, "fcm", JSONObject().put("token", token))
            promise.resolve(token)
          } catch (error: Exception) { promise.reject("E_NOTIFICATION_STORAGE", "Notification settings could not be saved.", error) }
        }.addOnFailureListener { promise.resolve(null) }
      } catch (_: Exception) { promise.resolve(null) }
    }

    AsyncFunction("configureAsync") { options: Map<String, String> ->
      val (deviceId, userId, token) = NotificationRegistration.fromOptions(options)
      val previous = NotificationStore.read(context, "credentials")?.optString("userId")
      if (previous != null && previous != userId) {
        WorkManager.getInstance(context).cancelAllWorkByTag(NotificationWorker.TAG)
        MorseNotifications.cancelAll(context)
        NotificationStore.forgetAccount(context)
      }
      NotificationStore.write(context, "credentials", JSONObject().put("userId", userId).put("deviceId", deviceId).put("authToken", token))
      if (firebaseConfigured() && MorseNotifications.enabled(context)) FirebaseMessaging.getInstance().isAutoInitEnabled = true
      state()
    }

    AsyncFunction("clearAsync") {
      if (firebaseConfigured()) FirebaseMessaging.getInstance().isAutoInitEnabled = false
      WorkManager.getInstance(context).cancelAllWorkByTag(NotificationWorker.TAG)
      MorseNotifications.cancelAll(context)
      NotificationStore.forgetAccount(context)
      state()
    }

    AsyncFunction("consumeRouteAsync") {
      appContext.currentActivity?.intent?.let { saveRoute(it) }
      val route = NotificationStore.read(context, "route")
      NotificationStore.remove(context, "route")
      val userId = NotificationStore.read(context, "credentials")?.optString("userId")
      if (route != null && route.optString("userId") == userId && System.currentTimeMillis() - route.optLong("at") < 10 * 60 * 1000) {
        mapOf("conversationId" to route.optString("conversationId"), "messageId" to route.optString("messageId"))
      } else null
    }

    AsyncFunction("openSettingsAsync") {
      val intent = if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    AsyncFunction("fetchMessageNotificationAsync") { messageId: String ->
      require(messageId.length in 1..128) { "Message identifier is invalid." }
      val user = NotificationStore.read(context, "credentials")?.optString("userId") ?: error("Configure notifications first.")
      NotificationWorker.enqueueMessage(context, messageId, user)
    }

    // This native test hook cannot post messages in production builds.
    AsyncFunction("showDebugNotificationAsync") { options: Map<String, String> ->
      check(BuildConfig.DEBUG) { "Notification testing is available in development builds only." }
      val user = NotificationStore.read(context, "credentials")?.optString("userId") ?: error("Configure notifications first.")
      val text = options["text"].orEmpty().take(1000)
      require(MorseCodec.encode(text).isNotBlank()) { "Include a letter or number." }
      val message = JSONObject().put("id", "debug-" + UUID.randomUUID()).put("conversationId", options["conversationId"].orEmpty())
        .put("senderUsername", options["senderUsername"] ?: "practice").put("text", text).put("morse", MorseCodec.encode(text))
        .put("userId", user).put("savedAt", System.currentTimeMillis())
      MorseNotifications.save(context, message)
      MorseNotifications.show(context, message, incoming = true)
    }
  }

  private fun firebaseConfigured(): Boolean = try {
    FirebaseApp.getApps(context).isNotEmpty() || FirebaseApp.initializeApp(context) != null
  } catch (_: Exception) { false }

  private fun state(): Map<String, Any?> = mapOf(
    "supported" to true,
    "enabled" to MorseNotifications.enabled(context),
    "fcmConfigured" to firebaseConfigured(),
    "token" to NotificationStore.read(context, "fcm")?.optString("token"),
    "deviceId" to NotificationStore.deviceId(context),
    "accountConfigured" to (NotificationStore.read(context, "credentials") != null),
    "registeredDeviceId" to NotificationStore.read(context, "credentials")?.optString("deviceId"),
    "configuredUserId" to NotificationStore.read(context, "credentials")?.optString("userId")
  )

  private fun saveRoute(intent: Intent) {
    val conversationId = intent.getStringExtra(MorseNotifications.ROUTE_KEY) ?: return
    val userId = intent.getStringExtra("morse_notification_user") ?: return
    intent.removeExtra(MorseNotifications.ROUTE_KEY)
    if (NotificationStore.read(context, "credentials")?.optString("userId") != userId) return
    val messageId = intent.getStringExtra("morse_notification_message").orEmpty()
    NotificationStore.write(context, "route", JSONObject().put("conversationId", conversationId).put("messageId", messageId)
      .put("userId", userId).put("at", System.currentTimeMillis()))
    sendEvent("onNotificationOpen", mapOf("conversationId" to conversationId, "messageId" to messageId))
  }
}
