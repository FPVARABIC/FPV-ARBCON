package com.fpvarbcon.transport

import com.hoho.android.usbserial.driver.Ch34xSerialDriver
import com.hoho.android.usbserial.driver.CdcAcmSerialDriver
import com.hoho.android.usbserial.driver.ChromeCcdSerialDriver
import com.hoho.android.usbserial.driver.Cp21xxSerialDriver
import com.hoho.android.usbserial.driver.FtdiSerialDriver
import com.hoho.android.usbserial.driver.GsmModemSerialDriver
import com.hoho.android.usbserial.driver.ProlificSerialDriver
import org.junit.Assert.assertEquals
import org.junit.Test

class UsbSerialDriverTypeTest {

  @Test
  fun `maps CdcAcmSerialDriver to CDC_ACM`() {
    assertEquals(UsbSerialDriverType.CDC_ACM, UsbSerialDriverType.from(CdcAcmSerialDriver::class.java))
  }

  @Test
  fun `maps FtdiSerialDriver to FTDI`() {
    assertEquals(UsbSerialDriverType.FTDI, UsbSerialDriverType.from(FtdiSerialDriver::class.java))
  }

  @Test
  fun `maps Cp21xxSerialDriver to CP210X`() {
    assertEquals(UsbSerialDriverType.CP210X, UsbSerialDriverType.from(Cp21xxSerialDriver::class.java))
  }

  @Test
  fun `maps Ch34xSerialDriver to CH34X`() {
    assertEquals(UsbSerialDriverType.CH34X, UsbSerialDriverType.from(Ch34xSerialDriver::class.java))
  }

  @Test
  fun `maps ProlificSerialDriver to PL2303`() {
    assertEquals(UsbSerialDriverType.PL2303, UsbSerialDriverType.from(ProlificSerialDriver::class.java))
  }

  @Test
  fun `maps no matching driver to UNSUPPORTED`() {
    assertEquals(UsbSerialDriverType.UNSUPPORTED, UsbSerialDriverType.from(null))
  }

  // usb-serial-for-android's default prober also recognizes these two driver
  // classes. Both are intentionally out of scope for an FPV flight-controller
  // transport and are classified as UNSUPPORTED as a locked policy decision,
  // not a temporary gap.

  @Test
  fun `maps GsmModemSerialDriver to UNSUPPORTED as a locked out-of-scope decision`() {
    assertEquals(UsbSerialDriverType.UNSUPPORTED, UsbSerialDriverType.from(GsmModemSerialDriver::class.java))
  }

  @Test
  fun `maps ChromeCcdSerialDriver to UNSUPPORTED as a locked out-of-scope decision`() {
    assertEquals(UsbSerialDriverType.UNSUPPORTED, UsbSerialDriverType.from(ChromeCcdSerialDriver::class.java))
  }

  // portCountFor enforces that UNSUPPORTED can never carry a usable port
  // count, independent of whatever the underlying driver reports.

  @Test
  fun `portCountFor reports zero for UNSUPPORTED even if ports were available`() {
    assertEquals(0, UsbSerialDriverType.portCountFor(UsbSerialDriverType.UNSUPPORTED, 3))
  }

  @Test
  fun `portCountFor passes through the real count for a supported driverType`() {
    assertEquals(2, UsbSerialDriverType.portCountFor(UsbSerialDriverType.CDC_ACM, 2))
  }

  @Test
  fun `a recognized but out-of-scope driver cannot produce UNSUPPORTED with a positive portCount`() {
    val driverType = UsbSerialDriverType.from(GsmModemSerialDriver::class.java)

    val portCount = UsbSerialDriverType.portCountFor(driverType, portsAvailable = 4)

    assertEquals(UsbSerialDriverType.UNSUPPORTED, driverType)
    assertEquals(0, portCount)
  }
}
