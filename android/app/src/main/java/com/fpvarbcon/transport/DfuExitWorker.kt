package com.fpvarbcon.transport

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager

/** Leaves DfuSe by selecting the application address then sending zero-length DNLOAD. */
internal class DfuExitWorker(
  private val usbManager: UsbManager,
  private val device: UsbDevice,
  private val usbInterface: UsbInterface,
) {
  fun run() {
    val connection = usbManager.openDevice(device)
      ?: throw UsbTransportException("DFU_OPEN_FAILED", "Unable to open the DFU device.")
    try {
      if (!connection.claimInterface(usbInterface, true)) {
        throw UsbTransportException("DFU_CLAIM_FAILED", "Unable to claim the DFU interface.")
      }
      try {
        val command = byteArrayOf(0x21, 0x00, 0x00, 0x00, 0x08)
        val loaded = connection.controlTransfer(0x21, 1, 0, usbInterface.id, command, command.size, 5_000)
        if (loaded != command.size) {
          throw UsbTransportException("DFU_EXIT_FAILED", "Unable to select the application address.")
        }
        val status = ByteArray(6)
        val statusLength = connection.controlTransfer(0xa1, 3, 0, usbInterface.id, status, 6, 5_000)
        if (statusLength == 6) {
          val delay = (status[1].toInt() and 0xff) or
            ((status[2].toInt() and 0xff) shl 8) or
            ((status[3].toInt() and 0xff) shl 16)
          if (delay > 0) Thread.sleep(delay.coerceAtMost(500).toLong())
        }
        val manifested = connection.controlTransfer(0x21, 1, 0, usbInterface.id, null, 0, 2_000)
        if (manifested < 0) {
          val stillAttached = usbManager.deviceList.values.any {
            it.deviceId == device.deviceId && it.vendorId == device.vendorId && it.productId == device.productId
          }
          if (stillAttached) {
            throw UsbTransportException("DFU_EXIT_FAILED", "DFU manifestation request failed without a reset.")
          }
        }
      } finally {
        try {
          connection.releaseInterface(usbInterface)
        } catch (_: Exception) {
        }
      }
    } finally {
      connection.close()
    }
  }
}
