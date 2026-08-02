package com.fpvarbcon.transport

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DfuFirmwareValidationTest {
  @Test
  fun parsesMixedSectorLayoutAndChecksContinuousCoverage() {
    val layout = DfuMemoryLayout.parse("@Internal Flash  /0x08000000/04*016Kg,01*064Kg,03*128Kg")
    assertEquals(8, layout.sectors.size)
    assertEquals(16 * 1024, layout.sectors.first().sizeBytes)
    assertEquals(64 * 1024, layout.sectors[4].sizeBytes)
    assertTrue(layout.contains(0x08000000, 4 * 16 * 1024 + 64 * 1024))
    assertFalse(layout.contains(0x07ffffff, 2))
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsMalformedMemoryLayout() {
    DfuMemoryLayout.parse("@Internal Flash /0x08000000/not-a-sector")
  }

  @Test
  fun parsesAndMergesStrictIntelHexRecords() {
    val firmware = IntelHexFirmware.parse(
      listOf(
        record(0, 4, intArrayOf(0x08, 0x00)),
        record(0, 0, intArrayOf(1, 2)),
        record(2, 0, intArrayOf(3, 4)),
        record(0, 1, intArrayOf()),
      ).joinToString("\n"),
    )
    assertEquals(4, firmware.totalBytes)
    assertEquals(1, firmware.segments.size)
    assertEquals(0x08000000, firmware.segments.first().address)
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsOverlappingIntelHexRecords() {
    IntelHexFirmware.parse(
      listOf(
        record(0, 4, intArrayOf(0x08, 0x00)),
        record(0, 0, intArrayOf(1, 2)),
        record(1, 0, intArrayOf(3)),
        record(0, 1, intArrayOf()),
      ).joinToString("\n"),
    )
  }

  @Test
  fun findsAndDecodesDfuInterfaceStringDescriptor() {
    val raw = byteArrayOf(
      9, 4, 1, 0, 0, 0xfe.toByte(), 1, 2, 7,
      9, 4, 1, 1, 0, 0xfe.toByte(), 1, 2, 8,
    )
    assertEquals(8, findInterfaceStringIndex(raw, 1, 1))
    val text = "@Internal Flash /0x08000000/04*016Kg"
    val encoded = text.toByteArray(Charsets.UTF_16LE)
    val descriptor = byteArrayOf((encoded.size + 2).toByte(), 3) + encoded
    assertEquals(text, decodeUsbStringDescriptor(descriptor, descriptor.size))
  }

  @Test
  fun readsTransferSizeOnlyFromTheSelectedDfuInterface() {
    val raw = byteArrayOf(
      9, 4, 1, 0, 0, 0xfe.toByte(), 1, 2, 7,
      9, 0x21, 0, 0, 0, 0, 4, 0, 1,
      9, 4, 1, 1, 0, 0xfe.toByte(), 1, 2, 8,
      9, 0x21, 0, 0, 0, 0, 8, 0, 1,
    )
    assertEquals(1024, findDfuTransferSize(raw, 1, 0))
    assertEquals(2048, findDfuTransferSize(raw, 1, 1))
  }

  @Test
  fun mergesThousandsOfContiguousHexRecordsIntoOneAllocationRegion() {
    val records = mutableListOf(record(0, 4, intArrayOf(0x08, 0x00)))
    repeat(4096) { index ->
      records += record(index * 16, 0, IntArray(16) { (index + it) and 0xff })
    }
    records += record(0, 1, intArrayOf())
    val firmware = IntelHexFirmware.parse(records.joinToString("\n"))
    assertEquals(4096 * 16, firmware.totalBytes)
    assertEquals(1, firmware.segments.size)
  }

  private fun record(address: Int, type: Int, data: IntArray): String {
    val bytes = mutableListOf(data.size, address ushr 8, address and 0xff, type)
    bytes.addAll(data.toList())
    bytes += -bytes.sum() and 0xff
    return ":" + bytes.joinToString("") { it.toString(16).padStart(2, '0').uppercase() }
  }
}
