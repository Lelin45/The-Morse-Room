package com.morsenepal.notifications

import android.content.Context
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.URL
import java.net.URLEncoder
import javax.net.ssl.HttpsURLConnection

internal class NotificationApiException(val status: Int) : Exception("Notification request failed ($status)")

internal object NotificationApi {
  private const val ORIGIN = "https://learnmorse.lelinadhikari.com.np"

  fun message(context: Context, id: String, expectedUserId: String): JSONObject {
    val result = request(context, "/api/notifications/message?id=" + URLEncoder.encode(id, "UTF-8"), expectedUserId)
    return result.optJSONObject("message") ?: result
  }

  fun reply(context: Context, body: JSONObject, expectedUserId: String): JSONObject =
    request(context, "/api/notifications/reply", expectedUserId, body)

  fun updateToken(context: Context, token: String, expectedUserId: String): JSONObject {
    val credentials = NotificationStore.read(context, "credentials") ?: throw NotificationApiException(401)
    val registeredDeviceId = credentials.optString("deviceId")
    if (registeredDeviceId.isBlank()) throw NotificationApiException(401)
    return request(context, "/api/notifications/device-token", expectedUserId,
      JSONObject().put("deviceId", registeredDeviceId).put("fcmToken", token))
  }

  private fun request(context: Context, path: String, expectedUserId: String, body: JSONObject? = null): JSONObject {
    val credentials = NotificationStore.read(context, "credentials") ?: throw NotificationApiException(401)
    if (credentials.optString("userId") != expectedUserId) throw NotificationApiException(401)
    val token = credentials.optString("authToken")
    if (token.isBlank()) throw NotificationApiException(401)
    val connection = URL(ORIGIN + path).openConnection() as HttpsURLConnection
    try {
      connection.instanceFollowRedirects = false // Never forward the device token to another host.
      connection.connectTimeout = 10_000
      connection.readTimeout = 15_000
      connection.setRequestProperty("Authorization", "Bearer $token")
      connection.setRequestProperty("Accept", "application/json")
      if (body != null) {
        connection.requestMethod = "POST"
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
      }
      val status = connection.responseCode
      if (status !in 200..299) throw NotificationApiException(status)
      val bytes = connection.inputStream.use { input ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          require(output.size() + count <= 256_000) { "Notification response is too large." }
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      }
      if (NotificationStore.read(context, "credentials")?.optString("userId") != expectedUserId) throw NotificationApiException(401)
      return if (bytes.isEmpty()) JSONObject() else JSONObject(String(bytes, Charsets.UTF_8))
    } finally { connection.disconnect() }
  }
}
