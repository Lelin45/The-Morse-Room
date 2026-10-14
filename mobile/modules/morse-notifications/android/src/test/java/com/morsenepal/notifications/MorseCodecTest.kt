package com.morsenepal.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MorseCodecTest {
  @Test fun everyLetterAndNumberCanBeSentWithoutChangingItsValue() {
    for ((letter, signal) in MorseCodec.codes) {
      assertEquals(letter.toString(), MorseCodec.decodeDraft(signal))
      assertEquals(signal, MorseCodec.encode(letter.toString()))
    }
  }

  @Test fun punctuationIsKeptOutOfAudioAndUnicodeAccentsAreNormalized() {
    assertEquals(MorseCodec.encode("HI CAFE 2"), MorseCodec.encode("Hi, café 2!"))
    assertEquals("", MorseCodec.encode("?! 👋"))
  }

  @Test fun composerSeparatorsAndTrailingPauseDecodeCorrectly() {
    assertEquals("HI 2", MorseCodec.decodeDraft("..../..//..---/"))
    assertEquals("HI 2", MorseCodec.decodeDraft(".... .. // ..---//"))
  }

  @Test fun malformedSignalsCannotBecomeAReply() {
    for (input in listOf("", "/.", ".///-", "......", ".x-", ".//" + ".".repeat(6000))) {
      var rejected = false
      try { MorseCodec.decodeDraft(input) } catch (_: IllegalArgumentException) { rejected = true }
      assertTrue("Expected an invalid signal to be rejected", rejected)
    }
  }

  @Test fun standardTimingIncludesOneThreeAndSevenUnitGaps() {
    assertEquals(listOf(true to 3, false to 1, true to 3, false to 1, true to 1, false to 1, true to 3), MorseCodec.segments("--.-"))
    assertEquals(listOf(true to 1, false to 3, true to 3, false to 7, true to 1), MorseCodec.segments(". - / ."))
    // PARIS has 43 units through its last dit; its following word gap makes the standard 50-unit word.
    assertEquals(50, MorseCodec.segments(MorseCodec.encode("PARIS")).sumOf { it.second } + 7)
  }
}
