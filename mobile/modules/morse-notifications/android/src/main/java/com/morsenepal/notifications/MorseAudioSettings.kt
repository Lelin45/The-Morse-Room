package com.morsenepal.notifications

import android.content.Context
import org.json.JSONObject

/** Effective global audio profile. It is installation data, independent of chat sign-in. */
internal data class MorseAudioSettings(
  val wpm: Double = 18.0,
  val farnsworth: Double = 12.0,
  val frequency: Double = 600.0,
  val volume: Double = 50.0
) {
  val ditSeconds: Double get() = 1.2 / wpm
  val spacingSeconds: Double get() = (60.0 / farnsworth - 31.0 * ditSeconds) / 19.0
  val letterGapMillis: Double get() = spacingSeconds * 3_000.0

  fun durationSeconds(tone: Boolean, units: Int): Double =
    (if (!tone && units >= 3) spacingSeconds else ditSeconds) * units

  /** Do not add a gap twice when the warm output has already been silent between user taps. */
  fun remainingGapSeconds(units: Int, previousAudibleEndMillis: Double, nowMillis: Long): Double {
    if (units == 0 || previousAudibleEndMillis <= 0.0) return 0.0
    val elapsedSilence = ((nowMillis - previousAudibleEndMillis) / 1000.0).coerceAtLeast(0.0)
    return (durationSeconds(false, units) - elapsedSilence).coerceAtLeast(0.0)
  }

  fun asMap(): Map<String, Double> = mapOf("wpm" to wpm, "farnsworth" to farnsworth,
    "frequency" to frequency, "volume" to volume)

  companion object {
    fun normalized(options: Map<String, Double>): MorseAudioSettings {
      fun value(key: String, fallback: Double, min: Double, max: Double): Double =
        (options[key]?.takeIf { it.isFinite() } ?: fallback).coerceIn(min, max)
      val wpm = value("wpm", 18.0, 5.0, 60.0)
      return MorseAudioSettings(wpm, value("farnsworth", 12.0, 1.0, wpm),
        value("frequency", 600.0, 200.0, 1200.0), value("volume", 50.0, 0.0, 100.0))
    }
  }
}

internal object NotificationAudioSettings {
  private const val KEY = "audio"
  @Volatile private var cached: MorseAudioSettings? = null

  fun read(context: Context): MorseAudioSettings {
    cached?.let { return it }
    return synchronized(this) {
      cached ?: NotificationStore.read(context, KEY)?.let { json ->
        MorseAudioSettings.normalized(listOf("wpm", "farnsworth", "frequency", "volume")
          .filter { json.has(it) }.associateWith { json.optDouble(it) })
      }.let { it ?: MorseAudioSettings() }.also { cached = it }
    }
  }

  @Synchronized fun update(context: Context, options: Map<String, Double>): MorseAudioSettings {
    val settings = MorseAudioSettings.normalized(options)
    NotificationStore.write(context, KEY, JSONObject(settings.asMap()))
    cached = settings
    return settings
  }
}
