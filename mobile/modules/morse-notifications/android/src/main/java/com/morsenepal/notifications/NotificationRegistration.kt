package com.morsenepal.notifications

/** The server registration UUID is separate from this phone's installation UUID. */
internal data class NotificationRegistration(val serverDeviceId: String, val userId: String, val authToken: String) {
  companion object {
    fun fromOptions(options: Map<String, String>): NotificationRegistration {
      val deviceId = options["deviceId"].orEmpty()
      val userId = options["userId"].orEmpty()
      val token = options["authToken"].orEmpty()
      require(userId.isNotBlank() && userId.length <= 128 && token.length in 32..4096) { "Notification sign-in details are invalid." }
      require(deviceId.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))) { "Notification server device identifier is invalid." }
      return NotificationRegistration(deviceId, userId, token)
    }
  }
}
