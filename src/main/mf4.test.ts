import { strict as assert } from 'node:assert'
import { deflateSync } from 'node:zlib'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { readBlock, inflateDz, iterateCanRecords, parseMf4 } from './mf4.ts'

let passed = 0
let failed = 0
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      await fn()
      passed++
      console.log(`  ok  ${name}`)
    } catch (err) {
      failed++
      console.error(`  FAIL ${name}`)
      console.error(err)
    }
  }
  return run()
}

async function main(): Promise<void> {
  await test('readBlock parses 24-byte header with 2 links', () => {
    const buf = Buffer.alloc(40)
    buf.write('##DG', 0, 'ascii')
    buf.writeBigUInt64LE(40n, 8)
    buf.writeBigUInt64LE(2n, 16)
    buf.writeBigUInt64LE(0x1234n, 24)
    buf.writeBigUInt64LE(0x5678n, 32)
    const b = readBlock(buf, 0)
    assert.equal(b.id, '##DG')
    assert.equal(b.length, 40)
    assert.deepEqual(b.links, [0x1234, 0x5678])
    assert.equal(b.dataOff, 40)
    assert.equal(b.dataLen, 0)
  })

  await test('inflateDz decompresses a zlib-wrapped deflate payload', () => {
    const original = Buffer.from('the quick brown fox jumps over the lazy dog')
    const compressed = deflateSync(original)
    // Build a synthetic ##DZ block: 24-byte header, 0 links, 24-byte DZ data, then payload.
    const hdr = 24
    const dzData = 24
    const blockLen = hdr + dzData + compressed.length
    const buf = Buffer.alloc(blockLen)
    buf.write('##DZ', 0, 'ascii')
    buf.writeBigUInt64LE(BigInt(blockLen), 8)
    buf.writeBigUInt64LE(0n, 16)
    buf.write('DT', hdr + 0, 'ascii')
    buf.writeUInt8(0, hdr + 2) // zip_type=0 (deflate)
    buf.writeBigUInt64LE(BigInt(original.length), hdr + 8)
    buf.writeBigUInt64LE(BigInt(compressed.length), hdr + 16)
    compressed.copy(buf, hdr + 24)
    const out = inflateDz(buf, 0)
    assert.equal(out.toString('utf8'), original.toString('utf8'))
  })

  await test('iterateCanRecords extracts two records and filters by record ID', async () => {
    // Record size = 2 (recId) + 80 (data) = 82. Two CAN records + one non-CAN record.
    const recordSize = 82
    const buf = Buffer.alloc(recordSize * 3)
    // --- record 0: CAN, recId=1
    const r0 = 0
    buf.writeUInt16LE(1, r0 + 0)
    // timestamp u64 at data+0 = 100 ns → 100e-9 s after scale
    buf.writeBigUInt64LE(100n, r0 + 2 + 0)
    buf.writeUInt8(8, r0 + 2 + 9)  // DLC
    buf.writeUInt8(8, r0 + 2 + 10) // DataLength
    buf.writeUInt32LE(0x18feee00, r0 + 2 + 11) // extended ID
    buf.writeUInt8(0x01, r0 + 2 + 15)          // IDE bit0 = 1, EDL bit2 = 0
    for (let i = 0; i < 8; i++) buf.writeUInt8(0x10 + i, r0 + 2 + 16 + i)
    // --- record 1: non-CAN recId=2 (should be skipped)
    buf.writeUInt16LE(2, recordSize + 0)
    // --- record 2: CAN, recId=1, FD (EDL=1 → skipped)
    const r2 = recordSize * 2
    buf.writeUInt16LE(1, r2 + 0)
    buf.writeBigUInt64LE(200n, r2 + 2 + 0)
    buf.writeUInt8(8, r2 + 2 + 9)
    buf.writeUInt8(8, r2 + 2 + 10)
    buf.writeUInt32LE(0x123, r2 + 2 + 11)
    buf.writeUInt8(0b00000100, r2 + 2 + 15) // IDE=0, EDL=1
    const layout = {
      recordSize,
      recIdSize: 2 as const,
      recordId: 1,
      tsByteOff: 0,
      tsBitCount: 64,
      tsCc: { offset: 0, scale: 1e-9 },
      idByteOff: 11,
      ideByteOff: 15,
      ideBitOff: 0,
      edlByteOff: 15,
      edlBitOff: 2,
      dlcByteOff: 9,
      dataLenByteOff: 10,
      dataBytesByteOff: 16,
      dataBytesMax: 64
    }
    const { frames, fdSkipped } = await iterateCanRecords(buf, layout)
    assert.equal(frames.length, 1, 'exactly one classic-CAN frame extracted')
    assert.equal(fdSkipped, 1, 'FD frame counted as skipped')
    const f = frames[0]
    assert.equal(f.id, 0x18feee00 & 0x1fffffff)
    assert.equal(f.extended, true)
    assert.equal(f.data.length, 8)
    assert.deepEqual(Array.from(f.data), [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17])
    assert.ok(Math.abs(f.timestamp - 100e-9) < 1e-15)
  })

  const sample = resolve(process.cwd(), 'running.mf4')
  if (existsSync(sample)) {
    await test('parseMf4 smoke test on running.mf4', async () => {
      const res = await parseMf4(sample)
      assert.ok(res.frames.length > 0, `expected frames, got ${res.frames.length}`)
      assert.ok(res.frames.some((f) => f.extended), 'expected at least one 29-bit frame')
      // Timestamps sorted ascending
      for (let i = 1; i < res.frames.length; i++) {
        assert.ok(res.frames[i].timestamp >= res.frames[i - 1].timestamp, 'frames sorted by timestamp')
      }
      console.log(`       → ${res.frames.length} frames, ${res.skipped} skipped, warnings: ${res.warnings.length}`)
    })
  } else {
    console.log('  skip running.mf4 smoke test (file not present)')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
