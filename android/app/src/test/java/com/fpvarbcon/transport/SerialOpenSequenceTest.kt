package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FAULT INJECTION ACROSS THE NATIVE OPEN SEQUENCE, ONE STEP AT A TIME.
 *
 * [openSerialConnection] is the order in which a serial port is opened and
 * the policy for what is closed when a step refuses. Until it was lifted
 * out of the module those four native calls could not be reached from a
 * JVM test at all: they need a UsbManager, a UsbDeviceConnection and a
 * driver, none of which exist off a device. So the branch that decides
 * whether a failed configuration leaks a USB connection had never been
 * executed by anything.
 *
 * Every case below injects exactly ONE refusal and then asserts three
 * things that a leak would break: which native calls ran, which cleanups
 * ran and in what order, and which operator-facing code and message came
 * out. The fakes record; they do not assert - what is claimed is claimed
 * here.
 *
 * NOT VERIFIED ON REAL HARDWARE: no USB device, driver or board is
 * involved. What is proven is the sequence and its cleanup, not any
 * particular driver's behaviour.
 */
class SerialOpenSequenceTest {

  private class FakeDevice(val label: String)

  private class FakeConnection(val label: String)

  /** What actually happened, in the order it happened. */
  private val log = mutableListOf<String>()

  private val device = FakeDevice("board")
  private val connection = FakeConnection("connection")

  private fun open(
    findDevice: () -> FakeDevice? = { device.also { log += "find" } },
    openConnection: (FakeDevice) -> FakeConnection? = { connection.also { log += "openConnection" } },
    openPort: (FakeConnection) -> Unit = { log += "openPort" },
    applyConfiguration: () -> Unit = { log += "configure" },
    closePortQuietly: () -> Unit = { log += "closePort" },
    closeConnectionQuietly: (FakeConnection) -> Unit = { log += "closeConnection(${it.label})" },
  ): FakeConnection = openSerialConnection(
    deviceId = 7,
    findDevice = findDevice,
    openConnection = openConnection,
    openPort = openPort,
    applyConfiguration = applyConfiguration,
    closePortQuietly = closePortQuietly,
    closeConnectionQuietly = closeConnectionQuietly,
  )

  // ===================================================================
  // The path with no faults, which every failure case is measured against
  // ===================================================================

  @Test
  fun `the happy path finds, opens, opens the port and configures - in that order, closing nothing`() {
    val opened = open()

    assertEquals(listOf("find", "openConnection", "openPort", "configure"), log)
    assertSame("the connection returned is not the one that was opened", connection, opened)
  }

  @Test
  fun `the sequence carries no state - a second attempt after a failure behaves like the first`() {
    assertThrows(UsbTransportException::class.java) {
      open(openPort = { log += "openPort"; throw IllegalStateException("busy") })
    }
    log.clear()

    val opened = open()
    assertEquals(listOf("find", "openConnection", "openPort", "configure"), log)
    assertSame(connection, opened)
  }

  // ===================================================================
  // Step 6: the device is gone, or came back as something else
  // ===================================================================

  @Test
  fun `a device that is no longer present is DEVICE_CHANGED_DURING_OPEN and nothing is opened`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(findDevice = { log += "find"; null })
    }

    assertEquals("DEVICE_CHANGED_DURING_OPEN", error.code)
    assertEquals(
      "something was opened for a device that is not there",
      listOf("find"),
      log,
    )
  }

  @Test
  fun `the detached-device refusal names the device the operator chose`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(findDevice = { null })
    }
    assertTrue(
      "the operator cannot tell which device this is about: ${error.message}",
      error.message!!.contains("Device 7"),
    )
  }

  // ===================================================================
  // Step 7: the platform refuses a connection
  // ===================================================================

  @Test
  fun `a connection the platform refuses is OPEN_FAILED and there is nothing to close`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(openConnection = { log += "openConnection"; null })
    }

    assertEquals("OPEN_FAILED", error.code)
    assertEquals(
      "a connection that was never opened was closed anyway",
      listOf("find", "openConnection"),
      log,
    )
  }

  // ===================================================================
  // Step 8: the port refuses - this is where the interface is claimed
  // ===================================================================

  @Test
  fun `a port that refuses to open closes the connection exactly once and never the port`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(openPort = { log += "openPort"; throw IllegalStateException("interface already claimed") })
    }

    assertEquals("OPEN_FAILED", error.code)
    assertEquals(
      "a port that never opened was closed, or the connection was leaked",
      listOf("find", "openConnection", "openPort", "closeConnection(connection)"),
      log,
    )
  }

  @Test
  fun `a port refusal carries the driver's own message`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(openPort = { throw IllegalStateException("interface already claimed") })
    }
    assertEquals("interface already claimed", error.message)
  }

  @Test
  fun `a message-less port refusal still yields a sentence rather than an empty rejection`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(openPort = { throw IllegalStateException() })
    }
    assertEquals("Failed to open serial port.", error.message)
  }

  @Test
  fun `the connection that is closed after a port refusal is the one that was opened`() {
    // Two candidates, so "it closed a connection" is not enough: it has to
    // close THIS one. A cleanup that reached for a stale reference would
    // leave the live connection open and close somebody else's.
    val stale = FakeConnection("stale")
    val live = FakeConnection("live")
    val closed = mutableListOf<FakeConnection>()

    assertThrows(UsbTransportException::class.java) {
      open(
        openConnection = { live },
        openPort = { throw IllegalStateException("no") },
        closeConnectionQuietly = { closed += it },
      )
    }

    assertEquals("exactly one connection should have been closed", 1, closed.size)
    assertSame("the wrong connection was closed", live, closed.single())
    assertTrue("a connection that was never opened was closed", stale !in closed)
  }

  // ===================================================================
  // Steps 9-10: the driver rejects the requested serial parameters
  // ===================================================================

  @Test
  fun `a rejected configuration closes the port and then the connection, exactly once each`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(applyConfiguration = { log += "configure"; throw IllegalArgumentException("baud 921600 unsupported") })
    }

    assertEquals("UNSUPPORTED_SERIAL_CONFIGURATION", error.code)
    assertEquals(
      "a rejected configuration must close the port it opened and then the connection under it",
      listOf(
        "find",
        "openConnection",
        "openPort",
        "configure",
        "closePort",
        "closeConnection(connection)",
      ),
      log,
    )
  }

  @Test
  fun `a rejected configuration carries the driver's own message under its own code`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(applyConfiguration = { throw IllegalArgumentException("baud 921600 unsupported") })
    }
    assertEquals("UNSUPPORTED_SERIAL_CONFIGURATION", error.code)
    assertEquals("baud 921600 unsupported", error.message)
  }

  @Test
  fun `a message-less configuration refusal still yields a sentence`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(applyConfiguration = { throw IllegalArgumentException() })
    }
    assertEquals("Driver rejected the requested serial configuration.", error.message)
  }

  @Test
  fun `configuration is never attempted before the port has opened`() {
    assertThrows(UsbTransportException::class.java) {
      open(openPort = { log += "openPort"; throw IllegalStateException("no") })
    }
    assertTrue("the driver was configured through a port that never opened", "configure" !in log)
  }

  // ===================================================================
  // Cleanup may never replace the cause
  // ===================================================================

  @Test
  fun `a close that itself fails does not replace the configuration refusal`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(
        applyConfiguration = { throw IllegalArgumentException("baud 921600 unsupported") },
        closePortQuietly = { log += "closePort"; throw IllegalStateException("close failed") },
        closeConnectionQuietly = { log += "closeConnection"; throw IllegalStateException("close failed too") },
      )
    }

    assertEquals("UNSUPPORTED_SERIAL_CONFIGURATION", error.code)
    assertEquals("baud 921600 unsupported", error.message)
    assertEquals(
      "a failing close stopped the other cleanup from running",
      listOf("find", "openConnection", "openPort", "closePort", "closeConnection"),
      log,
    )
  }

  @Test
  fun `a close that itself fails does not replace the port refusal`() {
    val error = assertThrows(UsbTransportException::class.java) {
      open(
        openPort = { throw IllegalStateException("interface already claimed") },
        closeConnectionQuietly = { log += "closeConnection"; throw IllegalStateException("close failed") },
      )
    }

    assertEquals("OPEN_FAILED", error.code)
    assertEquals("interface already claimed", error.message)
    assertEquals(listOf("find", "openConnection", "closeConnection"), log)
  }

  // ===================================================================
  // No false success
  // ===================================================================

  @Test
  fun `no refusal anywhere in the sequence can return a connection`() {
    val refusals = listOf<Pair<String, () -> Unit>>(
      "device gone" to { open(findDevice = { null }) },
      "connection refused" to { open(openConnection = { null }) },
      "port refused" to { open(openPort = { throw IllegalStateException("no") }) },
      "configuration refused" to { open(applyConfiguration = { throw IllegalArgumentException("no") }) },
    )

    for ((name, attempt) in refusals) {
      log.clear()
      val error = assertThrows(
        "$name returned a connection instead of refusing",
        UsbTransportException::class.java,
      ) { attempt() }
      assertTrue(
        "$name produced an empty operator message",
        !error.message.isNullOrBlank(),
      )
    }
  }

  /**
   * The fakes are a real subject: this proves the recorder would have
   * shown a missing cleanup, so an assertion above that expects one is not
   * passing vacuously.
   */
  @Test
  fun `the recorder distinguishes a cleanup that ran from one that did not`() {
    assertThrows(UsbTransportException::class.java) {
      open(openPort = { throw IllegalStateException("no") }, closeConnectionQuietly = { /* leaked */ })
    }
    assertTrue(
      "the recorder logged a cleanup that was never performed",
      log.none { it.startsWith("closeConnection") },
    )
  }
}
