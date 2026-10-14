package com.morsenepal.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class NotificationRegistrationTest {
  @Test fun aDistinctServerDeviceIdIsAcceptedAfterRegistration() {
    val installationId = "bf0a044a-431c-4c65-bbfa-804b05c9a4c2"
    val serverId = "9bb31554-f82d-44f8-9d55-7b3f6b1c644f"
    val registration = NotificationRegistration.fromOptions(mapOf("deviceId" to serverId, "userId" to "reviewer", "authToken" to "t".repeat(64)))
    assertEquals(serverId, registration.serverDeviceId)
    assertNotEquals(installationId, registration.serverDeviceId)
    assertEquals("reviewer", registration.userId)
  }

  @Test(expected = IllegalArgumentException::class) fun malformedServerDeviceIdIsRejected() {
    NotificationRegistration.fromOptions(mapOf("deviceId" to "not-a-device", "userId" to "reviewer", "authToken" to "t".repeat(64)))
  }

  @Test(expected = IllegalArgumentException::class) fun missingCapabilityCannotConfigureAnAccount() {
    NotificationRegistration.fromOptions(mapOf("deviceId" to "9bb31554-f82d-44f8-9d55-7b3f6b1c644f", "userId" to "reviewer"))
  }
}
