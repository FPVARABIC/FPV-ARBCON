package com.fpvarbcon.transport

import android.hardware.usb.UsbDeviceConnection
import com.hoho.android.usbserial.driver.UsbSerialPort

/**
 * One successfully opened and configured serial port session. Holds only
 * what's needed to close it again and (Pass 5.2) to read from it - still no
 * write behavior.
 */
internal class UsbSerialSession(
  val sessionId: String,
  val deviceId: Int,
  private val connection: UsbDeviceConnection,
  private val port: UsbSerialPort,
) {
  /**
   * Delegates to the underlying UsbSerialPort's own blocking, timeout-bounded
   * read - this session remains the sole owner of [port], so
   * UsbSerialReadRegistry/SerialReadLoop never hold a UsbSerialPort
   * reference of their own (see SerialReadLoop's class-level note). If
   * [close] has already run, the underlying port is already closed and this
   * throws like any other post-close read would - SerialReadLoop's own
   * token check is what keeps that from ever being reported as an
   * unexpected error (see its class-level note), not any guard here.
   */
  fun read(buffer: ByteArray, timeoutMillis: Int): Int = port.read(buffer, timeoutMillis)

  /**
   * Closes the port first (usb-serial-for-android releases its own claimed
   * interface as part of this), then always closes the connection - even if
   * closing the port throws - so the connection is never left dangling.
   */
  fun close() {
    try {
      port.close()
    } finally {
      connection.close()
    }
  }
}
