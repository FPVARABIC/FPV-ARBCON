package com.fpvarbcon.transport

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE ONE FAILURE THIS POLICY IS ALLOWED TO SURVIVE.
 *
 * DfuFlashWorker chooses which DfuSe memory region to flash and then has to
 * ACTIVATE it with SET_INTERFACE. If that request is refused the worker has
 * a choice: proceed anyway, or refuse to erase. Proceeding is only ever
 * defensible when the alternate it wanted is provably already active, which
 * is true in exactly one situation - the interface declares nothing but its
 * default setting, so USB 2.0 §9.4.10 permits the STALL and alternate 0 is
 * active regardless.
 *
 * Every other refusal leaves the target region unknown, and these cases
 * exist so that "unknown" can never quietly become "write anyway".
 */
class DfuAlternateSelectionTest {

  @Test
  fun defaultOnlyInterfaceMayProceedWithoutSetInterface() {
    assertFalse(
      "an interface that declares only alternate 0 is already on alternate 0",
      dfuAlternateSelectionIsMandatory(0, listOf(0)),
    )
  }

  @Test
  fun aDuplicatedDefaultIsStillJustTheDefault() {
    assertFalse(
      "the same alternate listed twice is still one alternate",
      dfuAlternateSelectionIsMandatory(0, listOf(0, 0)),
    )
  }

  /**
   * The real STM32 DfuSe shape: Internal Flash, Option Bytes, OTP and
   * Device Feature on alternates 0..3. Even choosing alternate 0 here is
   * not safe without SET_INTERFACE, because an earlier session may have
   * left a different alternate active.
   */
  @Test
  fun multipleAlternatesMakeSelectionMandatoryEvenForAlternateZero() {
    assertTrue(
      "another alternate could be the active one",
      dfuAlternateSelectionIsMandatory(0, listOf(0, 1, 2, 3)),
    )
  }

  @Test
  fun anyNonDefaultAlternateMakesSelectionMandatory() {
    assertTrue(dfuAlternateSelectionIsMandatory(1, listOf(0, 1)))
    assertTrue(dfuAlternateSelectionIsMandatory(2, listOf(0, 1, 2, 3)))
  }

  /** A lone non-zero alternate still has to be selected to become active. */
  @Test
  fun aSingleNonDefaultAlternateIsStillMandatory() {
    assertTrue(dfuAlternateSelectionIsMandatory(1, listOf(1)))
  }

  /**
   * Wanting a non-default alternate that the device does not even declare.
   * The "only the default is declared" reasoning describes the DEVICE, and
   * it must never be read as permission to skip selecting something else.
   * Without the explicit non-zero guard this case reads as safe, so it is
   * pinned separately from the cases above.
   */
  @Test
  fun wantingANonDefaultAlternateIsMandatoryEvenIfOnlyTheDefaultIsDeclared() {
    assertTrue(dfuAlternateSelectionIsMandatory(1, listOf(0)))
  }

  /**
   * Nothing enumerated is not evidence of a single default alternate, so it
   * must not be treated as the safe case.
   */
  @Test
  fun anUnknownAlternateSetIsTreatedAsMandatory() {
    assertTrue("an empty list proves nothing", dfuAlternateSelectionIsMandatory(0, emptyList()))
  }

  /**
   * Alternate 0 wanted, but the device does not declare an alternate 0 at
   * all. The wanted setting is not provably active, so this is mandatory.
   */
  @Test
  fun choosingAnUndeclaredDefaultIsMandatory() {
    assertTrue(dfuAlternateSelectionIsMandatory(0, listOf(1)))
    assertTrue(dfuAlternateSelectionIsMandatory(0, listOf(1, 2)))
  }
}
