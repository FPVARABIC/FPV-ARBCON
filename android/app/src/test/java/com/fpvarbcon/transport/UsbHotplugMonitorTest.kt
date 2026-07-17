package com.fpvarbcon.transport

import android.hardware.usb.UsbManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Covers classifyUsbHotplugAction and decideUsbHotplugAction - the pure,
 * JVM-testable slice of UsbHotplugMonitor (see its class-level note). Real
 * BroadcastReceiver registration/cleanup and the Intent/UsbDevice extraction
 * inside onReceive cannot be exercised here - there is no Robolectric or
 * other Android runtime dependency in this Gradle module (see
 * app/build.gradle), so Context/Intent/UsbManager/UsbDevice cannot be
 * instantiated or invoked off a real device or emulator, and per the Pass
 * 4.7 review, no Mockito/Robolectric was added to work around that. See the
 * Pass 4.7 report for exactly which behaviors remain CI/device-only.
 */
class UsbHotplugMonitorTest {

  private val identity = UsbDeviceIdentity(deviceId = 1, vendorId = 0x1a86, productId = 0x7523)

  @Test
  fun `the attach action maps to ATTACHED`() {
    assertEquals(
      UsbHotplugAction.ATTACHED,
      classifyUsbHotplugAction(UsbManager.ACTION_USB_DEVICE_ATTACHED),
    )
  }

  @Test
  fun `the detach action maps to DETACHED`() {
    assertEquals(
      UsbHotplugAction.DETACHED,
      classifyUsbHotplugAction(UsbManager.ACTION_USB_DEVICE_DETACHED),
    )
  }

  @Test
  fun `an unrelated broadcast action is ignored`() {
    assertEquals(
      UsbHotplugAction.IGNORED,
      classifyUsbHotplugAction("android.intent.action.BATTERY_CHANGED"),
    )
  }

  @Test
  fun `a null action is ignored rather than crashing`() {
    assertEquals(UsbHotplugAction.IGNORED, classifyUsbHotplugAction(null))
  }

  @Test
  fun `an attach action with a resolved identity decides Attached carrying that identity`() {
    val decision = decideUsbHotplugAction(UsbManager.ACTION_USB_DEVICE_ATTACHED, identity)

    assertTrue(decision is UsbHotplugDecision.Attached)
    assertEquals(identity, (decision as UsbHotplugDecision.Attached).identity)
  }

  @Test
  fun `a detach action with a resolved identity decides Detached carrying that identity`() {
    val decision = decideUsbHotplugAction(UsbManager.ACTION_USB_DEVICE_DETACHED, identity)

    assertTrue(decision is UsbHotplugDecision.Detached)
    assertEquals(identity, (decision as UsbHotplugDecision.Detached).identity)
  }

  @Test
  fun `the emitted identity carries the exact deviceId, vendorId, and productId - no substitute fields`() {
    val decision =
      decideUsbHotplugAction(UsbManager.ACTION_USB_DEVICE_ATTACHED, identity) as UsbHotplugDecision.Attached

    assertEquals(1, decision.identity.deviceId)
    assertEquals(0x1a86, decision.identity.vendorId)
    assertEquals(0x7523, decision.identity.productId)
  }

  @Test
  fun `an unrelated action is ignored even with a resolved identity present`() {
    val decision = decideUsbHotplugAction("android.intent.action.BATTERY_CHANGED", identity)

    assertEquals(UsbHotplugDecision.Ignore, decision)
  }

  @Test
  fun `a null action is ignored even with a resolved identity present`() {
    assertEquals(UsbHotplugDecision.Ignore, decideUsbHotplugAction(null, identity))
  }

  @Test
  fun `a missing device identity (the extra was absent or malformed) is ignored rather than crashing`() {
    assertEquals(
      UsbHotplugDecision.Ignore,
      decideUsbHotplugAction(UsbManager.ACTION_USB_DEVICE_ATTACHED, null),
    )
    assertEquals(
      UsbHotplugDecision.Ignore,
      decideUsbHotplugAction(UsbManager.ACTION_USB_DEVICE_DETACHED, null),
    )
  }

  @Test
  fun `there is no path to an Attached or Detached decision without a resolved UsbDeviceIdentity`() {
    // decideUsbHotplugAction's only identity-shaped parameter is a
    // UsbDeviceIdentity? - there is no alternative string/int/Bundle extra
    // path it could pull an identity from, by construction of its signature.
    // A null identity always short-circuits to Ignore regardless of action.
    assertEquals(
      UsbHotplugDecision.Ignore,
      decideUsbHotplugAction(UsbManager.ACTION_USB_DEVICE_ATTACHED, null),
    )
  }
}
