package com.morsenepal.notifications

/** No Android or storage work: arrival times, rather than playback or render times, separate letters. */
internal data class MorseDraft(val signal: String = "", val lastTapMillis: Long = 0L) {
  fun mark(symbol: Char, arrivedAt: Long, settings: MorseAudioSettings): MorseDraft {
    require(symbol == '.' || symbol == '-')
    val separated = signal.isNotBlank() && !signal.endsWith('/') && lastTapMillis > 0L &&
      (arrivedAt < lastTapMillis || arrivedAt - lastTapMillis >= settings.letterGapMillis)
    val next = signal + (if (separated) "/" else "") + symbol
    require(next.length <= 6000) { "Keep your Morse message to 6,000 symbols." }
    return MorseDraft(next, arrivedAt)
  }

  fun word(): MorseDraft {
    val trimmed = signal.trimEnd('/')
    require(trimmed.length <= 5998) { "Keep your Morse message to 6,000 symbols." }
    return copy(signal = if (trimmed.isBlank()) "" else "$trimmed//")
  }

  fun backspace(arrivedAt: Long): MorseDraft = MorseDraft(
    if (signal.endsWith("//")) signal.dropLast(2) else signal.dropLast(1), arrivedAt)

  fun gapUnitsBefore(next: MorseDraft): Int = when {
    signal.isBlank() -> 0
    signal.endsWith("//") -> 7
    signal.endsWith('/') || next.signal.length > signal.length + 1 -> 3
    else -> 1
  }
}
