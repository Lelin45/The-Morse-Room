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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/** A warm stream owns tone playback. New taps append; they never stop an earlier dit or dah. */
class MorsePlaybackService : Service() {
  @Volatile private var track: AudioTrack? = null
  private val audioExecutor = Executors.newSingleThreadExecutor { task -> Thread(task, "MorseNotificationAudio") }
  private val audioManager by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }
  private val focusListener = AudioManager.OnAudioFocusChangeListener { if (it < 0) stopSelf() }
  @Volatile private var workerStarted = false
  @Volatile private var latestStartId = 0
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() { super.onCreate(); synchronized(gate) { currentService = this; starting = false } }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    latestStartId = startId
    synchronized(gate) { currentService = this; starting = false }
    val messageId = intent?.getStringExtra("messageId") ?: return stop(startId)
    if (!MorseNotifications.unlocked(this) || MorseNotifications.currentMessage(this, messageId) == null) return stop(startId)
    if (!workerStarted) {
      MorseNotifications.ensureChannels(this)
      val notification = NotificationCompat.Builder(this, MorseNotifications.PLAYBACK_CHANNEL)
        .setSmallIcon(R.drawable.morse_notification_icon).setContentTitle("Morse Room: Learn & Chat")
        .setContentText(if (editorMode) "Morse reply audio" else "Playing Morse audio")
        .setOngoing(true).setOnlyAlertOnce(true).setSilent(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .addAction(0, "Stop", MorseNotifications.pendingAction(this, messageId, "stop")).build()
      startForeground(9, notification)
      workerStarted = true
      startAudioWorker()
    }
    return START_NOT_STICKY
  }

  private fun stop(id: Int): Int { stopSelf(id); return START_NOT_STICKY }

  private fun startAudioWorker() {
    audioExecutor.execute { finishWorker(runCatching { playLoop() }.getOrDefault(false)) }
  }

  private fun finishWorker(idleExit: Boolean) {
    synchronized(gate) {
      workerStarted = false
      if (idleExit && requests.isNotEmpty() && currentService === this && !audioExecutor.isShutdown) {
        // An input arrived exactly as the idle poll expired. Keep it, including its captured profile.
        workerStarted = true
        startAudioWorker()
        return
      }
      // Focus denial or a broken output route must not spin retrying a queued tone. The draft is independent.
      if (!idleExit && currentService === this) requests.clear()
      if (currentService === this) currentService = null
      val finishedStartId = latestStartId
      mainHandler.post { if (!workerStarted) stopSelfResult(finishedStartId) }
    }
  }

  @Suppress("DEPRECATION")
  private fun playLoop(): Boolean {
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
    var focusRequest: AudioFocusRequest? = null
    val focus = if (Build.VERSION.SDK_INT >= 26) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes)
        .setOnAudioFocusChangeListener(focusListener).build()
      focusRequest = request
      audioManager.requestAudioFocus(request)
    } else audioManager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    if (focus != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return false
    val sampleRate = 44_100
    val bufferSize = maxOf(AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), 4096)
    val output = try {
      AudioTrack.Builder().setAudioAttributes(attributes)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(bufferSize).build()
    } catch (error: Exception) {
      if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
      else audioManager.abandonAudioFocus(focusListener)
      throw error
    }
    track = output
    var writtenFrames = 0L
    var streamGeneration = generation.get()
    var priorToneAudibleEndMillis = 0.0
    var idleExit = false
    try {
      output.play()
      // Wake a sleeping output route once, before its first tone. Every later tap uses the same stream.
      writtenFrames += writeSamples(output, ShortArray((sampleRate * 0.08).toInt()), streamGeneration)
      while (!Thread.currentThread().isInterrupted) {
        val request = requests.poll(if (editorMode) 45_000L else 750L, TimeUnit.MILLISECONDS)
        if (request == null) { idleExit = true; break }
        if (!MorseNotifications.unlocked(this)) break
        if (request.generation != generation.get()) continue
        if (streamGeneration != request.generation) {
          output.pause(); output.flush(); output.play()
          streamGeneration = request.generation
          writtenFrames = output.playbackHeadPosition.toLong()
          priorToneAudibleEndMillis = 0.0
          writtenFrames += writeSamples(output, ShortArray((sampleRate * 0.04).toInt()), streamGeneration)
        }
        if (request.live) {
          // Boundaries come from the draft, not audio-queue delay. Backlogged letters and words keep their full gaps.
          val missingGap = request.settings.remainingGapSeconds(request.gapUnits,
            priorToneAudibleEndMillis, SystemClock.elapsedRealtime())
          if (missingGap > 0.0) writtenFrames += writeSamples(output,
            ShortArray((missingGap * sampleRate).toInt()), streamGeneration)
        }
        for ((tone, units) in MorseCodec.segments(request.signal)) {
          if (generation.get() != streamGeneration || Thread.currentThread().isInterrupted) break
          val count = (sampleRate * request.settings.durationSeconds(tone, units)).toInt()
          val samples = ShortArray(count)
          if (tone && request.settings.volume > 0.0) {
            val ramp = min((sampleRate * 0.004).toInt(), count / 2).coerceAtLeast(1)
            for (index in samples.indices) {
              val envelope = min(1.0, min(index.toDouble() / ramp, (count - 1 - index).toDouble() / ramp))
              samples[index] = (sin(2 * PI * request.settings.frequency * index / sampleRate) * envelope *
                20_000 * request.settings.volume / 100.0).toInt().toShort()
            }
          }
          writtenFrames += writeSamples(output, samples, streamGeneration)
        }
        priorToneAudibleEndMillis = if (request.live) SystemClock.elapsedRealtime() +
          (writtenFrames - output.playbackHeadPosition.toLong()).coerceAtLeast(0L) * 1000.0 / sampleRate else 0.0
      }
      // Let the last buffered dah finish. This never holds the input/model queue.
      val deadline = SystemClock.elapsedRealtime() + 1_000L
      while (generation.get() == streamGeneration && output.playbackHeadPosition.toLong() < writtenFrames &&
        SystemClock.elapsedRealtime() < deadline) Thread.sleep(5L)
    } catch (_: Exception) { idleExit = false } finally {
      if (track === output) track = null
      runCatching { output.stop(); output.release() }
      if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
      else audioManager.abandonAudioFocus(focusListener)
    }
    return idleExit
  }

  private fun writeSamples(output: AudioTrack, samples: ShortArray, expectedGeneration: Long): Long {
    var offset = 0
    while (offset < samples.size && generation.get() == expectedGeneration && !Thread.currentThread().isInterrupted) {
      val count = output.write(samples, offset, min(512, samples.size - offset), AudioTrack.WRITE_BLOCKING)
      if (count <= 0) break
      offset += count
    }
    return offset.toLong()
  }

  override fun onDestroy() {
    synchronized(gate) {
      if (currentService === this) {
        currentService = null
        starting = false
        generation.incrementAndGet()
        requests.clear()
        editorMode = false
      }
    }
    audioExecutor.shutdownNow()
    runCatching { track?.pause(); track?.flush() }
    super.onDestroy()
  }

  companion object {
    private data class Request(val signal: String, val settings: MorseAudioSettings, val live: Boolean,
      val generation: Long, val gapUnits: Int)
    private val gate = Any()
    private val requests = LinkedBlockingQueue<Request>()
    private val generation = AtomicLong(0L)
    @Volatile private var currentService: MorsePlaybackService? = null
    @Volatile private var starting = false
    @Volatile private var editorMode = false

    internal fun prepareEditor(context: Context, messageId: String) {
      synchronized(gate) { replacePlayback(); editorMode = true }
      ensureStarted(context, messageId)
    }

    internal fun tone(context: Context, messageId: String, signal: String, settings: MorseAudioSettings, gapUnits: Int) {
      synchronized(gate) {
        if (!editorMode) replacePlayback()
        editorMode = true
        requests.offer(Request(signal, settings, true, generation.get(), gapUnits))
      }
      ensureStarted(context, messageId)
    }

    internal fun listen(context: Context, messageId: String, signal: String, settings: MorseAudioSettings) {
      synchronized(gate) {
        replacePlayback()
        editorMode = false
        requests.offer(Request(signal, settings, false, generation.get(), 0))
      }
      ensureStarted(context, messageId)
    }

    private fun replacePlayback() {
      generation.incrementAndGet()
      requests.clear()
      runCatching { currentService?.track?.pause(); currentService?.track?.flush() }
    }

    private fun ensureStarted(context: Context, messageId: String) {
      synchronized(gate) {
        if (currentService != null || starting) return
        starting = true
        try { ContextCompat.startForegroundService(context,
          Intent(context, MorsePlaybackService::class.java).putExtra("messageId", messageId)) }
        catch (error: Exception) { starting = false; requests.clear(); throw error }
      }
    }
  }
}
