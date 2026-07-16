package com.fpvarbcon.transport

import android.hardware.usb.UsbManager
import com.hoho.android.usbserial.driver.UsbSerialProber

/**
 * Plain, project-owned descriptor for one attached physical USB device.
 * Deliberately not a React Native type - kept independent of the bridge so
 * enumeration/mapping logic can be reasoned about and tested on its own.
 */
internal data class UsbSerialDeviceDescriptor(
  val deviceId: Int,
  val vendorId: Int,
  val productId: Int,
  val productName: String?,
  val manufacturerName: String?,
  val driverType: String,
  val portCount: Int,
)

/**
 * Enumerates currently attached USB devices and reports which serial driver,
 * if any, usb-serial-for-android's default prober can match. Does not
 * request permission, does not open a UsbDeviceConnection, and does not open
 * a UsbSerialPort - it only answers "what's attached and what could handle it".
 */
internal class UsbSerialDeviceEnumerator(private val usbManager: UsbManager) {

  private val prober = UsbSerialProber.getDefaultProber()

  fun enumerate(): List<UsbSerialDeviceDescriptor> =
    usbManager.deviceList.values
      .map { device ->
        val driver = prober.probeDevice(device)
        val driverType = UsbSerialDriverType.from(driver?.javaClass)
        UsbSerialDeviceDescriptor(
          deviceId = device.deviceId,
          vendorId = device.vendorId,
          productId = device.productId,
          productName = device.productName,
          manufacturerName = device.manufacturerName,
          driverType = driverType,
          portCount = UsbSerialDriverType.portCountFor(driverType, driver?.ports?.size ?: 0),
        )
      }
      .sortedBy { it.deviceId }
}
