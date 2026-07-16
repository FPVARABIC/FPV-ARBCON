package com.fpvarbcon.transport

import com.facebook.react.bridge.JavaOnlyMap
import com.hoho.android.usbserial.driver.UsbSerialPort
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * JavaOnlyMap is React Native's own plain-JVM ReadableMap/WritableMap
 * implementation, documented for exactly this purpose ("java-only unit
 * tests") - no Android runtime or mocking needed. Built via JavaOnlyMap.of(),
 * the interleaved-key/value factory actually exercised elsewhere in RN's own
 * source (JavaOnlyMap.from(Map) is unused anywhere in RN itself and its
 * vararg-forwarding does not evaluate as a working map constructor - avoided
 * here deliberately).
 */
class SerialConfigurationMapperTest {

  private fun validConfig(
    baudRate: Any? = 115200,
    dataBits: Any? = 8,
    stopBits: Any? = "1",
    parity: Any? = "none",
    flowControl: Any? = "off",
  ): JavaOnlyMap =
    JavaOnlyMap.of(
      "baudRate", baudRate,
      "dataBits", dataBits,
      "stopBits", stopBits,
      "parity", parity,
      "flowControl", flowControl,
    )

  @Test
  fun `parses a fully valid configuration`() {
    val parsed = SerialConfigurationMapper.parse(validConfig())

    assertEquals(115200, parsed.baudRate)
    assertEquals(8, parsed.dataBits)
    assertEquals(UsbSerialPort.STOPBITS_1, parsed.stopBits)
    assertEquals(UsbSerialPort.PARITY_NONE, parsed.parity)
    assertEquals(UsbSerialPort.FlowControl.NONE, parsed.flowControl)
  }

  @Test
  fun `maps stopBits 1_5 to STOPBITS_1_5, not the sequential value 2`() {
    val parsed = SerialConfigurationMapper.parse(validConfig(stopBits = "1.5"))

    assertEquals(UsbSerialPort.STOPBITS_1_5, parsed.stopBits)
    assertEquals(3, parsed.stopBits)
  }

  @Test
  fun `maps every approved parity value`() {
    assertEquals(UsbSerialPort.PARITY_ODD, SerialConfigurationMapper.parse(validConfig(parity = "odd")).parity)
    assertEquals(UsbSerialPort.PARITY_EVEN, SerialConfigurationMapper.parse(validConfig(parity = "even")).parity)
    assertEquals(UsbSerialPort.PARITY_MARK, SerialConfigurationMapper.parse(validConfig(parity = "mark")).parity)
    assertEquals(UsbSerialPort.PARITY_SPACE, SerialConfigurationMapper.parse(validConfig(parity = "space")).parity)
  }

  @Test
  fun `maps every approved flowControl value`() {
    assertEquals(
      UsbSerialPort.FlowControl.RTS_CTS,
      SerialConfigurationMapper.parse(validConfig(flowControl = "rtsCts")).flowControl,
    )
    assertEquals(
      UsbSerialPort.FlowControl.DTR_DSR,
      SerialConfigurationMapper.parse(validConfig(flowControl = "dtrDsr")).flowControl,
    )
    assertEquals(
      UsbSerialPort.FlowControl.XON_XOFF,
      SerialConfigurationMapper.parse(validConfig(flowControl = "xonXoff")).flowControl,
    )
  }

  @Test
  fun `rejects an unrecognized stopBits value as INVALID_CONFIGURATION`() {
    val error =
      assertThrows(UsbTransportException::class.java) {
        SerialConfigurationMapper.parse(validConfig(stopBits = "3"))
      }

    assertEquals("INVALID_CONFIGURATION", error.code)
    assertEquals("stopBits", error.field)
  }

  @Test
  fun `rejects an unrecognized parity value as INVALID_CONFIGURATION`() {
    val error =
      assertThrows(UsbTransportException::class.java) {
        SerialConfigurationMapper.parse(validConfig(parity = "bogus"))
      }

    assertEquals("INVALID_CONFIGURATION", error.code)
    assertEquals("parity", error.field)
  }

  @Test
  fun `rejects an out-of-range dataBits value as INVALID_CONFIGURATION`() {
    val error =
      assertThrows(UsbTransportException::class.java) {
        SerialConfigurationMapper.parse(validConfig(dataBits = 9))
      }

    assertEquals("INVALID_CONFIGURATION", error.code)
    assertEquals("dataBits", error.field)
  }

  @Test
  fun `rejects a non-positive baudRate as INVALID_CONFIGURATION`() {
    val error =
      assertThrows(UsbTransportException::class.java) {
        SerialConfigurationMapper.parse(validConfig(baudRate = 0))
      }

    assertEquals("INVALID_CONFIGURATION", error.code)
    assertEquals("baudRate", error.field)
  }

  @Test
  fun `rejects a missing field as INVALID_CONFIGURATION`() {
    val incomplete = JavaOnlyMap.of("baudRate", 115200, "dataBits", 8)

    val error = assertThrows(UsbTransportException::class.java) { SerialConfigurationMapper.parse(incomplete) }

    assertEquals("INVALID_CONFIGURATION", error.code)
  }

  @Test
  fun `rejects a wrong-typed field as INVALID_CONFIGURATION`() {
    val error =
      assertThrows(UsbTransportException::class.java) {
        SerialConfigurationMapper.parse(validConfig(baudRate = "not-a-number"))
      }

    assertEquals("INVALID_CONFIGURATION", error.code)
    assertEquals("baudRate", error.field)
  }
}
