package com.fpvarbcon.transport

import android.hardware.usb.UsbDeviceConnection
import com.hoho.android.usbserial.driver.UsbSerialPort

/**
 * One successfully opened and configured serial port session. Holds only
 * what's needed to close it again - no read/write behavior yet.
 */
internal class UsbSerialSession(
  val sessionId: String,
  val deviceId: Int,
  private val connection: UsbDeviceConnection,
  private val port: UsbSerialPort,
) {
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
