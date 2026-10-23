/* Morse Room MR1 USB keyer reference firmware.
 * Board: Raspberry Pi Pico, Earle Philhower Arduino-Pico core, Pico SDK USB stack.
 * GPIO 2 drives an EXTERNAL ISOLATOR, never the Pixie KEY socket directly.
 * Default/restart/disconnect/STOP/watchdog state is key-up.
 */
#include <Arduino.h>
#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const uint8_t KEY_PIN = 2;
static const uint32_t WATCHDOG_MS = 2500;
static char inputLine[9000];
static size_t inputLength = 0;
static bool discarding = false;
static char symbols[8192];
static char transmissionId[65];
static size_t symbolIndex = 0;
static uint32_t ditMs = 0, characterGapMs = 0, wordGapMs = 0;
static uint32_t deadline = 0, lastHeartbeat = 0;
static bool transmitting = false, keyed = false, authenticated = false;

static void keyUp() { digitalWrite(KEY_PIN, LOW); keyed = false; }
static void reply(const char *line) {
  // Never let a host that stopped reading stall the key-up/watchdog loop.
  size_t bytes = strlen(line) + 2;
  if (Serial && Serial.availableForWrite() >= (int)bytes) Serial.println(line);
}
static void replyId(const char *prefix) {
  char response[96];
  snprintf(response, sizeof(response), "%s%s", prefix, transmissionId);
  reply(response);
}
static void stopTransmission(bool announce) {
  keyUp(); transmitting = false; symbols[0] = '\0'; symbolIndex = 0;
  if (announce) reply("MR1 STOPPED");
}
static bool identifier(const char *value) {
  size_t length = strlen(value);
  if (!length || length > 64) return false;
  for (size_t i = 0; i < length; ++i) {
    char c = value[i];
    if (!(isalnum((unsigned char)c) || c == '_' || c == '-')) return false;
  }
  return true;
}
static bool number(const char *value, uint32_t *result) {
  if (!value || !*value) return false;
  for (const char *cursor = value; *cursor; ++cursor) if (!isdigit((unsigned char)*cursor)) return false;
  char *end = nullptr;
  unsigned long parsed = strtoul(value, &end, 10);
  if (*end || parsed > 60000) return false;
  *result = (uint32_t)parsed;
  return true;
}
static bool validMorse(const char *value) {
  size_t count = 0, marks = 0, inLetter = 0;
  if (!value || !*value || (*value != '.' && *value != '-')) return false;
  while (value[count]) {
    char c = value[count];
    if (c == '.' || c == '-') {
      if (++marks > 4096 || ++inLetter > 8) return false;
    } else if (c == ' ') {
      if (!inLetter) return false;
      inLetter = 0;
      if (value[count + 1] == '/') {
        if (value[count + 2] != ' ' || (value[count + 3] != '.' && value[count + 3] != '-')) return false;
        count += 2;
      } else if (value[count + 1] != '.' && value[count + 1] != '-') return false;
    } else return false;
    if (++count >= sizeof(symbols)) return false;
  }
  return marks > 0 && inLetter > 0;
}
static void command(char *line) {
  if (strcmp(line, "MR1 STOP") == 0) { lastHeartbeat = millis(); stopTransmission(true); return; }
  if (strcmp(line, "MR1 HELLO") == 0) {
    stopTransmission(false); authenticated = true; lastHeartbeat = millis(); reply("MR1 READY KEYER"); return;
  }
  if (strcmp(line, "MR1 PING") == 0) { if (authenticated) lastHeartbeat = millis(); return; }
  if (strncmp(line, "MR1 TX ", 7) != 0 || !authenticated) { reply("MR1 ERROR Unsupported command"); return; }
  if (transmitting) { reply("MR1 ERROR Transmission already active"); return; }
  char *cursor = line + 7;
  char *fields[4];
  for (size_t index = 0; index < 4; ++index) {
    fields[index] = cursor;
    char *space = strchr(cursor, ' ');
    if (!space) { reply("MR1 ERROR Missing timing or message"); return; }
    *space = '\0'; cursor = space + 1;
  }
  uint32_t requestedDit, requestedCharacter, requestedWord;
  if (!identifier(fields[0]) || !number(fields[1], &requestedDit) || !number(fields[2], &requestedCharacter)
      || !number(fields[3], &requestedWord) || requestedDit < 20 || requestedDit > 600
      || requestedCharacter < requestedDit * 3 || requestedWord < requestedDit * 7
      || requestedWord < requestedCharacter || !validMorse(cursor)) {
    reply("MR1 ERROR Invalid timing or Morse message"); return;
  }
  strcpy(transmissionId, fields[0]); strcpy(symbols, cursor);
  ditMs = requestedDit; characterGapMs = requestedCharacter; wordGapMs = requestedWord;
  symbolIndex = 0; keyed = false; transmitting = true;
  lastHeartbeat = millis(); deadline = micros();
  replyId("MR1 START ");
}
static void serviceTransmission() {
  if (!transmitting || (int32_t)(micros() - deadline) < 0) return;
  if (keyed) {
    keyUp();
    char next = symbols[symbolIndex];
    uint32_t gap = ditMs;
    if (next == ' ') {
      if (symbols[symbolIndex + 1] == '/') { gap = wordGapMs; symbolIndex += 3; }
      else { gap = characterGapMs; symbolIndex += 1; }
    } else if (next == '\0') { transmitting = false; replyId("MR1 DONE "); return; }
    deadline = micros() + gap * 1000UL;
  } else {
    char mark = symbols[symbolIndex++];
    if (mark != '.' && mark != '-') { stopTransmission(false); reply("MR1 ERROR Invalid keying state"); return; }
    digitalWrite(KEY_PIN, HIGH); keyed = true;
    deadline = micros() + ditMs * (mark == '-' ? 3000UL : 1000UL);
  }
}
void setup() {
  digitalWrite(KEY_PIN, LOW); pinMode(KEY_PIN, OUTPUT); keyUp();
  Serial.begin(115200);
  lastHeartbeat = millis();
}
void loop() {
  if (!Serial) {
    stopTransmission(false); authenticated = false; inputLength = 0; discarding = false;
    delay(1); return;
  }
  if (authenticated && millis() - lastHeartbeat > WATCHDOG_MS) {
    stopTransmission(true); authenticated = false;
  }
  // Consume a bounded number of bytes so key timing is serviced during USB traffic.
  for (size_t bytes = 0; bytes < 128 && Serial.available(); ++bytes) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (!discarding) { inputLine[inputLength] = '\0'; if (inputLength) command(inputLine); }
      inputLength = 0; discarding = false;
    } else if ((unsigned char)c < 32 || (unsigned char)c > 126 || inputLength >= sizeof(inputLine) - 1) {
      stopTransmission(false); inputLength = 0; discarding = true;
      reply("MR1 ERROR Command too long or invalid");
    } else if (!discarding) inputLine[inputLength++] = c;
  }
  serviceTransmission();
}
