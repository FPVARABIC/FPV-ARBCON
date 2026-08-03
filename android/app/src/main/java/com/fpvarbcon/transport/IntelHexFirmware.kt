package com.fpvarbcon.transport

internal data class IntelHexSegment(val address: Long, val data: ByteArray)

internal data class IntelHexFirmware(
  val segments: List<IntelHexSegment>,
  val totalBytes: Int,
  val entryPoint: Long?,
) {
  companion object {
    fun parse(source: String): IntelHexFirmware {
      var baseAddress = 0L
      var entryPoint: Long? = null
      var sawEof = false
      val records = mutableListOf<IntelHexSegment>()
      source.removePrefix("\uFEFF").lineSequence().forEachIndexed { index, rawLine ->
        val lineNumber = index + 1
        val line = rawLine.trim()
        if (line.isEmpty()) return@forEachIndexed
        require(!sawEof) { "Intel HEX data appears after EOF at line $lineNumber." }
        require(line.startsWith(':') && line.length >= 11 && (line.length - 1) % 2 == 0) {
          "Malformed Intel HEX line $lineNumber."
        }
        val bytes = line.drop(1).chunked(2).map {
          it.toIntOrNull(16) ?: throw IllegalArgumentException("Non-hex byte at line $lineNumber.")
        }
        val count = bytes[0]
        require(bytes.size == count + 5) { "Intel HEX length mismatch at line $lineNumber." }
        require(bytes.sum().and(0xff) == 0) { "Intel HEX checksum mismatch at line $lineNumber." }
        val relativeAddress = (bytes[1] shl 8) or bytes[2]
        val type = bytes[3]
        val data = bytes.subList(4, 4 + count)
        when (type) {
          0 -> if (data.isNotEmpty()) {
            val address = baseAddress + relativeAddress
            require(address in 0..0xffffffffL && address + data.size <= 0x100000000L) {
              "Intel HEX address is outside 32-bit range."
            }
            records += IntelHexSegment(address, data.map { it.toByte() }.toByteArray())
          }
          1 -> {
            require(count == 0 && relativeAddress == 0) { "Invalid Intel HEX EOF record." }
            sawEof = true
          }
          2 -> {
            require(count == 2 && relativeAddress == 0) { "Invalid extended segment record." }
            baseAddress = (((data[0] shl 8) or data[1]).toLong() shl 4)
          }
          3 -> {
            require(count == 4 && relativeAddress == 0) { "Invalid segment entry record." }
            entryPoint = ((((data[0] shl 8) or data[1]).toLong() shl 4) + ((data[2] shl 8) or data[3]))
          }
          4 -> {
            require(count == 2 && relativeAddress == 0) { "Invalid extended linear record." }
            baseAddress = ((data[0] shl 8) or data[1]).toLong() shl 16
          }
          5 -> {
            require(count == 4 && relativeAddress == 0) { "Invalid linear entry record." }
            entryPoint = data.fold(0L) { value, byte -> (value shl 8) or byte.toLong() }
          }
          else -> throw IllegalArgumentException("Unsupported Intel HEX record type $type.")
        }
      }
      require(sawEof) { "Intel HEX EOF record is missing." }
      require(records.isNotEmpty()) { "Intel HEX contains no firmware data." }
      val ordered = records.sortedBy { it.address }
      val merged = mutableListOf<IntelHexSegment>()
      var groupStart = 0
      while (groupStart < ordered.size) {
        var groupEnd = groupStart + 1
        var groupBytes = ordered[groupStart].data.size
        var endAddress = ordered[groupStart].address + ordered[groupStart].data.size
        while (groupEnd < ordered.size) {
          val next = ordered[groupEnd]
          require(next.address >= endAddress) { "Intel HEX address ranges overlap." }
          if (next.address != endAddress) break
          groupBytes = Math.addExact(groupBytes, next.data.size)
          endAddress = Math.addExact(endAddress, next.data.size.toLong())
          groupEnd += 1
        }
        // One allocation per contiguous region avoids quadratic prefix
        // copying for the thousands of short records in normal HEX files.
        val data = ByteArray(groupBytes)
        var outputOffset = 0
        for (recordIndex in groupStart until groupEnd) {
          val chunk = ordered[recordIndex].data
          chunk.copyInto(data, outputOffset)
          outputOffset += chunk.size
        }
        merged += IntelHexSegment(ordered[groupStart].address, data)
        groupStart = groupEnd
      }
      return IntelHexFirmware(merged, merged.sumOf { it.data.size }, entryPoint)
    }
  }
}
