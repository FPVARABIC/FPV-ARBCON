package com.fpvarbcon.transport

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager

/**
 * Sends the DfuSe read-unprotect command. STM32 ROM erases protected flash
 * and normally disconnects/reset afterwards, so success is intentionally
 * defined as an accepted command followed by the normal busy erase window
 * and then a reset/stall, or the physical disappearance of the same USB
 * identity. The extra erase guard matches Betaflight's own safety delay and
 * runs only on this worker thread, never the Android UI thread.
 */
internal class DfuUnprotectWorker(
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
        val sent = connection.controlTransfer(
          0x21,
          DFU_DNLOAD,
          0,
          usbInterface.id,
          byteArrayOf(DFUSE_READ_UNPROTECT),
          1,
          CONTROL_TIMEOUT_MS,
        )
        if (sent != 1) throw UsbTransportException("DFU_UNPROTECT_FAILED", "Read-unprotect command was not accepted.")
        val initialStatus = readStatus(connection)
        if (initialStatus == null) {
          if (!sameDeviceAttached()) return
          throw UsbTransportException("DFU_UNPROTECT_FAILED", "DFU did not enter the read-unprotect erase state.")
        }
        if ((initialStatus[4].toInt() and 0xff) != DFU_STATE_DNLOAD_BUSY) {
          throw UsbTransportException(
            "DFU_UNPROTECT_FAILED",
            "DFU rejected read-unprotect with state ${initialStatus[4].toInt() and 0xff} and status ${initialStatus[0].toInt() and 0xff}.",
          )
        }
        val reportedDelay = (initialStatus[1].toInt() and 0xff) or
          ((initialStatus[2].toInt() and 0xff) shl 8) or
          ((initialStatus[3].toInt() and 0xff) shl 16)
        Thread.sleep(reportedDelay.coerceAtMost(MAX_REPORTED_ERASE_DELAY_MS).toLong() + ERASE_SAFETY_DELAY_MS)

        // A stall is the expected post-unprotect result because STM32 ROM
        // resets/disconnects. Android's device list can lag that reset, so a
        // failed GETSTATUS after the guarded erase window is success too.
        val finalStatus = readStatus(connection) ?: return
        if (!sameDeviceAttached()) return
        when (finalStatus[4].toInt() and 0xff) {
          DFU_STATE_IDLE, DFU_STATE_MANIFEST_WAIT_RESET -> return
          else -> throw UsbTransportException(
            "DFU_UNPROTECT_FAILED",
            "Read-unprotect completed its erase window but the device did not reset.",
          )
        }
      } finally {
        runCatching { connection.releaseInterface(usbInterface) }
      }
    } finally {
      connection.close()
    }
  }

  private fun readStatus(connection: android.hardware.usb.UsbDeviceConnection): ByteArray? {
    val status = ByteArray(6)
    val received = connection.controlTransfer(
      0xa1,
      DFU_GETSTATUS,
      0,
      usbInterface.id,
      status,
      status.size,
      CONTROL_TIMEOUT_MS,
    )
    return if (received == status.size) status else null
  }

  private fun sameDeviceAttached(): Boolean = usbManager.deviceList.values.any {
    it.deviceId == device.deviceId && it.vendorId == device.vendorId && it.productId == device.productId
  }
}

private const val DFU_DNLOAD = 1
private const val DFU_GETSTATUS = 3
private const val DFU_STATE_IDLE = 2
private const val DFU_STATE_DNLOAD_BUSY = 4
private const val DFU_STATE_MANIFEST_WAIT_RESET = 8
private const val DFUSE_READ_UNPROTECT: Byte = 0x92.toByte()
private const val CONTROL_TIMEOUT_MS = 5_000
private const val MAX_REPORTED_ERASE_DELAY_MS = 30_000
private const val ERASE_SAFETY_DELAY_MS = 20_000L
