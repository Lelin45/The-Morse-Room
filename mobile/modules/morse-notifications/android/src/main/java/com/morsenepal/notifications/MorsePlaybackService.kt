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
import android.os.Process
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/** Live key feedback replaces stale feedback; Listen still plays every Morse segment at the chosen speed. */
class MorsePlaybackService : Service() {
  @Volatile private var track: AudioTrack? = null
  private val audioExecutor = Executors.newSingleThreadExecutor { task -> Thread(task, "MorseNotificationAudio") }
  private val audioManager by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }
  private val focusListener = AudioManager.OnAudioFocusChangeListener { if (it < 0) stopSelf() }
  @Volatile private var workerStarted = false
  @Volatile private var latestStartId = 0
  private val mainHandler = Handler(Looper.getMainLooper())
  private var nextLockCheckMillis = 0L
  private var cachedUnlocked = true

  override fun onBind(intent: Intent?): IBinder? = null
  override fun onCreate() { super.onCreate(); synchronized(gate) { currentService = this; starting = false } }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    latestStartId = startId
    synchronized(gate) { currentService = this; starting = false }
    val messageId = intent?.getStringExtra("messageId") ?: return stop(startId)
    val epoch = NotificationStore.accountEpoch.get()
    if (!MorseNotifications.unlocked(this) || MorseNotifications.currentMessage(this, messageId) == null ||
      epoch != NotificationStore.accountEpoch.get() || authorizedEpoch != epoch || authorizedMessageId != messageId) return stop(startId)
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
    audioExecutor.execute {
      runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO) }
      finishWorker(runCatching { playLoop() }.getOrDefault(false))
    }
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
    // The native output rate lets supported devices use Android's low latency mixer path.
    val sampleRate = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toIntOrNull()
      ?.takeIf { it in 8_000..192_000 } ?: 48_000
    val burstFrames = audioManager.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toIntOrNull()
      ?.takeIf { it in 16..4096 } ?: 256
    val bufferSize = maxOf(AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), burstFrames * 8, 2048)
    val output = try {
      val builder = AudioTrack.Builder().setAudioAttributes(attributes)
        .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
        .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(bufferSize)
      if (Build.VERSION.SDK_INT >= 26) builder.setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
      builder.build().also { it.setBufferSizeInFrames(maxOf(burstFrames * 2, sampleRate / 100)) }
    } catch (error: Exception) {
      if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
      else audioManager.abandonAudioFocus(focusListener)
      throw error
    }
    track = output
    var writtenFrames = 0L
    var streamGeneration = generation.get()
    var lastRequestMillis = SystemClock.elapsedRealtime()
    var idleExit = false
    val silence = ShortArray(128)
    try {
      output.play()
      // Wake a sleeping output route once, before its first tone. Every later tap uses the same stream.
      writtenFrames += writeSamples(output, ShortArray((sampleRate * 0.08).toInt()), streamGeneration)
      while (!Thread.currentThread().isInterrupted) {
        if (!stillAuthorized()) break
        val nextGeneration = generation.get()
        if (streamGeneration != nextGeneration) {
          output.pause(); output.flush(); output.play()
          streamGeneration = nextGeneration
          // flush() resets the playback head. Do not prepend silence before each key press.
          writtenFrames = 0L
        }
        val request = requests.poll()
        if (request == null) {
          val now = SystemClock.elapsedRealtime()
          if (editorMode) {
            if (now - lastInputMillis >= 45_000L) { idleExit = true; break }
            // Keep the route awake between taps, rather than underrunning and reopening it on each mark.
            writtenFrames += writeSamples(output, silence, streamGeneration)
          } else {
            if (now - lastRequestMillis >= 750L) { idleExit = true; break }
            Thread.sleep(4L)
          }
          continue
        }
        if (request.generation != generation.get() || request.epoch != NotificationStore.accountEpoch.get()) continue
        if (streamGeneration != request.generation) {
          // A newer tap can arrive between the generation check and poll(). Keep that latest tone.
          output.pause(); output.flush(); output.play()
          streamGeneration = request.generation
          writtenFrames = 0L
        }
        lastRequestMillis = SystemClock.elapsedRealtime()
        // Captured tap times decide the draft's letter boundaries. Feedback must never wait behind
        // synthetic inter-mark, letter or word gaps, or an older long dah.
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
      }
      // Let the last buffered dah finish. This never holds the input/model queue.
      val deadline = SystemClock.elapsedRealtime() + 1_000L
      while (generation.get() == streamGeneration && stillAuthorized() && output.playbackHeadPosition.toLong() < writtenFrames &&
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
    while (offset < samples.size && generation.get() == expectedGeneration && !Thread.currentThread().isInterrupted && stillAuthorized()) {
      val count = output.write(samples, offset, min(128, samples.size - offset), AudioTrack.WRITE_NON_BLOCKING)
      check(count >= 0) { "Audio output is unavailable." }
      if (count == 0) { Thread.sleep(1L); continue }
      offset += count
    }
    return offset.toLong()
  }

  private fun stillAuthorized(): Boolean {
    if (authorizedMessageId == null || authorizedEpoch != NotificationStore.accountEpoch.get()) return false
    val now = SystemClock.elapsedRealtime()
    if (now >= nextLockCheckMillis) {
      cachedUnlocked = MorseNotifications.unlocked(this)
      nextLockCheckMillis = now + 100L
    }
    return cachedUnlocked
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
    private data class Request(val signal: String, val settings: MorseAudioSettings,
      val generation: Long, val epoch: Long)
    private val gate = Any()
    // Input is stored by the composer. Only its latest feedback belongs in the audio queue.
    private val requests = LinkedBlockingQueue<Request>(1)
    private val generation = AtomicLong(0L)
    @Volatile private var currentService: MorsePlaybackService? = null
    @Volatile private var starting = false
    @Volatile private var editorMode = false
    @Volatile private var authorizedMessageId: String? = null
    @Volatile private var authorizedEpoch = -1L
    @Volatile private var lastInputMillis = 0L

    internal fun prepareEditor(context: Context, messageId: String) {
      val epoch = authorize(context, messageId) ?: return
      synchronized(gate) {
        authorizedMessageId = messageId
        authorizedEpoch = epoch
        replacePlayback()
        editorMode = true
        lastInputMillis = SystemClock.elapsedRealtime()
      }
      ensureStarted(context, messageId)
    }

    @Suppress("UNUSED_PARAMETER")
    internal fun tone(context: Context, messageId: String, signal: String, settings: MorseAudioSettings, gapUnits: Int) {
      synchronized(gate) {
        // prepareEditor authenticates once. A touch never decrypts credentials, accesses disk or waits
        // for the previous tone. Lock state is monitored by the warm audio worker.
        if ((signal != "." && signal != "-") || authorizedMessageId != messageId ||
          authorizedEpoch != NotificationStore.accountEpoch.get()) return
        replacePlayback()
        editorMode = true
        lastInputMillis = SystemClock.elapsedRealtime()
        requests.offer(Request(signal, settings, generation.get(), authorizedEpoch))
      }
      ensureStarted(context, messageId)
    }

    internal fun listen(context: Context, messageId: String, signal: String, settings: MorseAudioSettings) {
      val epoch = authorize(context, messageId) ?: return
      synchronized(gate) {
        authorizedMessageId = messageId
        authorizedEpoch = epoch
        replacePlayback()
        editorMode = false
        requests.offer(Request(signal, settings, generation.get(), epoch))
      }
      ensureStarted(context, messageId)
    }

    private fun replacePlayback() {
      generation.incrementAndGet()
      requests.clear()
      // The audio worker owns pause/flush/write, avoiding cross-thread AudioTrack lock contention.
    }

    private fun authorize(context: Context, messageId: String): Long? {
      val epoch = NotificationStore.accountEpoch.get()
      if (!MorseNotifications.unlocked(context) || MorseNotifications.currentMessage(context, messageId) == null ||
        epoch != NotificationStore.accountEpoch.get()) return null
      return epoch
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
