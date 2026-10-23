package com.morsenepal.radio

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.kotlin.Promise
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.Executors

/** Only the documented MR1 CDC adapter is keyed. Serial control lines never key a stock radio. */
internal class UsbCdcKeyer(
  private val context: Context,
  private val emit: (Map<String, Any?>) -> Unit,
) {
  private data class Interfaces(val control: UsbInterface, val data: UsbInterface, val input: UsbEndpoint, val output: UsbEndpoint)
  private data class Port(val device: UsbDevice, val connection: UsbDeviceConnection, val interfaces: Interfaces)

  private val manager = context.getSystemService(Context.USB_SERVICE) as UsbManager
  private val handler = Handler(Looper.getMainLooper())
  private val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "MorseRadioUsbConnect").apply { isDaemon = true } }
  private val writeLock = Any()
  private val permissionAction = "${context.packageName}.MORSE_RADIO_USB_PERMISSION.${UUID.randomUUID()}"
  @Volatile private var port: Port? = null
  @Volatile private var connected = false
  @Volatile private var activeId: String? = null
  @Volatile private var pending: Promise? = null
  @Volatile private var pendingDevice: UsbDevice? = null
  @Volatile private var destroyed = false
  @Volatile private var foreground = true
  private var permissionIntent: PendingIntent? = null
  private val timeout = Runnable {
    if (pending != null) fail("The USB keyer did not respond. Reconnect it and check that MR1 firmware is installed.")
  }

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val device = deviceFrom(intent) ?: return
      if (intent.action == UsbManager.ACTION_USB_DEVICE_DETACHED) {
        if (port?.device?.deviceId == device.deviceId || pendingDevice?.deviceId == device.deviceId) disconnect("USB keyer disconnected.")
        return
      }
      if (intent.action != permissionAction || device.deviceId != pendingDevice?.deviceId || pending == null) return
      permissionIntent?.cancel()
      permissionIntent = null
      if (!intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false) || !manager.hasPermission(device)) {
        fail("USB access was not allowed. Tap Connect to try again.")
      } else scheduleOpen(device)
    }
  }

  init {
    val filter = IntentFilter(permissionAction).apply { addAction(UsbManager.ACTION_USB_DEVICE_DETACHED) }
    if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    else {
      @Suppress("DEPRECATION")
      context.registerReceiver(receiver, filter)
    }
  }

  fun devices(): List<Map<String, Any?>> = manager.deviceList.values.map { device ->
    mapOf("id" to device.deviceId, "name" to (device.productName ?: "USB device"),
      "vendorId" to device.vendorId, "productId" to device.productId,
      "eligible" to (interfaces(device) != null), "permissionGranted" to manager.hasPermission(device))
  }

  @Synchronized
  fun connect(deviceId: Int, promise: Promise) {
    if (destroyed) { promise.reject("E_RADIO_CLOSED", "The radio connection is closed.", null); return }
    if (pending != null || port != null) { promise.reject("E_RADIO_BUSY", "Disconnect the current keyer before connecting another.", null); return }
    val device = manager.deviceList.values.firstOrNull { it.deviceId == deviceId }
    if (device == null || interfaces(device) == null) {
      promise.reject("E_RADIO_USB", "Connect a USB CDC ACM adapter running Morse Room MR1 firmware.", null)
      return
    }
    pending = promise
    pendingDevice = device
    handler.removeCallbacks(timeout)
    handler.postDelayed(timeout, 30000)
    if (manager.hasPermission(device)) scheduleOpen(device)
    else handler.post {
      try {
        if (pendingDevice?.deviceId != device.deviceId || pending == null || destroyed) return@post
        val permission = PendingIntent.getBroadcast(context, device.deviceId,
          Intent(permissionAction).setPackage(context.packageName),
          PendingIntent.FLAG_CANCEL_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        permissionIntent = permission
        manager.requestPermission(device, permission)
      } catch (error: Exception) { fail(error.message ?: "Android could not request USB access.") }
    }
  }

  private fun scheduleOpen(device: UsbDevice) {
    if (destroyed) return
    try {
      executor.execute {
        try { open(device) }
        catch (error: Exception) { fail(error.message ?: "The USB keyer could not be opened.") }
      }
    } catch (error: java.util.concurrent.RejectedExecutionException) {
      if (!destroyed) fail("The USB connection is unavailable. Reopen the Radio screen.")
    }
  }

  @Synchronized
  private fun open(device: UsbDevice) {
    if (destroyed || !foreground || pendingDevice?.deviceId != device.deviceId || pending == null || port != null) return
    val pair = interfaces(device) ?: error("USB CDC ACM interfaces are unavailable.")
    val connection = manager.openDevice(device) ?: error("Android could not open this USB device.")
    var claimedControl = false
    var claimedData = false
    try {
      claimedControl = connection.claimInterface(pair.control, true)
      claimedData = connection.claimInterface(pair.data, true)
      check(claimedControl && claimedData) { "The USB serial interfaces are busy." }
      // USB CDC SET_LINE_CODING: 115200 baud, 1 stop bit, no parity, 8 data bits.
      val lineCoding = byteArrayOf(0x00, 0xC2.toByte(), 0x01, 0x00, 0x00, 0x00, 0x08)
      check(connection.controlTransfer(0x21, 0x20, 0, pair.control.id, lineCoding, lineCoding.size, 1000) == lineCoding.size) {
        "The adapter did not accept USB serial settings."
      }
      check(connection.controlTransfer(0x21, 0x22, 0x01, pair.control.id, null, 0, 1000) >= 0) { "The adapter did not enable its serial port." }
      val opened = Port(device, connection, pair)
      port = opened
      handler.removeCallbacks(timeout)
      handler.postDelayed(timeout, 8000)
      Thread({ read(opened) }, "MorseRadioUsbRead").apply { isDaemon = true; start() }
      write(opened, "MR1 HELLO\n")
    } catch (error: Exception) {
      if (claimedData) connection.releaseInterface(pair.data)
      if (claimedControl) connection.releaseInterface(pair.control)
      connection.close()
      throw error
    }
  }

  fun transmit(id: String, ditMs: Int, characterGapMs: Int, wordGapMs: Int, morse: String): Map<String, Any?> {
    require(id.matches(Regex("[A-Za-z0-9_-]{1,64}"))) { "Transmission identifier is invalid." }
    require(ditMs in 20..600) { "Dit timing must be between 20 and 600 milliseconds." }
    require(characterGapMs in ditMs * 3..60000 && wordGapMs in maxOf(ditMs * 7, characterGapMs)..60000) { "Morse spacing is invalid." }
    require(morse.length <= 8191 && morse.count { it == '.' || it == '-' } in 1..4096 &&
      morse.matches(Regex("[.-]{1,8}(?: [.-]{1,8}| / [.-]{1,8})*"))) { "Use Morse characters separated by spaces and words separated by /, up to 4096 dits and dahs." }
    synchronized(this) {
      val current = port ?: error("Connect an MR1 USB keyer first.")
      check(connected) { "The adapter has not completed its MR1 handshake." }
      check(activeId == null) { "Wait for this transmission to finish or press Stop." }
      activeId = id
      try { write(current, "MR1 TX $id $ditMs $characterGapMs $wordGapMs $morse\n") }
      catch (error: Exception) { activeId = null; fail(error.message ?: "USB transmission failed."); throw error }
      return mapOf("state" to "queued", "id" to id)
    }
  }

  fun stopTransmit() {
    val current = port
    if (current != null) {
      try { write(current, "MR1 STOP\n") }
      catch (error: Exception) { fail(error.message ?: "The keyer stopped responding.") }
    }
    activeId = null
    emit(mapOf("kind" to "keyer", "state" to "stopped"))
  }

  private fun read(current: Port) {
    val buffer = ByteArray(512)
    val line = StringBuilder()
    var lastPing = SystemClock.elapsedRealtime()
    try {
      while (port === current && !destroyed) {
        val count = current.connection.bulkTransfer(current.interfaces.input, buffer, buffer.size, 100)
        if (port !== current || destroyed) break
        if (count > 0) {
          for (index in 0 until count) {
            val value = buffer[index].toInt() and 0xff
            if (value == 10) {
              handleLine(current, line.toString().trimEnd('\r'))
              line.setLength(0)
            } else {
              check(value in 32..126 || value == 13) { "The keyer returned invalid data." }
              check(line.length < 512) { "The keyer response was too long." }
              line.append(value.toChar())
            }
          }
        }
        if (SystemClock.elapsedRealtime() - lastPing >= 750) {
          // Some native USB boards need a moment after the serial port opens.
          write(current, if (connected) "MR1 PING\n" else "MR1 HELLO\n")
          lastPing = SystemClock.elapsedRealtime()
        }
      }
    } catch (error: Exception) {
      if (port === current) fail(error.message ?: "USB keyer disconnected.")
    }
  }

  private fun handleLine(current: Port, line: String) {
    if (port !== current) return
    if (line == "MR1 READY KEYER" && !connected) {
      val result: Promise?
      synchronized(this) {
        if (port !== current || pending == null) return
        connected = true
        result = pending
        pending = null
        pendingDevice = null
        handler.removeCallbacks(timeout)
      }
      val state = mapOf("kind" to "keyer", "state" to "connected", "deviceId" to current.device.deviceId,
        "deviceName" to (current.device.productName ?: "MR1 USB keyer"), "protocol" to "MR1")
      emit(state)
      result?.resolve(state)
    } else if (connected && line.startsWith("MR1 START ")) {
      val id = line.removePrefix("MR1 START ")
      if (id == activeId) emit(mapOf("kind" to "keyer", "state" to "transmitting", "id" to id))
    } else if (connected && line.startsWith("MR1 DONE ")) {
      val id = line.removePrefix("MR1 DONE ")
      if (id == activeId) {
        activeId = null
        emit(mapOf("kind" to "keyer", "state" to "done", "id" to id))
      }
    } else if (connected && line == "MR1 STOPPED") {
      activeId = null
      emit(mapOf("kind" to "keyer", "state" to "stopped"))
    } else if (line.startsWith("MR1 ERROR ")) {
      activeId = null
      if (!connected) fail("The adapter rejected the MR1 handshake.")
      else fail(line.removePrefix("MR1 ERROR ").take(200))
    }
  }

  private fun write(current: Port, text: String) {
    val bytes = text.toByteArray(StandardCharsets.US_ASCII)
    synchronized(writeLock) {
      check(port === current) { "USB keyer disconnected." }
      val count = current.connection.bulkTransfer(current.interfaces.output, bytes, bytes.size, 1000)
      check(count == bytes.size) { "The USB keyer could not receive the complete command." }
    }
  }

  private fun fail(message: String) {
    disconnect(message)
    emit(mapOf("kind" to "keyer", "state" to "error", "message" to message))
  }

  @Synchronized
  fun disconnect(reason: String? = null) {
    handler.removeCallbacks(timeout)
    permissionIntent?.cancel()
    permissionIntent = null
    val unresolved = pending
    pending = null
    pendingDevice = null
    connected = false
    activeId = null
    val previous = port
    if (previous != null) {
      // A leading newline also terminates any command interrupted by a cable/write failure.
      try { write(previous, "\nMR1 STOP\n") } catch (_: Exception) { }
      port = null
      try { previous.connection.controlTransfer(0x21, 0x22, 0, previous.interfaces.control.id, null, 0, 100) } catch (_: Exception) { }
      try { previous.connection.releaseInterface(previous.interfaces.data) } catch (_: Exception) { }
      try { previous.connection.releaseInterface(previous.interfaces.control) } catch (_: Exception) { }
      previous.connection.close()
    }
    unresolved?.reject("E_RADIO_USB", reason ?: "USB connection cancelled.", null)
    if (previous != null || unresolved != null) emit(mapOf("kind" to "keyer", "state" to "disconnected", "message" to reason))
  }

  @Synchronized
  fun pause() {
    foreground = false
    // The Android USB permission dialog briefly pauses the activity, before a port exists.
    // Keep its pending request, but never open a granted port until the app resumes.
    if (port != null) disconnect("Radio disconnected while the app is in the background.")
  }

  @Synchronized
  fun resume() {
    foreground = true
    val waiting = pendingDevice
    if (!destroyed && port == null && pending != null && waiting != null && manager.hasPermission(waiting)) scheduleOpen(waiting)
  }

  fun destroy() {
    destroyed = true
    disconnect()
    try { context.unregisterReceiver(receiver) } catch (_: Exception) { }
    executor.shutdownNow()
  }

  private fun interfaces(device: UsbDevice): Interfaces? {
    val all = (0 until device.interfaceCount).map { device.getInterface(it) }
    val control = all.firstOrNull { it.interfaceClass == UsbConstants.USB_CLASS_COMM && it.interfaceSubclass == 2 } ?: return null
    val data = all.firstOrNull { it.interfaceClass == UsbConstants.USB_CLASS_CDC_DATA } ?: return null
    val endpoints = (0 until data.endpointCount).map { data.getEndpoint(it) }.filter { it.type == UsbConstants.USB_ENDPOINT_XFER_BULK }
    val input = endpoints.firstOrNull { it.direction == UsbConstants.USB_DIR_IN } ?: return null
    val output = endpoints.firstOrNull { it.direction == UsbConstants.USB_DIR_OUT } ?: return null
    return Interfaces(control, data, input, output)
  }

  private fun deviceFrom(intent: Intent): UsbDevice? = if (Build.VERSION.SDK_INT >= 33) {
    intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
  } else {
    @Suppress("DEPRECATION")
    intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
  }
}
