import { strict as assert } from 'node:assert'
import { extractBits } from './bits.ts'

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}`)
    console.error(err)
  }
}

test('Intel unsigned 16-bit spans two bytes (LSB first)', () => {
  const data = new Uint8Array([0x34, 0x12, 0, 0, 0, 0, 0, 0])
  assert.equal(extractBits(data, 0, 16, 'Intel', false), 0x1234)
})

test('Intel signed 16-bit, 0xFFFF → -1', () => {
  const data = new Uint8Array([0xff, 0xff, 0, 0, 0, 0, 0, 0])
  assert.equal(extractBits(data, 0, 16, 'Intel', true), -1)
})

test('Intel 8-bit offset from startBit 4', () => {
  const data = new Uint8Array([0b11010000, 0b00000101, 0, 0, 0, 0, 0, 0])
  assert.equal(extractBits(data, 4, 8, 'Intel', false), 0b01011101)
})

test('Motorola unsigned 16-bit, startBit=7 spans byte0 (MSB) then byte1', () => {
  const data = new Uint8Array([0x12, 0x34, 0, 0, 0, 0, 0, 0])
  assert.equal(extractBits(data, 7, 16, 'Motorola', false), 0x1234)
})

test('Motorola signed 8-bit, 0x80 → -128', () => {
  const data = new Uint8Array([0x80, 0, 0, 0, 0, 0, 0, 0])
  assert.equal(extractBits(data, 7, 8, 'Motorola', true), -128)
})

test('Intel with factor+offset (100 * 0.5 + 10 = 60)', () => {
  const data = new Uint8Array([100, 0, 0, 0, 0, 0, 0, 0])
  const raw = extractBits(data, 0, 8, 'Intel', false)
  const value = raw * 0.5 + 10
  assert.equal(value, 60)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
