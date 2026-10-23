package com.morsenepal.radio

import android.content.pm.PackageManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class RadioReceiveOptions : Record {
  @Field var deviceId: Int? = null
}

class RadioTransmitOptions : Record {
  @Field var id: String = ""
  @Field var ditMs: Int = 0
  @Field var characterGapMs: Int = 0
  @Field var wordGapMs: Int = 0
  @Field var morse: String = ""
}

class MorseRadioModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext) { "Android app context is unavailable." }
  private var audio: RadioAudioCapture? = null
  private var keyer: UsbCdcKeyer? = null
  @Volatile private var alive = false

  override fun definition() = ModuleDefinition {
    Name("MorseRadio")
    Events("onRadioEvent")

    OnCreate {
      alive = true
      audio = RadioAudioCapture(context, ::emit)
      keyer = UsbCdcKeyer(context, ::emit)
    }
    OnActivityEntersBackground {
      audio?.stop("Receiving stopped while the app is in the background.")
      keyer?.pause()
    }
    OnActivityEntersForeground { keyer?.resume() }
    OnUserLeavesActivity {
      audio?.stop("Receiving stopped while the app is in the background.")
      keyer?.pause()
    }
    OnDestroy {
      alive = false
      audio?.destroy()
      keyer?.destroy()
      audio = null
      keyer = null
    }

    AsyncFunction("getCapabilitiesAsync") {
      mapOf("supported" to true, "audioReceive" to true,
        "usbHost" to context.packageManager.hasSystemFeature(PackageManager.FEATURE_USB_HOST),
        "usbKeyer" to true, "bluetoothKeyer" to false, "protocol" to "MR1")
    }
    AsyncFunction("getAudioInputsAsync") { requireNotNull(audio).inputs() }
    AsyncFunction("startReceiveAsync") { options: RadioReceiveOptions -> requireNotNull(audio).start(options.deviceId) }
    AsyncFunction("stopReceiveAsync") { requireNotNull(audio).stop(null) }
    AsyncFunction("listKeyersAsync") { requireNotNull(keyer).devices() }
    AsyncFunction("connectKeyerAsync") { deviceId: Int, promise: Promise -> requireNotNull(keyer).connect(deviceId, promise) }
    AsyncFunction("transmitAsync") { options: RadioTransmitOptions ->
      // The Pixie is half duplex. Do not decode its own transmit sidetone as incoming text.
      audio?.stop(null)
      requireNotNull(keyer).transmit(options.id, options.ditMs, options.characterGapMs, options.wordGapMs, options.morse)
    }
    AsyncFunction("stopTransmitAsync") { requireNotNull(keyer).stopTransmit() }
    AsyncFunction("disconnectKeyerAsync") { requireNotNull(keyer).disconnect() }
  }

  private fun emit(event: Map<String, Any?>) {
    if (alive) try { sendEvent("onRadioEvent", event) } catch (_: Exception) { }
  }
}
