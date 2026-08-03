package com.fpvarbcon.transport

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

internal data class DfuFlashProgress(
  val phase: String,
  val percent: Int,
  val bytesProcessed: Int,
  val totalBytes: Int,
)

/** Blocking DfuSe state machine. It is always run on a dedicated background thread. */
internal class DfuFlashWorker(
  private val usbManager: UsbManager,
  private val device: UsbDevice,
  private val usbInterface: UsbInterface,
  private val firmware: IntelHexFirmware,
  private val fullErase: Boolean,
  private val cancelled: AtomicBoolean,
  private val onProgress: (DfuFlashProgress) -> Unit,
) {
  private val interfaceNumber = usbInterface.id

  fun run() {
    val connection = usbManager.openDevice(device)
      ?: throw UsbTransportException("DFU_OPEN_FAILED", "Unable to open the DFU device.")
    try {
      if (!connection.claimInterface(usbInterface, true)) {
        throw UsbTransportException("DFU_CLAIM_FAILED", "Unable to claim the DFU interface.")
      }
      try {
        val layoutText = runCatching { usbInterface.name }.getOrNull()
          ?: readInterfaceStringDescriptor(connection, usbInterface.id, usbInterface.alternateSetting)
          ?: throw UsbTransportException(
            "DFU_LAYOUT_MISSING",
            "DFU device did not expose a readable memory layout descriptor.",
          )
        val layout = try {
          DfuMemoryLayout.parse(layoutText)
        } catch (error: IllegalArgumentException) {
          throw UsbTransportException("DFU_LAYOUT_INVALID", error.message ?: "DFU memory layout is invalid.")
        }
        val transferSize = findDfuTransferSize(
          connection.rawDescriptors,
          usbInterface.id,
          usbInterface.alternateSetting,
        ) ?: DEFAULT_DFU_TRANSFER_SIZE
        firmware.segments.forEach { segment ->
          if (!layout.contains(segment.address, segment.data.size)) {
            throw UsbTransportException(
              "DFU_ADDRESS_OUT_OF_RANGE",
              "Firmware address 0x${segment.address.toString(16)} is outside the DFU memory layout.",
            )
          }
        }
        val sectors = if (fullErase) {
          layout.sectors
        } else {
          firmware.segments.flatMap { layout.sectorsOverlapping(it.address, it.data.size) }.distinctBy { it.address }
        }
        checkCancelled()
        ensureIdle(connection)
        onProgress(DfuFlashProgress("erasing", 0, 0, firmware.totalBytes))
        sectors.forEachIndexed { index, sector ->
          checkCancelled()
          command(connection, byteArrayOf(DFUSE_ERASE, *u32le(sector.address)))
          waitForDownloadIdle(connection)
          onProgress(
            DfuFlashProgress(
              "erasing",
              ((index + 1) * 20 / sectors.size.coerceAtLeast(1)).coerceAtMost(20),
              0,
              firmware.totalBytes,
            ),
          )
        }

        var written = 0
        for (segment in firmware.segments) {
          ensureIdle(connection)
          setAddress(connection, segment.address)
          var blockNumber = 2
          var offset = 0
          while (offset < segment.data.size) {
            checkCancelled()
            val length = minOf(transferSize, segment.data.size - offset)
            download(connection, blockNumber, segment.data.copyOfRange(offset, offset + length))
            waitForDownloadIdle(connection)
            offset += length
            written += length
            blockNumber += 1
            onProgress(
              DfuFlashProgress(
                "writing",
                20 + (written * 55 / firmware.totalBytes),
                written,
                firmware.totalBytes,
              ),
            )
          }
        }

        var verified = 0
        for (segment in firmware.segments) {
          ensureIdle(connection)
          setAddress(connection, segment.address)
          ensureIdle(connection)
          var blockNumber = 2
          var offset = 0
          while (offset < segment.data.size) {
            checkCancelled()
            val length = minOf(transferSize, segment.data.size - offset)
            val actual = upload(connection, blockNumber, length)
            if (actual.size != length) {
              throw UsbTransportException("DFU_VERIFY_FAILED", "DFU read-back returned a short block.")
            }
            for (index in actual.indices) {
              if (actual[index] != segment.data[offset + index]) {
                throw UsbTransportException(
                  "DFU_VERIFY_FAILED",
                  "DFU read-back mismatch at 0x${(segment.address + offset + index).toString(16)}.",
                )
              }
            }
            offset += length
            verified += length
            blockNumber += 1
            onProgress(
              DfuFlashProgress(
                "verifying",
                75 + (verified * 24 / firmware.totalBytes),
                verified,
                firmware.totalBytes,
              ),
            )
          }
        }

        ensureIdle(connection)
        // DfuSe manifestation selects the beginning of the programmed image,
        // matching Betaflight Configurator. Intel HEX type-05 may contain a
        // reset-handler PC (including a Thumb bit), not a DfuSe base address.
        setAddress(connection, firmware.segments.first().address)
        download(connection, 0, ByteArray(0))
        // A manifestation-tolerant device reports status; another immediately disconnects.
        try {
          waitForManifestation(connection)
        } catch (error: UsbTransportException) {
          val stillAttached = usbManager.deviceList.values.any {
            it.deviceId == device.deviceId && it.vendorId == device.vendorId && it.productId == device.productId
          }
          if (error.code != "DFU_STATUS_FAILED" || stillAttached) throw error
        }
        onProgress(DfuFlashProgress("complete", 100, firmware.totalBytes, firmware.totalBytes))
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

  private fun setAddress(connection: android.hardware.usb.UsbDeviceConnection, address: Long) {
    command(connection, byteArrayOf(DFUSE_SET_ADDRESS, *u32le(address)))
    waitForDownloadIdle(connection)
  }

  private fun command(connection: android.hardware.usb.UsbDeviceConnection, data: ByteArray) =
    download(connection, 0, data)

  private fun download(
    connection: android.hardware.usb.UsbDeviceConnection,
    blockNumber: Int,
    data: ByteArray,
  ) {
    checkCancelled()
    val result = connection.controlTransfer(
      0x21,
      DFU_DNLOAD,
      blockNumber,
      interfaceNumber,
      data,
      data.size,
      CONTROL_TIMEOUT_MS,
    )
    if (result != data.size) {
      throw UsbTransportException("DFU_TRANSFER_FAILED", "DFU download transfer failed or was incomplete.")
    }
  }

  private fun upload(
    connection: android.hardware.usb.UsbDeviceConnection,
    blockNumber: Int,
    length: Int,
  ): ByteArray {
    val buffer = ByteArray(length)
    val result = connection.controlTransfer(
      0xa1,
      DFU_UPLOAD,
      blockNumber,
      interfaceNumber,
      buffer,
      length,
      CONTROL_TIMEOUT_MS,
    )
    if (result < 0) {
      throw UsbTransportException("DFU_TRANSFER_FAILED", "DFU upload transfer failed.")
    }
    return buffer.copyOf(result)
  }

  private fun status(connection: android.hardware.usb.UsbDeviceConnection): ByteArray {
    val buffer = ByteArray(6)
    val result = connection.controlTransfer(0xa1, DFU_GETSTATUS, 0, interfaceNumber, buffer, 6, CONTROL_TIMEOUT_MS)
    if (result != 6) {
      throw UsbTransportException("DFU_STATUS_FAILED", "DFU GETSTATUS returned an invalid response.")
    }
    return buffer
  }

  private fun ensureIdle(connection: android.hardware.usb.UsbDeviceConnection) {
    repeat(MAX_STATUS_POLLS) {
      checkCancelled()
      val status = status(connection)
      sleepPoll(status)
      when (status[4].toInt() and 0xff) {
        DFU_STATE_IDLE -> return
        DFU_STATE_ERROR -> controlNoData(connection, DFU_CLRSTATUS)
        DFU_STATE_DNLOAD_IDLE, DFU_STATE_UPLOAD_IDLE -> controlNoData(connection, DFU_ABORT)
      }
    }
    throw UsbTransportException("DFU_STATUS_TIMEOUT", "DFU device did not return to idle state.")
  }

  private fun waitForDownloadIdle(connection: android.hardware.usb.UsbDeviceConnection) {
    repeat(MAX_STATUS_POLLS) {
      checkCancelled()
      val status = status(connection)
      sleepPoll(status)
      when (status[4].toInt() and 0xff) {
        DFU_STATE_DNLOAD_IDLE -> return
        DFU_STATE_ERROR -> throw UsbTransportException("DFU_DEVICE_ERROR", "DFU device reported status ${status[0].toInt() and 0xff}.")
      }
    }
    throw UsbTransportException("DFU_STATUS_TIMEOUT", "DFU write did not reach download-idle state.")
  }

  private fun waitForManifestation(connection: android.hardware.usb.UsbDeviceConnection) {
    repeat(MAX_STATUS_POLLS) {
      checkCancelled()
      val status = status(connection)
      sleepPoll(status)
      when (status[4].toInt() and 0xff) {
        DFU_STATE_IDLE, DFU_STATE_MANIFEST_WAIT_RESET -> return
        DFU_STATE_ERROR -> throw UsbTransportException("DFU_DEVICE_ERROR", "DFU manifestation failed.")
      }
    }
    throw UsbTransportException("DFU_STATUS_TIMEOUT", "DFU manifestation did not complete in time.")
  }

  private fun controlNoData(connection: android.hardware.usb.UsbDeviceConnection, request: Int) {
    val result = connection.controlTransfer(0x21, request, 0, interfaceNumber, null, 0, CONTROL_TIMEOUT_MS)
    if (result < 0) throw UsbTransportException("DFU_TRANSFER_FAILED", "DFU control request $request failed.")
  }

  private fun sleepPoll(status: ByteArray) {
    val reported = (status[1].toInt() and 0xff) or
      ((status[2].toInt() and 0xff) shl 8) or
      ((status[3].toInt() and 0xff) shl 16)
    if (reported > 0) Thread.sleep(reported.coerceAtMost(MAX_SINGLE_POLL_DELAY_MS).toLong())
  }

  private fun checkCancelled() {
    if (cancelled.get()) throw CancellationException("DFU flash cancelled.")
  }

  private fun u32le(value: Long): ByteArray = byteArrayOf(
    (value and 0xff).toByte(),
    ((value ushr 8) and 0xff).toByte(),
    ((value ushr 16) and 0xff).toByte(),
    ((value ushr 24) and 0xff).toByte(),
  )
}

internal fun isSupportedDfuDevice(device: UsbDevice): Boolean =
  (device.vendorId to device.productId) in SUPPORTED_DFU_IDS

internal fun findDfuInterface(device: UsbDevice): UsbInterface? =
  (0 until device.interfaceCount)
    .map(device::getInterface)
    .firstOrNull { it.interfaceClass == 0xfe && it.interfaceSubclass == 0x01 }

private val SUPPORTED_DFU_IDS = setOf(
  0x0483 to 0xdf11,
  0x28e9 to 0x0189,
  0x2e3c to 0xdf11,
  0x314b to 0x0106,
  0x3997 to 0xdf11,
)

private const val DFU_DNLOAD = 1
private const val DFU_UPLOAD = 2
private const val DFU_GETSTATUS = 3
private const val DFU_CLRSTATUS = 4
private const val DFU_ABORT = 6
private const val DFU_STATE_IDLE = 2
private const val DFU_STATE_DNLOAD_IDLE = 5
private const val DFU_STATE_MANIFEST_WAIT_RESET = 8
private const val DFU_STATE_UPLOAD_IDLE = 9
private const val DFU_STATE_ERROR = 10
private const val DFUSE_SET_ADDRESS: Byte = 0x21
private const val DFUSE_ERASE: Byte = 0x41
private const val DEFAULT_DFU_TRANSFER_SIZE = 2048
private const val CONTROL_TIMEOUT_MS = 5_000
private const val MAX_STATUS_POLLS = 100
private const val MAX_SINGLE_POLL_DELAY_MS = 500
