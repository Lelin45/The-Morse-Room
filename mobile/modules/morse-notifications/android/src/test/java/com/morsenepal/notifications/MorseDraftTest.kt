package com.morsenepal.notifications

import org.junit.Assert.*
import org.junit.Test

class MorseDraftTest {
  @Test fun oneHundredRapidAlternatingTapsRemainInArrivalOrder() {
    val profile = MorseAudioSettings(24.0, 15.0, 700.0, 50.0)
    var draft = MorseDraft()
    val expected = (0 until 100).map { if (it % 2 == 0) '.' else '-' }.joinToString("")
    for (index in 0 until 100) draft = draft.mark(expected[index], 10_000L + index * 10, profile)
    assertEquals(expected, draft.signal)
    assertEquals(10_990L, draft.lastTapMillis)
  }

  @Test fun delayedAudioOrStorageDoesNotChangeCapturedLetterBoundaries() {
    val profile = MorseAudioSettings(24.0, 15.0)
    // Pretend earlier crypto, UI and audio each took seconds. Only captured receipt times enter this reducer.
    val first = MorseDraft().mark('-', 10_000L, profile)
    val second = first.mark('.', 10_040L, profile)
    assertEquals("-.", second.signal)
    assertEquals("-.//-", second.word().mark('-', 10_050L, profile).signal)
  }

  @Test fun letterGapMatchesTheExactFarnsworthProfileWithoutAFixedFloor() {
    val profile = MorseAudioSettings(24.0, 15.0)
    val first = MorseDraft().mark('.', 10_000L, profile)
    assertEquals("..", first.mark('.', 10_386L, profile).signal)
    assertEquals("./.", first.mark('.', 10_387L, profile).signal)
    val fast = MorseAudioSettings(60.0, 60.0)
    assertEquals("./-", first.mark('-', 10_060L, fast).signal)
  }

  @Test fun backspaceWordAndNextMarkOperateOnTheLatestDraft() {
    val profile = MorseAudioSettings()
    var draft = MorseDraft().mark('.', 10_000L, profile).mark('-', 10_030L, profile)
    draft = draft.backspace(10_040L).mark('.', 10_050L, profile).word().mark('-', 10_070L, profile)
    assertEquals("..//-", draft.signal)
    assertEquals("I T", MorseCodec.decodeDraft(draft.signal))
    assertEquals("..", draft.backspace(10_080L).backspace(10_090L).signal)
  }

  @Test fun rebootedMonotonicClockDoesNotMergeWithAnOldLetter() {
    assertEquals("./-", MorseDraft(".", 50_000L).mark('-', 1_000L, MorseAudioSettings()).signal)
  }

  @Test fun draftLimitRejectsOnlyTheNewMark() {
    val full = MorseDraft(".".repeat(6000), 1_000L)
    try { full.mark('-', 1_001L, MorseAudioSettings()); fail("Limit must be enforced") }
    catch (_: IllegalArgumentException) { assertEquals(6000, full.signal.length) }
  }

  @Test fun audioBoundariesFollowTheDraftEvenWhileEarlierTonesAreQueued() {
    val settings = MorseAudioSettings(24.0, 15.0)
    val empty = MorseDraft()
    val first = empty.mark('-', 10_000L, settings)
    assertEquals(0, empty.gapUnitsBefore(first))
    assertEquals(1, first.gapUnitsBefore(first.mark('.', 10_050L, settings)))
    assertEquals(3, first.gapUnitsBefore(first.mark('.', 10_387L, settings)))
    val word = first.word()
    assertEquals(7, word.gapUnitsBefore(word.mark('.', 10_050L, settings)))
    val correctedLetter = MorseDraft(".-/", 10_000L)
    assertEquals(3, correctedLetter.gapUnitsBefore(correctedLetter.mark('.', 10_050L, settings)))
  }
}
