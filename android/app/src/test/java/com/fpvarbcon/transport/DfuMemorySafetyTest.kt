package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ANDROID DFU MEMORY SAFETY - the native half of the flash-safety
 * contract the web engine already enforces.
 *
 * The parser used to MATCH the DfuSe access letter and throw it away, so
 * nothing on this platform could tell writable internal flash from
 * read-only option bytes; a full erase therefore aimed erase commands at
 * every parsed sector, including regions the device declares
 * non-erasable. These tests pin the corrected behaviour: the flags are
 * decoded, the writable map gates the firmware range, and the flash
 * target is chosen by region-name evidence rather than by taking
 * whichever DFU alternate happens to be declared first.
 */
class DfuMemorySafetyTest {

  private val internalFlash = "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg"
  private val optionBytes = "@Option Bytes  /0x1FFFC000/01*016 e"
  private val otpRegion = "@OTP Memory /0x1FFF7800/01*512 e"

  @Test
  fun decodesDfuSePermissionLetters() {
    val layout = DfuMemoryLayout.parse("@Mixed /0x08000000/01*016Ka,01*016Ke,01*016Kg,01*016K")
    // 'a' = readable only, 'e' = readable+writable, 'g' = readable+erasable+writable,
    // and an ABSENT letter is treated as fully accessible.
    assertEquals(
      listOf(
        Triple(true, false, false),
        Triple(true, false, true),
        Triple(true, true, true),
        Triple(true, true, true),
      ),
      layout.sectors.map { Triple(it.readable, it.erasable, it.writable) },
    )
  }

  @Test
  fun internalFlashSectorsRemainFullyAccessible() {
    val layout = DfuMemoryLayout.parse(internalFlash)
    assertTrue(layout.hasWritableSectors)
    assertTrue(layout.sectors.all { it.writable && it.erasable && it.readable })
    assertTrue(layout.containsWritable(0x08000000, 3000))
  }

  @Test
  fun readOnlyRegionIsNotWritable() {
    val layout = DfuMemoryLayout.parse("@Internal Flash  /0x08000000/12*128Ka")
    assertFalse(layout.hasWritableSectors)
    assertFalse(layout.containsWritable(0x08000000, 16))
    // The addresses still EXIST - only the permission differs, which is
    // exactly the distinction that used to be lost.
    assertTrue(layout.contains(0x08000000, 16))
  }

  @Test
  fun rangeRunningIntoAReadOnlyTailSectorIsRejected() {
    val layout = DfuMemoryLayout.parse("@Internal Flash  /0x08000000/01*016Kg,01*016Ka")
    assertTrue(layout.containsWritable(0x08000000, 16 * 1024))
    assertFalse(layout.containsWritable(0x08003000, 8192))
  }

  @Test
  fun fullErasePlanSkipsNonErasableRegions() {
    // One writable/erasable flash sector followed by an erase-only
    // option-byte style sector marked 'a' (read only).
    val layout = DfuMemoryLayout.parse("@Internal Flash  /0x08000000/01*016Kg,01*016Ka")
    val fullErasePlan = layout.sectors.filter { it.erasable }
    assertEquals(1, fullErasePlan.size)
    assertEquals(0x08000000L, fullErasePlan.single().address)
  }

  @Test
  fun mixedSectorErasePlanUsesRealSectorGeometry() {
    val layout = DfuMemoryLayout.parse("@Internal Flash  /0x08000000/04*032Kg,01*128Kg,03*256Kg")
    val touched = listOf(0x08000000L to 200, 0x08021000L to 200, 0x08041000L to 200)
      .flatMap { (address, length) -> layout.sectorsOverlapping(address, length) }
      .distinctBy { it.address }
      .map { it.address }
    assertEquals(listOf(0x08000000L, 0x08020000L, 0x08040000L), touched)
  }

  @Test
  fun selectsTheRegionNamedInternalFlashOverOptionBytesAndOtp() {
    val optionAlternate = fakeInterface(0, 0)
    val otpAlternate = fakeInterface(0, 1)
    val flashAlternate = fakeInterface(0, 2)
    val layouts = mapOf(
      optionAlternate to optionBytes,
      otpAlternate to otpRegion,
      flashAlternate to internalFlash,
    )

    val selected = selectDfuFlashInterface(
      listOf(optionAlternate, otpAlternate, flashAlternate),
    ) { layouts[it] }

    assertSame(flashAlternate, selected?.first)
    assertEquals("Internal Flash", selected?.second?.name)
  }

  @Test
  fun fallsBackToTheSingleWritableRegionWhenNamesAreNonstandard() {
    val calibration = fakeInterface(0, 0)
    val program = fakeInterface(0, 1)
    val layouts = mapOf(
      calibration to "@Readback Cal /0x1FFF0000/01*016Ka",
      program to "@Program Memory /0x08000000/08*016Kg",
    )

    val selected = selectDfuFlashInterface(listOf(calibration, program)) { layouts[it] }

    assertSame(program, selected?.first)
  }

  @Test
  fun refusesToGuessBetweenSeveralWritableNonstandardRegions() {
    val first = fakeInterface(0, 0)
    val second = fakeInterface(0, 1)
    val layouts = mapOf(
      first to "@Weird Region A /0x08000000/04*016Kg",
      second to "@Weird Region B /0x08100000/04*016Kg",
    )

    assertNull(selectDfuFlashInterface(listOf(first, second)) { layouts[it] })
  }

  @Test
  fun unreadableAndUnparseableDescriptorsYieldNoSelection() {
    val unreadable = fakeInterface(0, 0)
    val garbage = fakeInterface(0, 1)
    val layouts = mapOf(garbage to "STM32 BOOTLOADER")

    assertNull(selectDfuFlashInterface(listOf(unreadable, garbage)) { layouts[it] })
  }

  /**
   * A DFU alternate stand-in. The selection is generic over the candidate
   * type precisely so this runs as a plain JVM test - no Android
   * framework classes, no emulator, no Robolectric.
   */
  private data class Alternate(val id: Int, val alternateSetting: Int)

  private fun fakeInterface(id: Int, alternateSetting: Int) = Alternate(id, alternateSetting)
}
