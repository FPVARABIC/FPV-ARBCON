package com.fpvarbcon.transport

import com.hoho.android.usbserial.driver.Ch34xSerialDriver
import com.hoho.android.usbserial.driver.CdcAcmSerialDriver
import com.hoho.android.usbserial.driver.Cp21xxSerialDriver
import com.hoho.android.usbserial.driver.FtdiSerialDriver
import com.hoho.android.usbserial.driver.ProlificSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialDriver

/**
 * Normalizes usb-serial-for-android driver classes to the stable driverType
 * strings approved for [UsbSerialDeviceDescriptor]. Operates on the driver's
 * [Class] rather than an instance so it can be unit-tested on the plain JVM
 * without touching Android USB APIs.
 */
internal object UsbSerialDriverType {
  const val CDC_ACM = "CDC_ACM"
  const val FTDI = "FTDI"
  const val CP210X = "CP210X"
  const val CH34X = "CH34X"
  const val PL2303 = "PL2303"
  const val UNSUPPORTED = "UNSUPPORTED"

  fun from(driverClass: Class<out UsbSerialDriver>?): String =
    when (driverClass) {
      null -> UNSUPPORTED
      CdcAcmSerialDriver::class.java -> CDC_ACM
      FtdiSerialDriver::class.java -> FTDI
      Cp21xxSerialDriver::class.java -> CP210X
      Ch34xSerialDriver::class.java -> CH34X
      ProlificSerialDriver::class.java -> PL2303
      // usb-serial-for-android 3.10.0's default prober also recognizes
      // GsmModemSerialDriver and ChromeCcdSerialDriver. Both are intentionally
      // out of scope for an FPV flight-controller transport and are
      // classified as UNSUPPORTED - this is a locked policy, not a gap.
      else -> UNSUPPORTED
    }

  /**
   * Derives the reported port count from the normalized driverType so an
   * UNSUPPORTED descriptor can never carry a usable port count, regardless
   * of what the underlying driver instance (if any) reports.
   */
  fun portCountFor(driverType: String, portsAvailable: Int): Int =
    if (driverType == UNSUPPORTED) 0 else portsAvailable
}
