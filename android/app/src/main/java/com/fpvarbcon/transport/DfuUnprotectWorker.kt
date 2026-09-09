package com.fpvarbcon.transport

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager

/**
 * Sends the DfuSe read-unprotect command. STM32 ROM erases protected flash
 * and normally disconnects/reset afterwards, so success is intentionally
 * defined as an accepted command followed by the normal busy erase window
 * and then a reset/stall, or the physical disappearance of the same USB
 * identity. The extra erase guard matches Betaflight's own safety delay and
 * runs only on this worker thread, never the Android UI thread.
 *
 * The protocol itself is [runDfuUnprotect]. This class is the adapter that
 * opens, claims, delegates, releases and closes - see DfuControlChannel for
 * why the two are separated.
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
        runDfuUnprotect(
          channel = androidDfuControlChannel(connection, usbManager, device),
          interfaceId = usbInterface.id,
        )
      } finally {
        runCatching { connection.releaseInterface(usbInterface) }
      }
    } finally {
      connection.close()
    }
  }
}

/** Binds the interface to a real Android connection. */
internal fun androidDfuControlChannel(
  connection: UsbDeviceConnection,
  usbManager: UsbManager,
  device: UsbDevice,
): DfuControlChannel = object : DfuControlChannel {
  override fun controlTransfer(
    requestType: Int,
    request: Int,
    value: Int,
    index: Int,
    buffer: ByteArray?,
    length: Int,
    timeoutMs: Int,
  ): Int = connection.controlTransfer(requestType, request, value, index, buffer, length, timeoutMs)

  override fun isSameDeviceAttached(): Boolean = usbManager.deviceList.values.any {
    it.deviceId == device.deviceId &&
      it.vendorId == device.vendorId &&
      it.productId == device.productId
  }

  override fun sleep(millis: Long) = Thread.sleep(millis)
}

/**
 * THE READ-UNPROTECT SEQUENCE.
 *
 * Every step below is a safety rule, not a formality:
 *
 *  1. The command must be ACCEPTED. A short write means the board never
 *     took the instruction, and continuing would wait out an erase window
 *     for an erase that was never started.
 *  2. The board must then report DNLOAD_BUSY. That is the board saying it
 *     has BEGUN erasing. Any other state is a refusal and is reported with
 *     the state and status bytes so the operator sees what the board said,
 *     not a generic failure. A missing status frame is only acceptable if
 *     the same device has already vanished - which is a completed
 *     unprotect that reset itself, and is the one case where silence means
 *     success.
 *  3. The erase window is WAITED OUT IN FULL: the board's own reported
 *     delay, capped, PLUS a fixed safety guard. Cutting this short is the
 *     dangerous mistake, because the flash is mid-erase and the board is
 *     unresponsive.
 *  4. Only then is the outcome read. A stall, or the same device having
 *     disappeared, is success - STM32 ROM resets after unprotecting, and
 *     Android's device list lags that reset. Anything else means the erase
 *     window passed and the board neither reset nor returned to idle,
 *     which is a real failure.
 */
internal fun runDfuUnprotect(channel: DfuControlChannel, interfaceId: Int) {
  fun readStatus(): ByteArray? {
    val status = ByteArray(DFU_STATUS_LENGTH)
    val received = channel.controlTransfer(
      DFU_REQUEST_TYPE_IN,
      DFU_GETSTATUS,
      0,
      interfaceId,
      status,
      status.size,
      CONTROL_TIMEOUT_MS,
    )
    return if (received == status.size) status else null
  }

  val sent = channel.controlTransfer(
    DFU_REQUEST_TYPE_OUT,
    DFU_DNLOAD,
    0,
    interfaceId,
    byteArrayOf(DFUSE_READ_UNPROTECT),
    1,
    CONTROL_TIMEOUT_MS,
  )
  if (sent != 1) {
    throw UsbTransportException("DFU_UNPROTECT_FAILED", "Read-unprotect command was not accepted.")
  }

  val initialStatus = readStatus()
  if (initialStatus == null) {
    if (!channel.isSameDeviceAttached()) return
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
  channel.sleep(reportedDelay.coerceAtMost(MAX_REPORTED_ERASE_DELAY_MS).toLong() + ERASE_SAFETY_DELAY_MS)

  // A stall is the expected post-unprotect result because STM32 ROM
  // resets/disconnects. Android's device list can lag that reset, so a
  // failed GETSTATUS after the guarded erase window is success too.
  val finalStatus = readStatus() ?: return
  if (!channel.isSameDeviceAttached()) return
  when (finalStatus[4].toInt() and 0xff) {
    DFU_STATE_IDLE, DFU_STATE_MANIFEST_WAIT_RESET -> return
    else -> throw UsbTransportException(
      "DFU_UNPROTECT_FAILED",
      "Read-unprotect completed its erase window but the device did not reset.",
    )
  }
}

private const val DFU_REQUEST_TYPE_OUT = 0x21
private const val DFU_REQUEST_TYPE_IN = 0xa1
private const val DFU_DNLOAD = 1
private const val DFU_GETSTATUS = 3
private const val DFU_STATUS_LENGTH = 6
private const val DFU_STATE_IDLE = 2
private const val DFU_STATE_DNLOAD_BUSY = 4
private const val DFU_STATE_MANIFEST_WAIT_RESET = 8
private const val DFUSE_READ_UNPROTECT: Byte = 0x92.toByte()
private const val CONTROL_TIMEOUT_MS = 5_000
internal const val MAX_REPORTED_ERASE_DELAY_MS = 30_000
internal const val ERASE_SAFETY_DELAY_MS = 20_000L
