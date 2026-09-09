package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * THE ORDER, AND WHAT HAPPENS WHEN A STEP REFUSES.
 *
 * [withClaimedDfuFlashInterface] is the only place that decides whether a
 * DfuSe erase is allowed to start. The cases here are the ones that
 * matter on a flight controller: that the alternate is ACTIVATED before
 * anything is erased, that a refusal to activate stops the flash instead
 * of writing to an unknown region, that the one provably-harmless refusal
 * still works, and that the claimed interface is released exactly once
 * however the attempt ended.
 *
 * A fake device records the calls in order, so "before" is asserted as a
 * sequence rather than inferred from the source.
 */
class DfuClaimedInterfaceTest {

  /** Stands in for one interface/alternate on a device. */
  private data class Alternate(val id: Int, val alternateSetting: Int)

  private class FakeDevice(
    val claimSucceeds: Boolean = true,
    val selectSucceeds: Boolean = true,
    val selectThrows: RuntimeException? = null,
    val releaseThrows: RuntimeException? = null,
  ) {
    val calls = mutableListOf<String>()

    fun claim(target: Alternate): Boolean {
      calls += "claim(${target.id}/${target.alternateSetting})"
      return claimSucceeds
    }

    fun select(target: Alternate): Boolean {
      calls += "select(${target.id}/${target.alternateSetting})"
      selectThrows?.let { throw it }
      return selectSucceeds
    }

    fun release(target: Alternate) {
      calls += "release(${target.id}/${target.alternateSetting})"
      releaseThrows?.let { throw it }
    }
  }

  private fun run(
    device: FakeDevice,
    target: Alternate,
    declaredAlternates: List<Int>,
    body: () -> String = { "flashed" },
  ): String =
    withClaimedDfuFlashInterface(
      target = target,
      alternateSetting = target.alternateSetting,
      declaredAlternates = declaredAlternates,
      layoutName = "Internal Flash",
      claim = device::claim,
      selectAlternate = device::select,
      release = device::release,
      body = body,
    )

  // -------------------------------------------------------------------
  // Ordering
  // -------------------------------------------------------------------

  @Test
  fun theAlternateIsActivatedBeforeAnyEraseOrWrite() {
    val device = FakeDevice()
    val target = Alternate(id = 0, alternateSetting = 1)

    val result = run(device, target, listOf(0, 1, 2, 3)) {
      device.calls += "erase"
      device.calls += "write"
      "flashed"
    }

    assertEquals("flashed", result)
    assertEquals(
      listOf("claim(0/1)", "select(0/1)", "erase", "write", "release(0/1)"),
      device.calls,
    )
  }

  // -------------------------------------------------------------------
  // A refused or throwing selection must stop the flash
  // -------------------------------------------------------------------

  @Test
  fun aRefusedSelectionStopsTheFlashBeforeAnythingIsErased() {
    val device = FakeDevice(selectSucceeds = false)
    var bodyRan = false

    try {
      run(device, Alternate(0, 1), listOf(0, 1, 2, 3)) {
        bodyRan = true
        "flashed"
      }
      fail("a refused alternate selection must not be survivable here")
    } catch (error: UsbTransportException) {
      assertEquals("DFU_ALTERNATE_SELECTION_FAILED", error.code)
      assertTrue(
        "the operator is not told which region was refused: ${error.message}",
        (error.message ?: "").contains("Internal Flash"),
      )
    }

    assertFalse("the flash body ran after a refused selection", bodyRan)
    assertEquals(listOf("claim(0/1)", "select(0/1)", "release(0/1)"), device.calls)
  }

  @Test
  fun aThrowingSelectionStopsTheFlashAndStillReleases() {
    val boom = IllegalStateException("USB gone")
    val device = FakeDevice(selectThrows = boom)
    var bodyRan = false

    try {
      run(device, Alternate(0, 2), listOf(0, 1, 2, 3)) {
        bodyRan = true
        "flashed"
      }
      fail("an exception from setInterface must not be swallowed")
    } catch (error: IllegalStateException) {
      assertEquals("USB gone", error.message)
    }

    assertFalse("the flash body ran after setInterface threw", bodyRan)
    assertEquals(listOf("claim(0/2)", "select(0/2)", "release(0/2)"), device.calls)
  }

  // -------------------------------------------------------------------
  // The one survivable refusal, and the shapes around it
  // -------------------------------------------------------------------

  @Test
  fun aDefaultOnlyInterfaceStillFlashesWhenSelectionIsRefused() {
    val device = FakeDevice(selectSucceeds = false)

    val result = run(device, Alternate(0, 0), listOf(0)) {
      device.calls += "erase"
      "flashed"
    }

    assertEquals("flashed", result)
    assertEquals(listOf("claim(0/0)", "select(0/0)", "erase", "release(0/0)"), device.calls)
  }

  @Test
  fun aDuplicatedDefaultDescriptorIsStillJustTheDefault() {
    val device = FakeDevice(selectSucceeds = false)
    val result = run(device, Alternate(0, 0), listOf(0, 0, 0)) { "flashed" }
    assertEquals("flashed", result)
  }

  @Test
  fun anUnknownAlternateLayoutRefusesRatherThanGuessing() {
    // Nothing enumerated: the wanted alternate cannot be shown to be the
    // active one, so a refusal is not survivable.
    val device = FakeDevice(selectSucceeds = false)
    try {
      run(device, Alternate(0, 0), emptyList()) { "flashed" }
      fail("an unknown alternate set must not be treated as the safe case")
    } catch (error: UsbTransportException) {
      assertEquals("DFU_ALTERNATE_SELECTION_FAILED", error.code)
    }
  }

  @Test
  fun severalAlternatesMakeARefusalFatalEvenForAlternateZero() {
    val device = FakeDevice(selectSucceeds = false)
    try {
      run(device, Alternate(0, 0), listOf(0, 1, 2, 3)) { "flashed" }
      fail("another alternate could be the active one")
    } catch (error: UsbTransportException) {
      assertEquals("DFU_ALTERNATE_SELECTION_FAILED", error.code)
    }
  }

  // -------------------------------------------------------------------
  // Claim and release
  // -------------------------------------------------------------------

  @Test
  fun aFailedClaimNeverSelectsNeverFlashesAndNeverReleases() {
    val device = FakeDevice(claimSucceeds = false)
    var bodyRan = false

    try {
      run(device, Alternate(0, 1), listOf(0, 1)) {
        bodyRan = true
        "flashed"
      }
      fail("a failed claim must not continue")
    } catch (error: UsbTransportException) {
      assertEquals("DFU_CLAIM_FAILED", error.code)
    }

    assertFalse(bodyRan)
    assertEquals(
      "nothing was claimed, so nothing may be released",
      listOf("claim(0/1)"),
      device.calls,
    )
  }

  @Test
  fun theClaimedInterfaceIsReleasedExactlyOnceWhenTheFlashThrows() {
    val device = FakeDevice()
    try {
      run(device, Alternate(0, 1), listOf(0, 1)) {
        throw UsbTransportException("DFU_VERIFY_FAILED", "read-back mismatch")
      }
      fail("the flash failure must propagate")
    } catch (error: UsbTransportException) {
      assertEquals("DFU_VERIFY_FAILED", error.code)
    }

    assertEquals(1, device.calls.count { it.startsWith("release(") })
    assertEquals(listOf("claim(0/1)", "select(0/1)", "release(0/1)"), device.calls)
  }

  @Test
  fun theInterfaceReleasedIsTheOneThatWasClaimed() {
    val device = FakeDevice()
    run(device, Alternate(id = 3, alternateSetting = 2), listOf(0, 1, 2)) { "flashed" }
    assertEquals(listOf("claim(3/2)", "select(3/2)", "release(3/2)"), device.calls)
  }

  /**
   * A board that has already reset can fail the release. That is not news
   * about the flash, and it must not overwrite a result that was decided
   * before it.
   */
  @Test
  fun aThrowingReleaseDoesNotReplaceTheDecidedOutcome() {
    val device = FakeDevice(releaseThrows = IllegalStateException("device gone"))
    val result = run(device, Alternate(0, 0), listOf(0)) { "flashed" }
    assertEquals("flashed", result)

    val failing = FakeDevice(releaseThrows = IllegalStateException("device gone"))
    try {
      run(failing, Alternate(0, 0), listOf(0)) {
        throw UsbTransportException("DFU_VERIFY_FAILED", "read-back mismatch")
      }
      fail("the flash failure must survive a throwing release")
    } catch (error: UsbTransportException) {
      assertEquals("DFU_VERIFY_FAILED", error.code)
    }
  }
}
