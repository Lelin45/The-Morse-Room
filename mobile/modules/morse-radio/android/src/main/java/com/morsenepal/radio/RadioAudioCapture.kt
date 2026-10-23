package com.morsenepal.radio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AudioEffect
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.util.concurrent.atomic.AtomicLong

/** Raw PCM is used only in memory. Nothing is recorded to a file or sent to a server. */
internal class RadioAudioCapture(
  private val context: Context,
  private val emit: (Map<String, Any?>) -> Unit,
) {
  private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val epoch = AtomicLong()
  private val effects = mutableListOf<AudioEffect>()
  @Volatile private var record: AudioRecord? = null
  @Volatile private var routedId: Int? = null
  @Volatile private var requestedId: Int? = null
  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
      if (removedDevices.any { it.id == routedId || it.id == requestedId }) stop("Audio input disconnected.")
    }
  }

  init { manager.registerAudioDeviceCallback(devices, Handler(Looper.getMainLooper())) }

  fun inputs(): List<Map<String, Any?>> = manager.getDevices(AudioManager.GET_DEVICES_INPUTS).map { describe(it) }

  @Synchronized
  fun start(deviceId: Int?): Map<String, Any?> {
    check(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      "Allow microphone access to receive radio audio."
    }
    stop(null)
    val preferred = if (deviceId != null) manager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.id == deviceId }
      ?: error("The selected audio input is no longer connected.") else null
    val source = if (Build.VERSION.SDK_INT >= 24 && manager.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true") {
      MediaRecorder.AudioSource.UNPROCESSED
    } else MediaRecorder.AudioSource.VOICE_RECOGNITION
    var captured: AudioRecord? = null
    var sampleRate = 16000
    for (rate in listOf(16000, 8000)) {
      val minBytes = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      if (minBytes <= 0) continue
      val candidate = try {
        AudioRecord.Builder().setAudioSource(source)
          .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
          .setBufferSizeInBytes(maxOf(minBytes * 2, rate / 5)).build()
      } catch (_: Exception) { null }
      if (candidate?.state == AudioRecord.STATE_INITIALIZED) {
        captured = candidate
        sampleRate = rate
        break
      }
      candidate?.release()
    }
    val active = captured ?: error("This phone could not open a mono audio input.")
    try {
      if (preferred != null && !active.setPreferredDevice(preferred)) error("Android could not select that audio input.")
      disableProcessing(active.audioSessionId)
      active.startRecording()
      check(active.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Android could not start receiving audio." }
      record = active
      requestedId = preferred?.id
      val generation = epoch.incrementAndGet()
      Thread({ read(active, sampleRate, preferred, generation) }, "MorseRadioAudio").apply { isDaemon = true; start() }
      return mapOf("state" to "starting", "sampleRate" to sampleRate, "requestedDeviceId" to preferred?.id)
    } catch (error: Exception) {
      try { active.stop() } catch (_: Exception) { }
      active.release()
      releaseEffects()
      throw error
    }
  }

  private fun read(active: AudioRecord, rate: Int, preferred: AudioDeviceInfo?, generation: Long) {
    // 40 ms PCM frames keep dit edges intact without excessive React Native events.
    val buffer = ShortArray(rate / 25)
    var previousRoute = -1
    var routeAttempts = 0
    try {
      while (epoch.get() == generation && record === active) {
        val count = active.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
        if (epoch.get() != generation || record !== active) break
        if (count < 0) error("Audio input stopped (${count}).")
        if (count == 0) continue
        val actual = active.routedDevice
        // Never claim a USB cable is receiving when Android silently uses its microphone.
        if (actual == null || preferred != null && actual.id != preferred.id) {
          routeAttempts += 1
          if (routeAttempts > 15) error("Android selected a different audio input. Reconnect the adapter or choose Microphone.")
          continue
        }
        if (actual != null && actual.id != previousRoute) {
          previousRoute = actual.id
          routedId = actual.id
          emit(mapOf("kind" to "status", "state" to "receiving", "sampleRate" to rate,
            "device" to describe(actual), "deviceId" to actual.id, "deviceName" to actual.productName.toString()))
        }
        emit(mapOf("kind" to "audio", "sampleRate" to rate,
          "samples" to List(count) { index -> buffer[index].toDouble() / 32768.0 }))
      }
    } catch (error: Exception) {
      if (epoch.get() == generation) {
        stop(null)
        emit(mapOf("kind" to "status", "state" to "error", "message" to (error.message ?: "Audio input stopped.")))
      }
    }
  }

  private fun disableProcessing(sessionId: Int) {
    listOf<() -> AudioEffect?>(
      { if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(sessionId) else null },
      { if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(sessionId) else null },
      { if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(sessionId) else null },
    ).forEach { create ->
      try { create()?.let { effect -> effect.enabled = false; effects.add(effect) } } catch (_: Exception) { }
    }
  }

  @Synchronized
  fun stop(reason: String?) {
    epoch.incrementAndGet()
    val previous = record
    record = null
    routedId = null
    requestedId = null
    try { previous?.stop() } catch (_: Exception) { }
    try { previous?.release() } catch (_: Exception) { }
    releaseEffects()
    if (previous != null || reason != null) emit(mapOf("kind" to "status", "state" to "stopped", "message" to reason))
  }

  private fun releaseEffects() {
    effects.forEach { try { it.release() } catch (_: Exception) { } }
    effects.clear()
  }

  fun destroy() {
    stop(null)
    manager.unregisterAudioDeviceCallback(devices)
  }

  private fun describe(device: AudioDeviceInfo): Map<String, Any?> = mapOf(
    "id" to device.id, "name" to device.productName.toString(), "type" to device.type,
    "external" to (device.type != AudioDeviceInfo.TYPE_BUILTIN_MIC),
    "kind" to when (device.type) {
      AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
      AudioDeviceInfo.TYPE_WIRED_HEADSET -> "wired"
      AudioDeviceInfo.TYPE_BUILTIN_MIC -> "microphone"
      else -> "other"
    },
  )
}
