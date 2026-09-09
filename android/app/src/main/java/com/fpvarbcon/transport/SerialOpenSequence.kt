package com.fpvarbcon.transport

/**
 * THE ORDER IN WHICH A SERIAL PORT IS OPENED, AND WHAT IS CLOSED WHEN A
 * STEP REFUSES.
 *
 * Four native calls stand between an operator tapping "connect" and a
 * usable link: find the device again, open a connection to it, open the
 * port on that connection (which is where the driver claims the interface
 * and selects its alternate setting), and apply the requested serial
 * parameters. Any one of them can refuse, and each refusal owns a
 * different amount of cleanup:
 *
 *   - the device is gone      -> nothing was opened, nothing to close
 *   - the connection refused  -> nothing was opened, nothing to close
 *   - the port refused        -> the CONNECTION must be closed
 *   - the configuration refused -> the PORT and then the CONNECTION
 *
 * Getting that wrong does not crash. It leaks a USB connection, or an
 * interface stays claimed, and the next connection attempt fails for a
 * reason that has nothing to do with the board - the symptom an operator
 * reports as "it only works after I unplug it".
 *
 * This function is the sequence and the cleanup policy, with the native
 * calls passed in. Nothing here touches Android, so every branch can be
 * driven under fault injection in an ordinary JVM test; the module hands
 * it the real UsbManager, UsbDeviceConnection and UsbSerialPort calls.
 *
 * CLEANUP MAY NEVER REPLACE THE CAUSE. A close that itself fails is
 * absorbed here, because the operator needs to be told the driver rejected
 * their baud rate - not that a tidying-up call they never made failed
 * afterwards. The module's own closeQuietly already swallows, so this
 * changes nothing it does today; it makes the rule hold for any caller and
 * makes it something a test can state.
 *
 * NOT VERIFIED ON REAL HARDWARE.
 */
internal fun <D : Any, C : Any> openSerialConnection(
  deviceId: Int,
  findDevice: () -> D?,
  openConnection: (D) -> C?,
  openPort: (C) -> Unit,
  applyConfiguration: () -> Unit,
  closePortQuietly: () -> Unit,
  closeConnectionQuietly: (C) -> Unit,
): C {
  // 6. Re-fetch and revalidate the full device identity - not deviceId
  // alone. A device that detached while the permission dialog was up, or
  // one that came back as a different board on the same id, must never be
  // opened in place of the one the operator chose.
  val device = findDevice()
    ?: throw UsbTransportException(
      "DEVICE_CHANGED_DURING_OPEN",
      "Device $deviceId was detached or changed while permission was pending.",
    )

  // 7. Open the USB connection.
  val connection = openConnection(device)
    ?: throw UsbTransportException(
      "OPEN_FAILED",
      "Failed to open USB connection for device $deviceId.",
    )

  // 8. Open the serial port. The driver claims the interface and selects
  // its alternate setting inside this call, so a claim refused by another
  // owner surfaces here.
  try {
    openPort(connection)
  } catch (error: Exception) {
    absorbing(closeConnectionQuietly, connection)
    throw UsbTransportException("OPEN_FAILED", error.message ?: "Failed to open serial port.")
  }

  // 9-10. Apply serial parameters and flow control.
  try {
    applyConfiguration()
  } catch (error: Exception) {
    absorbing(closePortQuietly)
    absorbing(closeConnectionQuietly, connection)
    throw UsbTransportException(
      "UNSUPPORTED_SERIAL_CONFIGURATION",
      error.message ?: "Driver rejected the requested serial configuration.",
    )
  }

  return connection
}

/**
 * Runs a cleanup step and discards its own failure. Narrow on purpose:
 * this is only ever applied to a close on a path that is already throwing
 * a decided error, and it is the only place in this file that swallows
 * anything.
 */
private fun absorbing(cleanup: () -> Unit) {
  try {
    cleanup()
  } catch (_: Exception) {
  }
}

private fun <C : Any> absorbing(cleanup: (C) -> Unit, argument: C) {
  try {
    cleanup(argument)
  } catch (_: Exception) {
  }
}
