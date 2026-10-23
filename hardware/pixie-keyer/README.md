# S-Pixie connection guide

Advanced mode supports the 7.023 MHz S-Pixie through **external interfaces**. The Pixie does not have USB, Bluetooth, an audio digitizer or a computer keyer. An ordinary USB cable and wireless earphones do not add these functions.

## What you need

- Your assembled and working S-Pixie, its separate 9–13.8 V supply and an appropriate 40 m antenna.
- An Android phone with USB host support. For USB-C phones such as the OnePlus Nord 2T, use a compatible USB-C OTG hub when connecting both interfaces.
- A USB audio interface with a **microphone or line input**. A headphone-output-only USB-C adapter cannot capture radio audio.
- Audio attenuation and isolation suitable for the interface input. Headphone output and microphone input have different levels. Connect the Pixie PHONE output through this interface, never its antenna or power socket.
- For transmitting: a Raspberry Pi Pico running the supplied MR1 firmware and an isolated electronic switch between the Pico and Pixie KEY input.

You can receive without a keyer. The phone microphone can decode audible Morse from a receiver's speaker, with reduced noise rejection. Headphones plugged into the Pixie let you hear received audio but do not send that audio to the phone.

## Receiving

`Pixie PHONE → audio level matching and isolation → USB audio input → USB-C hub → phone`

Enable Advanced mode in the audio settings, open Radio, then Connection setup. Choose the actual USB input and set Target tone to the audible Morse pitch. The displayed 7.023 MHz is the Pixie's radio frequency; the audio tone setting is not a transmitter tuning control.

Microphone permission is requested only when you start receiving. Audio is processed on the phone in memory; it is not saved or uploaded. Decoding is an aid and may make mistakes on weak signals, interference or uneven sending.

## Reference keyer hardware

The reference firmware uses a **Raspberry Pi Pico / RP2040** and the Earle Philhower Arduino-Pico core with the **Pico SDK USB stack**, exposing a USB CDC ACM serial device. It is not firmware for an arbitrary USB-to-serial cable.

1. Install the Arduino-Pico core, select Raspberry Pi Pico and the Pico SDK USB stack, and upload `pixie-keyer.ino`.
2. GPIO 2 is the active-high keying control. Use an external pull-down so the isolator remains off before the firmware configures the pin.
3. GPIO 2 drives the input side of a suitably rated optocoupler or isolated keying circuit through the correct current-limiting resistor. Connect its output switch across the radio's KEY contacts after checking the actual board's key voltage, current, polarity and connector pinout.
4. The isolator output must imitate a closed manual key. Do not connect Pixie supply voltage, antenna RF or the KEY wire directly to a Pico GPIO or phone. Verify the installed isolator's datasheet and pinout rather than assuming different parts share wiring.
5. Verify key-up and Stop behavior with the radio disconnected, then use a correctly rated dummy load for transmitter setup. Confirm your radio licence permits the intended operation before on-air transmission.

`Phone USB → Pico MR1 firmware → isolated switch → Pixie KEY`

The radio remains separately powered. USB powers the controller only. Wiring and over-the-air operation cannot be verified remotely; have an experienced radio builder check the interface before connecting it.

## Using the app

Add your station callsign in Callsigns or Connection setup. In setup, select the USB keyer, grant Android USB permission and wait for the MR1 handshake. Confirm that the isolated interface has been installed and checked. Transmit remains unavailable until these steps are complete.

Type a message or select Morse and use the dit, dah, Space and Backspace controls. Preview plays locally. **Transmit** sends to the keyer. **Transmitted** means the keyer finished sending; the other operator must confirm reception. Stop cancels the queued transmission.

The app and keyer stop on disconnect or when the app leaves the foreground. Firmware also releases the key if the USB host disappears or no valid heartbeat arrives for 2.5 seconds. This safeguard is part of the protocol, not a replacement for checking the physical circuit.

## MR1 protocol

ASCII lines at 115200, 8N1. USB CDC DTR must be asserted. Handshake:

```text
Host:  MR1 HELLO
Keyer: MR1 READY KEYER
```

Transmission format:

```text
MR1 TX <id> <dit-ms> <letter-gap-ms> <word-gap-ms> <morse>
MR1 TX example1 67 201 469 .... .. / - .... . .-. .
```

Symbols within a letter are adjacent; letters use one space and words use ` / `. Gaps are total key-up durations, not extra delays added to an existing gap. The controller inserts the one-dit internal gaps itself. Dit duration is 20–600 ms; letter gaps are at least three dits and word gaps at least seven dits. Spacing is limited to 60 seconds and each transmission to 4,096 dits/dahs.

The host sends `MR1 PING` regularly while connected. `MR1 STOP` cancels immediately. The controller reports `MR1 START <id>`, `MR1 DONE <id>`, `MR1 STOPPED` or `MR1 ERROR <reason>`. A newly opened connection must complete its own handshake.

## Current support

This first version supports Android audio input and the documented MR1 USB keyer. Bluetooth keying, remote CAT tuning, other serial keyer protocols and verified support for other radio models are not included.

References: [S-Pixie kit manual](https://w5nor.org/wp-content/uploads/2018/02/SKU420968-S-Pixie-User-Manual.pdf), [Arduino-Pico USB documentation](https://arduino-pico.readthedocs.io/en/latest/usb.html), [Fldigi key interface explanation](https://www.w1hkj.org/FldigiHelp/cw_keying_page.html).
