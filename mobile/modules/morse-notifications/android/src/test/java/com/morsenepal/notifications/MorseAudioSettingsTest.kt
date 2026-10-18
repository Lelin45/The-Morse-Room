package com.morsenepal.notifications

import org.junit.Assert.*
import org.junit.Test

class MorseAudioSettingsTest {
  @Test fun parisTimingPreservesCharacterSpeedAndStretchesOnlySpacing() {
    val settings = MorseAudioSettings(24.0, 15.0)
    assertEquals(0.05, settings.ditSeconds, 0.0000001)
    assertEquals(386.8421052631579, settings.letterGapMillis, 0.0000001)
    assertEquals(4.0, 31 * settings.ditSeconds + 19 * settings.spacingSeconds, 0.0000001)
    assertEquals(0.15, settings.durationSeconds(true, 3), 0.0000001)
    assertEquals(0.05, settings.durationSeconds(false, 1), 0.0000001)
    assertEquals(0.9026315789473685, settings.durationSeconds(false, 7), 0.0000001)
  }

  @Test fun allSupportedBoundarySpeedsHavePositiveGaps() {
    for (wpm in listOf(5.0, 18.0, 24.0, 60.0)) for (farnsworth in listOf(1.0, 5.0, wpm)) {
      val settings = MorseAudioSettings.normalized(mapOf("wpm" to wpm, "farnsworth" to farnsworth))
      assertTrue(settings.spacingSeconds > 0)
      assertEquals(60 / settings.farnsworth, 31 * settings.ditSeconds + 19 * settings.spacingSeconds, 0.0000001)
    }
  }

  @Test fun invalidFieldsAndMissingFarnsworthAreNormalizedIncludingMute() {
    for (options in listOf(mapOf("wpm" to 5.0), mapOf("wpm" to 5.0, "farnsworth" to Double.NaN))) {
      val settings = MorseAudioSettings.normalized(options)
      assertEquals(5.0, settings.farnsworth, 0.0)
      assertTrue(settings.spacingSeconds > 0)
    }
    val settings = MorseAudioSettings.normalized(mapOf("wpm" to 70.0, "farnsworth" to 80.0,
      "frequency" to Double.POSITIVE_INFINITY, "volume" to 0.0))
    assertEquals(60.0, settings.wpm, 0.0)
    assertEquals(60.0, settings.farnsworth, 0.0)
    assertEquals(600.0, settings.frequency, 0.0)
    assertEquals(0.0, settings.volume, 0.0)
  }

  @Test fun queuedMarksUseIntraLetterAndWordGapsWithoutAddingExistingSilenceTwice() {
    val settings = MorseAudioSettings(24.0, 15.0)
    // An audible end in the future means earlier marks are still queued: all of the gap must be rendered.
    assertEquals(0.05, settings.remainingGapSeconds(1, 1_500.0, 1_000L), 0.0000001)
    assertEquals(0.3868421052631579, settings.remainingGapSeconds(3, 1_500.0, 1_000L), 0.0000001)
    assertEquals(0.9026315789473685, settings.remainingGapSeconds(7, 1_500.0, 1_000L), 0.0000001)
    assertEquals(0.2868421052631579, settings.remainingGapSeconds(3, 1_000.0, 1_100L), 0.0000001)
    assertEquals(0.0, settings.remainingGapSeconds(7, 1_000.0, 3_000L), 0.0)
    assertEquals(0.0, settings.remainingGapSeconds(0, 1_000.0, 1_010L), 0.0)
    assertEquals(0.0, settings.remainingGapSeconds(3, 0.0, 1_010L), 0.0)
  }
}
