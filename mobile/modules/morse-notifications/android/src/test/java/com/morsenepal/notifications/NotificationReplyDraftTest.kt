package com.morsenepal.notifications

import org.junit.Assert.*
import org.junit.Test

class NotificationReplyDraftTest {
  @Test fun longMorseDraftIsRetainedAndDecodesWithoutPreviewTruncation() {
    val text = "HELLO123 ".repeat(100).trim()
    val draft = NotificationReplyDraft(text = text).switchMode("morse")
    assertTrue(draft.morse.signal.length > 80)
    assertEquals(text, draft.textForSending())
    assertEquals(text, draft.switchMode("text").text)
  }

  @Test fun unchangedRoundTripPreservesOriginalTextAndPunctuation() {
    val text = "Hi, friend!\nAre you OK? 123"
    assertEquals(text, NotificationReplyDraft(text = text).switchMode("morse").switchMode("text").text)
  }

  @Test fun typedMorseConvertsToTextWhenSwitchingMode() {
    val settings = MorseAudioSettings(18.0, 12.0)
    var draft = NotificationReplyDraft(mode = "morse")
    draft = draft.mark('.', 1000L, settings).mark('.', 1020L, settings)
    draft = draft.word().mark('-', 1040L, settings)
    assertEquals("I T", draft.switchMode("text").text)
  }

  @Test fun firstMarkAfterTextConversionStartsANewLetter() {
    val converted = NotificationReplyDraft(text = "HI").switchMode("morse")
    val appended = converted.mark('.', 1000L, MorseAudioSettings())
    assertEquals("..../../.", appended.morse.signal)
    assertEquals("HIE", appended.switchMode("text").text)
  }

  @Test fun fastMarksAreAcceptedWithoutWaitingForPlaybackOrRendering() {
    val settings = MorseAudioSettings(5.0, 3.0)
    var draft = NotificationReplyDraft(mode = "morse")
    repeat(100) { index -> draft = draft.mark(if (index % 2 == 0) '.' else '-', 1000L + index, settings) }
    assertEquals(".-".repeat(50), draft.morse.signal)
    assertEquals(1099L, draft.morse.lastTapMillis)
  }

  @Test fun letterBoundariesFollowSelectedFarnsworthTiming() {
    val settings = MorseAudioSettings(18.0, 10.0)
    val first = NotificationReplyDraft(mode = "morse").mark('.', 1000L, settings)
    val before = first.mark('-', 1000L + settings.letterGapMillis.toLong() - 1, settings)
    val after = first.mark('-', 1000L + kotlin.math.ceil(settings.letterGapMillis).toLong(), settings)
    assertEquals(".-", before.morse.signal)
    assertEquals("./-", after.morse.signal)
  }

  @Test fun repeatedBackspaceRemovesMarksAndWholeWordSeparators() {
    var draft = NotificationReplyDraft(morse = MorseDraft(".-//-.."), mode = "morse")
    repeat(3) { draft = draft.backspace(1000L + it) }
    assertEquals(".-//", draft.morse.signal)
    draft = draft.backspace(1004L)
    assertEquals(".-", draft.morse.signal)
    repeat(5) { draft = draft.backspace(1005L + it) }
    assertEquals("", draft.morse.signal)
  }

  @Test fun invalidMorseCannotEraseTheDraftDuringConversion() {
    val draft = NotificationReplyDraft(morse = MorseDraft("......"), mode = "morse")
    assertThrows(IllegalArgumentException::class.java) { draft.switchMode("text") }
    assertEquals("......", draft.morse.signal)
  }

  @Test fun textBackspaceRemovesACompleteSupplementaryCharacter() {
    val draft = NotificationReplyDraft(text = "OK \uD83D\uDE42")
    assertEquals("OK ", draft.backspace(1L).text)
  }

  @Test fun oversizedAndEmptyRepliesAreRejected() {
    assertThrows(IllegalArgumentException::class.java) { NotificationReplyDraft().editText("A".repeat(1001)) }
    assertThrows(IllegalArgumentException::class.java) { NotificationReplyDraft(text = "!!!").textForSending() }
    assertThrows(IllegalArgumentException::class.java) { NotificationReplyDraft().textForSending() }
  }
}
