package com.fpvarbcon.transport

import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.hoho.android.usbserial.driver.UsbSerialPort

/**
 * Native-side parameters ready to pass to UsbSerialPort.setParameters()/
 * setFlowControl(). All native constant knowledge (STOPBITS_*, PARITY_*,
 * FlowControl) lives only here - JS never sees these values.
 */
internal data class ParsedSerialConfiguration(
  val baudRate: Int,
  val dataBits: Int,
  val stopBits: Int,
  val parity: Int,
  val flowControl: UsbSerialPort.FlowControl,
)

/**
 * Validates and maps the JS-facing SerialConfiguration (delivered as a
 * ReadableMap - Android Codegen does not generate a typed nested class for
 * object parameters) to native usb-serial-for-android constants.
 *
 * Anything outside the approved application contract (missing field, wrong
 * type, unrecognized string/number) throws INVALID_CONFIGURATION. Whether
 * the *driver/hardware* actually accepts an otherwise-valid configuration is
 * a separate question, answered later by UsbSerialPort.setParameters()/
 * setFlowControl() themselves - this mapper never decides that.
 */
internal object SerialConfigurationMapper {

  fun parse(configuration: ReadableMap): ParsedSerialConfiguration {
    val baudRate = readInt(configuration, "baudRate")
    if (baudRate <= 0) throw invalid("baudRate", baudRate.toString())

    val dataBits = readInt(configuration, "dataBits")
    if (dataBits != 5 && dataBits != 6 && dataBits != 7 && dataBits != 8) {
      throw invalid("dataBits", dataBits.toString())
    }

    val stopBitsValue = readString(configuration, "stopBits")
    val stopBits =
      when (stopBitsValue) {
        "1" -> UsbSerialPort.STOPBITS_1
        "1.5" -> UsbSerialPort.STOPBITS_1_5
        "2" -> UsbSerialPort.STOPBITS_2
        else -> throw invalid("stopBits", stopBitsValue)
      }

    val parityValue = readString(configuration, "parity")
    val parity =
      when (parityValue) {
        "none" -> UsbSerialPort.PARITY_NONE
        "odd" -> UsbSerialPort.PARITY_ODD
        "even" -> UsbSerialPort.PARITY_EVEN
        "mark" -> UsbSerialPort.PARITY_MARK
        "space" -> UsbSerialPort.PARITY_SPACE
        else -> throw invalid("parity", parityValue)
      }

    val flowControlValue = readString(configuration, "flowControl")
    val flowControl =
      when (flowControlValue) {
        "off" -> UsbSerialPort.FlowControl.NONE
        "rtsCts" -> UsbSerialPort.FlowControl.RTS_CTS
        "dtrDsr" -> UsbSerialPort.FlowControl.DTR_DSR
        "xonXoff" -> UsbSerialPort.FlowControl.XON_XOFF
        else -> throw invalid("flowControl", flowControlValue)
      }

    return ParsedSerialConfiguration(baudRate, dataBits, stopBits, parity, flowControl)
  }

  private fun invalid(field: String, value: String?): UsbTransportException =
    UsbTransportException("INVALID_CONFIGURATION", "Invalid value for '$field': $value", field)

  private fun readInt(map: ReadableMap, key: String): Int {
    if (!map.hasKey(key) || map.getType(key) != ReadableType.Number) throw invalid(key, null)
    return map.getDouble(key).toInt()
  }

  private fun readString(map: ReadableMap, key: String): String {
    if (!map.hasKey(key) || map.getType(key) != ReadableType.String) throw invalid(key, null)
    return map.getString(key) ?: throw invalid(key, null)
  }
}
