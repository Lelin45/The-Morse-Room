package com.morsenepal.notifications

/** Editor state is independent of storage, System UI redraws and audio playback. */
internal data class NotificationReplyDraft(
  val text: String = "",
  val morse: MorseDraft = MorseDraft(),
  val mode: String = "text",
  val sourceText: String? = null,
  val sourceMorse: String? = null
) {
  fun editText(value: String): NotificationReplyDraft {
    require(value.length <= 1000) { "Keep your message to 1,000 characters." }
    return copy(text = value, sourceText = null, sourceMorse = null)
  }

  fun switchMode(next: String): NotificationReplyDraft {
    require(next == "text" || next == "morse")
    if (next == mode) return this
    if (next == "morse") {
      val signal = MorseCodec.encode(text).split(" / ").joinToString("//") { it.replace(" ", "/") }
      require(text.isBlank() || signal.isNotBlank()) { "Include a letter or number." }
      require(signal.length <= 6000) { "Keep your Morse message to 6,000 symbols." }
      return copy(morse = MorseDraft(signal), mode = next, sourceText = text, sourceMorse = signal)
    }
    val decoded = if (morse.signal == sourceMorse && sourceText != null) sourceText
      else if (morse.signal.isBlank()) "" else MorseCodec.decodeDraft(morse.signal)
    return copy(text = decoded, mode = next)
  }

  fun mark(symbol: Char, timestamp: Long, settings: MorseAudioSettings): NotificationReplyDraft {
    // Converted text ends in a complete letter, even before the first physical tap establishes a clock.
    val current = if (sourceMorse == morse.signal && morse.signal.isNotBlank() && !morse.signal.endsWith('/'))
      morse.copy(signal = morse.signal + "/") else morse
    return copy(morse = current.mark(symbol, timestamp, settings), sourceText = null, sourceMorse = null)
  }

  fun word(): NotificationReplyDraft = copy(morse = morse.word(), sourceText = null, sourceMorse = null)

  fun backspace(timestamp: Long): NotificationReplyDraft = if (mode == "morse")
    copy(morse = morse.backspace(timestamp), sourceText = null, sourceMorse = null)
  else editText(if (text.isEmpty()) "" else text.substring(0, text.offsetByCodePoints(text.length, -1)))

  fun textForSending(): String {
    val value = if (mode == "morse") MorseCodec.decodeDraft(morse.signal) else text
    require(value.isNotBlank() && MorseCodec.encode(value).isNotBlank()) { "Include a letter or number." }
    require(value.length <= 1000) { "Keep your message to 1,000 characters." }
    return value
  }
}
