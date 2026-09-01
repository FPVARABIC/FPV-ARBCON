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
  /** Terminal 'complete' only: whether the board's reset was OBSERVED.
   * Separate from write truth, exactly as on the web engine. */
  val resetConfirmed: Boolean? = null,
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
  private var interfaceNumber = usbInterface.id

  fun run() {
    val connection = usbManager.openDevice(device)
      ?: throw UsbTransportException("DFU_OPEN_FAILED", "Unable to open the DFU device.")
    try {
      /* WHICH INTERFACE/ALTERNATE ACTUALLY GETS FLASHED.
       *
       * Control transfers work on an opened device, so every DFU
       * candidate's memory-layout string is read BEFORE anything is
       * claimed, and the flash target is chosen from that evidence -
       * the region NAMED Internal Flash, else External Flash, else the
       * only writable one. Taking the first DFU alternate, as this used
       * to, aims the whole flash at option bytes on any board that
       * declares them first.
       *
       * The descriptor string is read off the OPENED device FIRST and
       * UsbInterface.name is only a fallback: a real board enumerated
       * with that property empty while its string descriptor carried the
       * layout the whole time. */
      val candidates = dfuInterfaces(device).ifEmpty { listOf(usbInterface) }
      val selection = selectDfuFlashInterface(candidates) { candidate ->
        readInterfaceStringDescriptor(connection, candidate.id, candidate.alternateSetting)
          ?: runCatching { candidate.name }.getOrNull()
      } ?: throw UsbTransportException(
        "DFU_LAYOUT_MISSING",
        "DFU device did not expose a readable memory layout descriptor.",
      )
      val flashInterface = selection.first
      val layout = selection.second
      interfaceNumber = flashInterface.id
      if (!connection.claimInterface(flashInterface, true)) {
        throw UsbTransportException("DFU_CLAIM_FAILED", "Unable to claim the DFU interface.")
      }
      try {
        if (!layout.hasWritableSectors) {
          throw UsbTransportException(
            "DFU_MEMORY_LAYOUT_NOT_WRITABLE",
            "The ${layout.name} region advertises no writable sectors.",
          )
        }
        val transferSize = findDfuTransferSize(
          connection.rawDescriptors,
          flashInterface.id,
          flashInterface.alternateSetting,
        ) ?: DEFAULT_DFU_TRANSFER_SIZE
        // EVERY address is checked against the layout AND against the
        // WRITABLE map before the first erase command leaves the host.
        firmware.segments.forEach { segment ->
          if (!layout.contains(segment.address, segment.data.size)) {
            throw UsbTransportException(
              "DFU_ADDRESS_OUT_OF_RANGE",
              "Firmware address 0x${segment.address.toString(16)} is outside the DFU memory layout.",
            )
          }
          if (!layout.containsWritable(segment.address, segment.data.size)) {
            throw UsbTransportException(
              "DFU_MEMORY_LAYOUT_NOT_WRITABLE",
              "Firmware address 0x${segment.address.toString(16)} falls in a non-writable sector.",
            )
          }
        }
        // A full erase covers only sectors the DEVICE declares erasable -
        // option-byte and OTP regions are never blindly erased.
        val sectors = if (fullErase) {
          layout.sectors.filter { it.erasable }
        } else {
          firmware.segments.flatMap { layout.sectorsOverlapping(it.address, it.data.size) }.distinctBy { it.address }
        }
        sectors.firstOrNull { !it.erasable }?.let { sector ->
          throw UsbTransportException(
            "DFU_MEMORY_LAYOUT_NOT_WRITABLE",
            "Sector at 0x${sector.address.toString(16)} is not erasable; refusing a write that could not be completed.",
          )
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

        onProgress(DfuFlashProgress("finalizing", 99, firmware.totalBytes, firmware.totalBytes))
        ensureIdle(connection)
        // DfuSe manifestation selects the beginning of the programmed image,
        // matching Betaflight Configurator. Intel HEX type-05 may contain a
        // reset-handler PC (including a Thumb bit), not a DfuSe base address.
        setAddress(connection, firmware.segments.first().address)
        onProgress(DfuFlashProgress("manifesting", 99, firmware.totalBytes, firmware.totalBytes))

        /* ---- THE FLASH IS ALREADY DECIDED FROM HERE DOWN ----
         *
         * Every byte has been written, read back and compared equal. The
         * leave command and the reset that follows are facts about USB,
         * not about flash memory, and they may not rewrite what is
         * already verified on the board. The leave DNLOAD used to sit
         * OUTSIDE this tolerance, so a board with bitWillDetach - one
         * that resets on the leave command itself and fails that very
         * transfer - reported DFU_TRANSFER_FAILED after a perfect flash.
         * It is inside now, matching the web engine exactly. */
        runCatching { download(connection, 0, ByteArray(0)) }
        onProgress(DfuFlashProgress("resetting", 99, firmware.totalBytes, firmware.totalBytes))
        runCatching { waitForManifestation(connection) }
        // The reset OBSERVATION: a real bounded wait on UsbManager's own
        // device list, reported separately and never used to invalidate
        // verified bytes.
        val resetConfirmed = awaitDeviceDetach(RESET_OBSERVATION_MS)
        onProgress(
          DfuFlashProgress(
            "complete",
            100,
            firmware.totalBytes,
            firmware.totalBytes,
            resetConfirmed,
          ),
        )
      } finally {
        try {
          connection.releaseInterface(flashInterface)
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

  /**
   * WAITS - bounded - for the board to actually leave the bus after the
   * manifestation. A resetting STM32 stays in UsbManager's device list
   * for a noticeable interval, so a single sample answers "still here"
   * and says nothing true about the reset. Nothing is transmitted inside
   * this wait, and its answer only sets `resetConfirmed`.
   */
  private fun awaitDeviceDetach(timeoutMs: Long): Boolean {
    val deadline = System.nanoTime() + timeoutMs * 1_000_000L
    while (true) {
      val stillAttached = usbManager.deviceList.values.any {
        it.deviceId == device.deviceId &&
          it.vendorId == device.vendorId &&
          it.productId == device.productId
      }
      if (!stillAttached) return true
      if (System.nanoTime() >= deadline) return false
      try {
        Thread.sleep(RESET_POLL_INTERVAL_MS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        return false
      }
    }
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

/**
 * Every DFU-class interface/alternate the device exposes, in declaration
 * order. DfuSe puts each memory region on its own alternate setting, so
 * "the first one" is a guess, not an answer.
 */
internal fun dfuInterfaces(device: UsbDevice): List<UsbInterface> =
  (0 until device.interfaceCount)
    .map(device::getInterface)
    .filter { it.interfaceClass == 0xfe && it.interfaceSubclass == 0x01 }

internal fun findDfuInterface(device: UsbDevice): UsbInterface? = dfuInterfaces(device).firstOrNull()

/**
 * Chooses the interface/alternate to FLASH by the same evidence the web
 * engine uses: the region the device NAMES "Internal Flash", else
 * "External Flash", else the only writable one. Board and vendor names
 * play no part, and a device whose first DFU alternate is option bytes
 * no longer gets flashed at option bytes.
 *
 * `layoutOf` reads a candidate's memory-layout string, and the candidate
 * type is generic, so this decision is exercised by ordinary JVM unit
 * tests with no USB connection and no Android framework classes.
 */
internal fun <T> selectDfuFlashInterface(
  candidates: List<T>,
  layoutOf: (T) -> String?,
): Pair<T, DfuMemoryLayout>? {
  val parsed = candidates.mapNotNull { candidate ->
    val text = layoutOf(candidate) ?: return@mapNotNull null
    val layout = runCatching { DfuMemoryLayout.parse(text) }.getOrNull() ?: return@mapNotNull null
    candidate to layout
  }
  if (parsed.isEmpty()) return null
  fun named(wanted: String) = parsed.firstOrNull {
    it.second.name.trim().lowercase().replace(Regex("\\s+"), " ") == wanted
  }
  named("internal flash")?.let { return it }
  named("external flash")?.let { return it }
  val writable = parsed.filter { it.second.hasWritableSectors }
  return writable.singleOrNull()
}

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
/** Matches DFU_RESET_OBSERVATION_MS on the web engine. */
private const val RESET_OBSERVATION_MS = 8_000L
private const val RESET_POLL_INTERVAL_MS = 250L
private const val MAX_STATUS_POLLS = 100
private const val MAX_SINGLE_POLL_DELAY_MS = 500
