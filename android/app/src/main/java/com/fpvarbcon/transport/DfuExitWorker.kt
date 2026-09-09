package com.fpvarbcon.transport

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager

/**
 * Leaves DfuSe by selecting the application address then sending
 * zero-length DNLOAD.
 *
 * The protocol itself is [runDfuExit]. This class is the adapter that
 * opens, claims, delegates, releases and closes - see DfuControlChannel
 * for why the two are separated.
 */
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
        runDfuExit(
          channel = androidDfuControlChannel(connection, usbManager, device),
          interfaceId = usbInterface.id,
        )
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

/**
 * THE EXIT SEQUENCE.
 *
 *  1. Select the application base address, 0x08000000, as a DfuSe
 *     set-address command. A short write means the board did not take it
 *     and there is nothing to manifest.
 *  2. Read the status. If the board reports a poll delay, honour it -
 *     capped, because a board is free to report a number that would park
 *     this thread for an unreasonable time and the cap is what stops a
 *     malformed answer becoming a hang. A status frame of the wrong
 *     length is simply no delay, not a failure: manifestation is still
 *     worth attempting.
 *  3. Send the zero-length DNLOAD that manifests. A negative result is
 *     only an error if THE SAME DEVICE IS STILL ATTACHED - the normal,
 *     successful outcome is that the board resets and the request fails
 *     because the device it was aimed at no longer exists. Treating that
 *     as a failure would report an error for the exact thing this worker
 *     is asking the board to do.
 */
internal fun runDfuExit(channel: DfuControlChannel, interfaceId: Int) {
  val command = byteArrayOf(DFUSE_SET_ADDRESS, 0x00, 0x00, 0x00, 0x08)
  val loaded = channel.controlTransfer(
    DFU_REQUEST_TYPE_OUT,
    DFU_DNLOAD,
    0,
    interfaceId,
    command,
    command.size,
    CONTROL_TIMEOUT_MS,
  )
  if (loaded != command.size) {
    throw UsbTransportException("DFU_EXIT_FAILED", "Unable to select the application address.")
  }

  val status = ByteArray(DFU_STATUS_LENGTH)
  val statusLength = channel.controlTransfer(
    DFU_REQUEST_TYPE_IN,
    DFU_GETSTATUS,
    0,
    interfaceId,
    status,
    DFU_STATUS_LENGTH,
    CONTROL_TIMEOUT_MS,
  )
  if (statusLength == DFU_STATUS_LENGTH) {
    val delay = (status[1].toInt() and 0xff) or
      ((status[2].toInt() and 0xff) shl 8) or
      ((status[3].toInt() and 0xff) shl 16)
    if (delay > 0) channel.sleep(delay.coerceAtMost(MAX_EXIT_POLL_DELAY_MS).toLong())
  }

  val manifested = channel.controlTransfer(
    DFU_REQUEST_TYPE_OUT,
    DFU_DNLOAD,
    0,
    interfaceId,
    null,
    0,
    MANIFEST_TIMEOUT_MS,
  )
  if (manifested < 0 && channel.isSameDeviceAttached()) {
    throw UsbTransportException("DFU_EXIT_FAILED", "DFU manifestation request failed without a reset.")
  }
}

private const val DFU_REQUEST_TYPE_OUT = 0x21
private const val DFU_REQUEST_TYPE_IN = 0xa1
private const val DFU_DNLOAD = 1
private const val DFU_GETSTATUS = 3
private const val DFU_STATUS_LENGTH = 6
private const val DFUSE_SET_ADDRESS: Byte = 0x21
private const val CONTROL_TIMEOUT_MS = 5_000
private const val MANIFEST_TIMEOUT_MS = 2_000
internal const val MAX_EXIT_POLL_DELAY_MS = 500
