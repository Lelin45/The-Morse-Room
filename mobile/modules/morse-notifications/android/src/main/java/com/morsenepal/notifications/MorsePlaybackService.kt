package com.morsenepal.notifications

import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

class MorsePlaybackService : Service() {
  private val generation = AtomicLong(0)
  @Volatile private var track: AudioTrack? = null
  private val audioExecutor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "MorseNotificationAudio") }
  private val audioManager by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }
  private val focusListener = AudioManager.OnAudioFocusChangeListener { if (it < 0) stopSelf() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val messageId = intent?.getStringExtra("messageId") ?: return stop(startId)
    val message = MorseNotifications.currentMessage(this, messageId) ?: return stop(startId)
    if (!MorseNotifications.unlocked(this)) return stop(startId)
    MorseNotifications.ensureChannels(this)
    val notification = NotificationCompat.Builder(this, MorseNotifications.PLAYBACK_CHANNEL)
      .setSmallIcon(R.drawable.morse_notification_icon).setContentTitle("Morse Code Nepal")
      .setContentText("Playing Morse audio").setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .addAction(0, "Stop", MorseNotifications.pendingAction(this, messageId, "stop")).build()
    startForeground(9, notification)
    val tone = intent.getStringExtra("tone")
    val signal = if (tone == "." || tone == "-") tone else MorseCodec.encode(message.optString("text").take(1000))
    val current = generation.incrementAndGet()
    runCatching { track?.pause(); track?.flush() }
    audioExecutor.execute {
      if (generation.get() != current) return@execute
      try { play(signal, current) } finally { if (generation.get() == current) stopSelf(startId) }
    }
    return START_NOT_STICKY
  }

  private fun stop(id: Int): Int { stopSelf(id); return START_NOT_STICKY }

  @Suppress("DEPRECATION")
  private fun play(signal: String, current: Long) {
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
    var focusRequest: AudioFocusRequest? = null
    val focus = if (Build.VERSION.SDK_INT >= 26) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener(focusListener).build()
      focusRequest = request
      audioManager.requestAudioFocus(request)
    } else audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    if (focus != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return
    val sampleRate = 44_100
    val bufferSize = maxOf(AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), 8192)
    val output = AudioTrack.Builder().setAudioAttributes(attributes)
      .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
      .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(bufferSize).build()
    track = output
    try {
      output.play()
      // Wake the output route before the first dit, so Bluetooth or a sleeping mixer does not cut it off.
      val preRoll = ShortArray((sampleRate * 0.08).toInt())
      output.write(preRoll, 0, preRoll.size, AudioTrack.WRITE_BLOCKING)
      // Default chat pace: 18 WPM, 600 Hz. Streaming silence preserves exact Morse timing.
      for ((tone, units) in MorseCodec.segments(signal)) {
        if (generation.get() != current || Thread.currentThread().isInterrupted) break
        val count = (sampleRate * (1.2 / 18.0) * units).toInt()
        val samples = ShortArray(count)
        if (tone) {
          val ramp = min((sampleRate * 0.005).toInt(), count / 2)
          for (index in samples.indices) {
            val envelope = min(1.0, min(index.toDouble() / ramp, (count - 1 - index).toDouble() / ramp))
            samples[index] = (sin(2 * PI * 600 * index / sampleRate) * envelope * 20_000).toInt().toShort()
          }
        }
        var offset = 0
        while (offset < samples.size && generation.get() == current && !Thread.currentThread().isInterrupted) {
          val written = output.write(samples, offset, min(1024, samples.size - offset), AudioTrack.WRITE_BLOCKING)
          if (written <= 0) break
          offset += written
        }
      }
      // The last buffered dah must finish before the foreground service exits.
      val deadline = System.currentTimeMillis() + 500
      while (generation.get() == current && output.playbackHeadPosition.toLong() < writtenFrames(signal, sampleRate) + preRoll.size && System.currentTimeMillis() < deadline) Thread.sleep(10)
    } catch (_: Exception) { } finally {
      if (track === output) track = null
      runCatching { output.stop(); output.release() }
      if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
      else audioManager.abandonAudioFocus(focusListener)
    }
  }

  private fun writtenFrames(signal: String, sampleRate: Int): Long = MorseCodec.segments(signal)
    .sumOf { (_, units) -> (sampleRate * (1.2 / 18.0) * units).toLong() }

  override fun onDestroy() {
    generation.incrementAndGet()
    audioExecutor.shutdownNow()
    runCatching { track?.pause(); track?.flush() }
    super.onDestroy()
  }
}
