package com.fpvarbcon.transport

/**
 * One DfuSe sector, INCLUDING the access rights the device declared for
 * it. The permission letter used to be matched and thrown away, which
 * left the Android flasher unable to tell writable internal flash from
 * read-only option bytes - so a full erase could aim erase commands at a
 * region the device itself marks non-erasable. Web already decodes these;
 * this is the same truth on the native side.
 */
internal data class DfuSector(
  val address: Long,
  val sizeBytes: Int,
  val readable: Boolean = true,
  val erasable: Boolean = true,
  val writable: Boolean = true,
) {
  val endExclusive: Long = address + sizeBytes
}

internal data class DfuMemoryLayout(val name: String, val sectors: List<DfuSector>) {
  fun contains(address: Long, length: Int): Boolean {
    if (length <= 0) return false
    var cursor = address
    val end = address + length
    while (cursor < end) {
      val sector = sectors.firstOrNull { cursor >= it.address && cursor < it.endExclusive } ?: return false
      cursor = minOf(end, sector.endExclusive)
    }
    return true
  }

  /** True only when EVERY byte of the range falls in a writable sector. */
  fun containsWritable(address: Long, length: Int): Boolean {
    if (length <= 0) return false
    var cursor = address
    val end = address + length
    while (cursor < end) {
      val sector = sectors.firstOrNull { cursor >= it.address && cursor < it.endExclusive } ?: return false
      if (!sector.writable) return false
      cursor = minOf(end, sector.endExclusive)
    }
    return true
  }

  val hasWritableSectors: Boolean get() = sectors.any { it.writable }

  fun sectorsOverlapping(address: Long, length: Int): List<DfuSector> {
    val end = address + length
    return sectors.filter { it.address < end && it.endExclusive > address }
  }

  companion object {
    private val regionPattern = Regex("/(0x[0-9a-fA-F]+)/([^/]+)")
    // Group 4 is the DfuSe access letter (ST UM0424): the bits of
    // (letter - 'a' + 1) are readable/erasable/writable. It is CAPTURED
    // now instead of being matched and discarded.
    private val sectorPattern = Regex("^\\s*(\\d+)\\s*\\*\\s*(\\d+)\\s*([bBkKmM]?)\\s*([a-gA-G]?)\\s*$")

    fun parse(descriptor: String): DfuMemoryLayout {
      val printable = descriptor.filter { it.code in 0x20..0x7e }
      require(printable.trim().startsWith("@")) { "DFU memory descriptor must start with @." }
      val name = printable.substringBefore('/').trim().removePrefix("@").trim()
      val sectors = mutableListOf<DfuSector>()
      for (region in regionPattern.findAll(printable)) {
        var address = region.groupValues[1].removePrefix("0x").toLong(16)
        for (token in region.groupValues[2].split(',')) {
          val match = sectorPattern.matchEntire(token)
            ?: throw IllegalArgumentException("Unrecognized DFU sector descriptor: $token")
          val count = match.groupValues[1].toInt()
          val rawSize = match.groupValues[2].toLong()
          val multiplier = when (match.groupValues[3].uppercase()) {
            "K" -> 1024L
            "M" -> 1024L * 1024L
            else -> 1L
          }
          val size = Math.multiplyExact(rawSize, multiplier)
          require(count > 0 && size in 1..Int.MAX_VALUE.toLong()) { "Invalid DFU sector size/count." }
          // An ABSENT letter means fully accessible - the same leniency
          // the web parser and the pinned Betaflight reference apply.
          val letter = match.groupValues[4].lowercase()
          val flagBits = if (letter.isEmpty()) 0b111 else letter[0].code - 96
          val readable = (flagBits and 0b001) != 0
          val erasable = (flagBits and 0b010) != 0
          val writable = (flagBits and 0b100) != 0
          repeat(count) {
            sectors += DfuSector(address, size.toInt(), readable, erasable, writable)
            address = Math.addExact(address, size)
          }
        }
      }
      require(sectors.isNotEmpty()) { "DFU memory descriptor contains no usable sectors." }
      val ordered = sectors.sortedBy { it.address }
      ordered.zipWithNext().forEach { (left, right) ->
        require(left.endExclusive <= right.address) { "DFU memory sectors overlap." }
      }
      return DfuMemoryLayout(name, ordered)
    }
  }
}
