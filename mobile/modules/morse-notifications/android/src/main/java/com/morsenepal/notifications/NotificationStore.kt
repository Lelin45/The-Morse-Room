package com.morsenepal.notifications

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.AtomicFile
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Credentials, message previews and drafts never enter plain SharedPreferences or WorkManager data. */
internal object NotificationStore {
  private const val PREFS = "morse_notifications_encrypted"
  private const val KEY_ALIAS = "com.morsenepal.notifications.aes.v1"
  private val aad = "MorseCodeNepal.notifications.v1".toByteArray(Charsets.UTF_8)
  val accountEpoch = AtomicLong(0L)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256).setRandomizedEncryptionRequired(true).build())
    }.generateKey()
  }

  @Synchronized fun read(context: Context, name: String): JSONObject? {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val encoded = prefs.getString(name, null) ?: return null
    return try {
      val bytes = Base64.decode(encoded, Base64.NO_WRAP)
      require(bytes.size > 12)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
      cipher.updateAAD(aad + name.toByteArray(Charsets.UTF_8))
      JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    } catch (_: Exception) {
      // Restored backups cannot decrypt a hardware-bound key; fail closed.
      prefs.edit().remove(name).apply()
      null
    }
  }

  @Synchronized fun write(context: Context, name: String, value: JSONObject) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    cipher.updateAAD(aad + name.toByteArray(Charsets.UTF_8))
    val bytes = cipher.iv + cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
    check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putString(name, Base64.encodeToString(bytes, Base64.NO_WRAP)).commit()) { "Could not save notification settings." }
  }

  @Synchronized fun remove(context: Context, name: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(name).commit()
  }

  @Synchronized fun deviceId(context: Context): String {
    // Android backup must not duplicate an installation identifier onto a second phone.
    val file = AtomicFile(File(context.noBackupFilesDir, "morse_notification_installation"))
    runCatching { String(file.readFully(), Charsets.UTF_8) }.getOrNull()?.let { saved ->
      if (runCatching { UUID.fromString(saved) }.isSuccess) return saved
    }
    val id = UUID.randomUUID().toString()
    val output = file.startWrite()
    try { output.write(id.toByteArray(Charsets.UTF_8)); file.finishWrite(output) }
    catch (error: Exception) { file.failWrite(output); throw error }
    return id
  }

  @Synchronized fun forgetAccount(context: Context) {
    accountEpoch.incrementAndGet()
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val token = read(context, "fcm")
    val audio = read(context, "audio")
    prefs.edit().clear().commit()
    if (token != null) write(context, "fcm", token)
    if (audio != null) write(context, "audio", audio)
  }

  @Synchronized fun pruneMessages(context: Context) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val messages = prefs.all.keys.filter { it.startsWith("message:") }.mapNotNull { name ->
      read(context, name)?.let { name to it.optLong("savedAt", 0L) }
    }.sortedByDescending { it.second }
    for ((index, item) in messages.withIndex()) {
      if (index >= 20 || System.currentTimeMillis() - item.second > 7L * 24 * 60 * 60 * 1000) {
        remove(context, item.first)
        NotificationManagerCompat.from(context).cancel(MorseNotifications.id(item.first.removePrefix("message:")))
      }
    }
  }
}

internal object NativeNotificationEvents {
  @Volatile var sink: ((String, Map<String, Any?>) -> Unit)? = null
  fun emit(name: String, payload: Map<String, Any?>) { runCatching { sink?.invoke(name, payload) } }
}
