package com.morsenepal.notifications

import java.text.Normalizer
import java.util.Locale

internal object MorseCodec {
  val codes = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".toList().zip(listOf(
    ".-", "-...", "-.-.", "-..", ".", "..-.", "--.", "....", "..", ".---", "-.-", ".-..", "--", "-.", "---", ".--.", "--.-", ".-.", "...", "-", "..-", "...-", ".--", "-..-", "-.--", "--..", "-----", ".----", "..---", "...--", "....-", ".....", "-....", "--...", "---..", "----."
  )).toMap()
  private val letters = codes.entries.associate { it.value to it.key }

  fun encode(text: String): String = Normalizer.normalize(text.replace(Regex("[^\\p{L}0-9\\s]"), ""), Normalizer.Form.NFKD)
    .replace(Regex("\\p{M}"), "").uppercase(Locale.ROOT).split(Regex("\\s+"))
    .map { word -> word.mapNotNull { codes[it] }.joinToString(" ") }
    .filter { it.isNotBlank() }.joinToString(" / ")

  /** Composer grammar: / between letters, // between words. */
  fun decodeDraft(input: String): String {
    require(input.length <= 6000) { "Keep your Morse message to 6,000 symbols." }
    require(input.all { it == '.' || it == '-' || it == '/' || it.isWhitespace() }) { "Use dits and dahs only." }
    val signal = input.trim().replace(Regex("\\s*/\\s*"), "/").replace(Regex("/{1,2}$"), "")
    require(signal.isNotBlank() && !signal.startsWith('/') && !signal.contains("///")) { "Complete a Morse letter first." }
    val text = signal.split("//").joinToString(" ") { word ->
      word.split(Regex("[\\s/]+")).joinToString("") { group ->
        (letters[group] ?: throw IllegalArgumentException("Check the Morse letter $group.")).toString()
      }
    }
    require(text.length <= 1000) { "Keep your message to 1,000 characters." }
    return text
  }

  /** Canonical signal gaps, in dit units: inside 1, letters 3, words 7. */
  fun segments(signal: String): List<Pair<Boolean, Int>> {
    val parts = signal.trim().split(Regex("\\s+"))
    val result = mutableListOf<Pair<Boolean, Int>>()
    var previousLetter = false
    var wordGap = false
    for (part in parts) {
      if (part == "/") { wordGap = true; continue }
      if (part.isBlank() || part.any { it != '.' && it != '-' }) continue
      if (previousLetter) result.add(false to if (wordGap) 7 else 3)
      part.forEachIndexed { index, symbol ->
        if (index > 0) result.add(false to 1)
        result.add(true to if (symbol == '.') 1 else 3)
      }
      previousLetter = true
      wordGap = false
    }
    return result
  }
}
