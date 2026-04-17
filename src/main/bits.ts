export type Endian = 'Intel' | 'Motorola'

export function extractBits(
  data: Uint8Array,
  startBit: number,
  length: number,
  endian: Endian,
  signed: boolean
): number {
  let raw = 0n
  if (endian === 'Intel') {
    for (let i = 0; i < length; i++) {
      const bit = startBit + i
      const byteIdx = bit >> 3
      const bitIdx = bit & 7
      if (byteIdx >= data.length) continue
      raw |= BigInt((data[byteIdx] >> bitIdx) & 1) << BigInt(i)
    }
  } else {
    let bit = startBit
    for (let i = 0; i < length; i++) {
      const byteIdx = bit >> 3
      const bitIdx = bit & 7
      if (byteIdx < data.length) {
        raw = (raw << 1n) | BigInt((data[byteIdx] >> bitIdx) & 1)
      } else {
        raw = raw << 1n
      }
      if (bitIdx === 0) bit += 15
      else bit -= 1
    }
  }
  if (signed && length > 0 && (raw & (1n << BigInt(length - 1))) !== 0n) {
    raw -= 1n << BigInt(length)
  }
  return Number(raw)
}
