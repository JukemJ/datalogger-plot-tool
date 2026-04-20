// MF4 (MDF 4.x) parser — bus-event files only.
// Supports classic CAN frames inside `CAN_DataFrame` channel groups.
// Handles unsorted DGs (record ID prefix), `##HL → ##DL → ##DZ` data chains,
// and composition channels. CAN-FD frames are skipped with a warning.
import { readFile } from 'fs/promises'
import { inflateSync } from 'zlib'
import type { Frame, ProgressCb } from './frame'

const PARSE_CHUNK = 10_000
const yieldControl = (): Promise<void> => new Promise((r) => setImmediate(r))

export type Mf4ParseResult = { frames: Frame[]; skipped: number; warnings: string[] }

export type Block = {
  id: string
  length: number
  links: number[]
  dataOff: number
  dataLen: number
}

export function readBlock(buf: Buffer, off: number): Block {
  const id = buf.toString('ascii', off, off + 4)
  const length = Number(buf.readBigUInt64LE(off + 8))
  const linkCount = Number(buf.readBigUInt64LE(off + 16))
  const links: number[] = new Array(linkCount)
  for (let i = 0; i < linkCount; i++) {
    links[i] = Number(buf.readBigUInt64LE(off + 24 + i * 8))
  }
  return { id, length, links, dataOff: off + 24 + linkCount * 8, dataLen: length - 24 - linkCount * 8 }
}

function readTxt(buf: Buffer, link: number): string {
  if (link === 0) return ''
  const b = readBlock(buf, link)
  if (b.id !== '##TX' && b.id !== '##MD') return ''
  return buf.toString('utf8', b.dataOff, b.dataOff + b.dataLen).replace(/\0+$/, '')
}

type FieldSpec = { byteOffset: number; bitOffset: number; bitCount: number; dataType: number }

type CnInfo = { name: string; field: FieldSpec; ccLink: number; compositionLink: number }

function readCn(buf: Buffer, off: number): CnInfo {
  const cn = readBlock(buf, off)
  if (cn.id !== '##CN') throw new Error(`Expected ##CN at 0x${off.toString(16)}, got ${cn.id}`)
  const d = cn.dataOff
  const dataType = buf.readUInt8(d + 2)
  const bitOffset = buf.readUInt8(d + 3)
  const byteOffset = buf.readUInt32LE(d + 4)
  const bitCount = buf.readUInt32LE(d + 8)
  return {
    name: readTxt(buf, cn.links[2]),
    field: { byteOffset, bitOffset, bitCount, dataType },
    ccLink: cn.links[4],
    compositionLink: cn.links[1]
  }
}

function nextCn(buf: Buffer, off: number): number {
  return readBlock(buf, off).links[0]
}

type LinearCc = { offset: number; scale: number }

function readLinearCc(buf: Buffer, link: number): LinearCc | null {
  if (link === 0) return null
  const b = readBlock(buf, link)
  if (b.id !== '##CC') return null
  const ccType = buf.readUInt8(b.dataOff + 0)
  if (ccType === 0) return null
  if (ccType !== 1) return null
  // CC data layout: type u8, precision u8, flags u16, ref_count u16, val_count u16,
  // phy_range_min f64, phy_range_max f64, then val_count × f64.
  const valCount = buf.readUInt16LE(b.dataOff + 6)
  if (valCount < 2) return null
  const valOff = b.dataOff + 24
  return { offset: buf.readDoubleLE(valOff), scale: buf.readDoubleLE(valOff + 8) }
}

type CanLayout = {
  recordSize: number
  recIdSize: 0 | 1 | 2 | 4 | 8
  recordId: number
  tsByteOff: number
  tsBitCount: number
  tsCc: LinearCc | null
  idByteOff: number
  ideByteOff: number
  ideBitOff: number
  edlByteOff: number | null
  edlBitOff: number
  dlcByteOff: number
  dataLenByteOff: number
  dataBytesByteOff: number
  dataBytesMax: number
}

function collectSubCns(buf: Buffer, firstCompLink: number): Map<string, CnInfo> {
  const map = new Map<string, CnInfo>()
  // Composition may point directly to a CN list (sibling chain) or to a CA (channel array).
  // For bus-event channels CANedge/Rexgen use a CN chain.
  const firstHdr = buf.toString('ascii', firstCompLink, firstCompLink + 4)
  if (firstHdr !== '##CN') return map
  let off = firstCompLink
  while (off !== 0) {
    const info = readCn(buf, off)
    map.set(info.name, info)
    off = nextCn(buf, off)
  }
  return map
}

function expandDataStream(buf: Buffer, dgDataLink: number): Buffer {
  if (dgDataLink === 0) return Buffer.alloc(0)
  const hdr = buf.toString('ascii', dgDataLink, dgDataLink + 4)
  if (hdr === '##DT') {
    const b = readBlock(buf, dgDataLink)
    return buf.subarray(b.dataOff, b.dataOff + b.dataLen)
  }
  if (hdr === '##DZ') {
    return inflateDz(buf, dgDataLink)
  }
  if (hdr === '##HL') {
    return expandHl(buf, dgDataLink)
  }
  if (hdr === '##DL') {
    return expandDl(buf, dgDataLink)
  }
  throw new Error(`Unsupported dg_data block type: ${hdr}`)
}

export function inflateDz(buf: Buffer, off: number): Buffer {
  const b = readBlock(buf, off)
  if (b.id !== '##DZ') throw new Error(`Expected ##DZ, got ${b.id}`)
  const orgType = buf.toString('ascii', b.dataOff + 0, b.dataOff + 2)
  const zipType = buf.readUInt8(b.dataOff + 2)
  const orgLen = Number(buf.readBigUInt64LE(b.dataOff + 8))
  const dataLen = Number(buf.readBigUInt64LE(b.dataOff + 16))
  if (orgType !== 'DT') throw new Error(`##DZ org_block_type ${orgType} not supported (only DT)`)
  if (zipType !== 0) throw new Error(`##DZ zip_type ${zipType} not supported (only 0=deflate)`)
  const payload = buf.subarray(b.dataOff + 24, b.dataOff + 24 + dataLen)
  const out = inflateSync(payload)
  if (out.length !== orgLen) {
    throw new Error(`##DZ inflate size mismatch: got ${out.length}, expected ${orgLen}`)
  }
  return out
}

function expandHl(buf: Buffer, off: number): Buffer {
  const b = readBlock(buf, off)
  const zipType = buf.readUInt8(b.dataOff + 2)
  // hl_zip_type is informational; each DZ child carries its own zip_type.
  void zipType
  const dlFirst = b.links[0]
  if (dlFirst === 0) return Buffer.alloc(0)
  return expandDl(buf, dlFirst)
}

function expandDl(buf: Buffer, firstDlLink: number): Buffer {
  const parts: Buffer[] = []
  let dlOff = firstDlLink
  while (dlOff !== 0) {
    const dl = readBlock(buf, dlOff)
    if (dl.id !== '##DL') throw new Error(`Expected ##DL, got ${dl.id}`)
    const dlFlags = buf.readUInt8(dl.dataOff + 0)
    const dlCount = buf.readUInt32LE(dl.dataOff + 4)
    // links[0] = next DL, links[1..dlCount] = data-block links
    for (let i = 0; i < dlCount; i++) {
      const childLink = dl.links[1 + i]
      if (childLink === 0) continue
      parts.push(expandDataStream(buf, childLink))
    }
    void dlFlags
    dlOff = dl.links[0]
  }
  return Buffer.concat(parts)
}

function pickCanLayout(
  buf: Buffer,
  dgOff: number,
  warnings: string[]
): { layout: CanLayout; dataLink: number } | null {
  const dg = readBlock(buf, dgOff)
  if (dg.id !== '##DG') return null
  const recIdSizeRaw = buf.readUInt8(dg.dataOff + 0)
  if (recIdSizeRaw !== 0 && recIdSizeRaw !== 1 && recIdSizeRaw !== 2 && recIdSizeRaw !== 4 && recIdSizeRaw !== 8) {
    throw new Error(`Unsupported dg_rec_id_size: ${recIdSizeRaw}`)
  }
  const recIdSize = recIdSizeRaw as 0 | 1 | 2 | 4 | 8
  const dataLink = dg.links[2]
  let cgOff = dg.links[1]
  while (cgOff !== 0) {
    const cg = readBlock(buf, cgOff)
    const acqName = readTxt(buf, cg.links[2])
    if (acqName === 'CAN_DataFrame') {
      const cgData = cg.dataOff
      const recordId = Number(buf.readBigUInt64LE(cgData + 0))
      const flags = buf.readUInt16LE(cgData + 16)
      const dataBytes = buf.readUInt32LE(cgData + 24)
      const invalBytes = buf.readUInt32LE(cgData + 28)
      if (invalBytes > 0) {
        warnings.push(`CAN CG has ${invalBytes} invalidation bytes; treating all samples as valid`)
      }
      if ((flags & 0x1) !== 0) {
        warnings.push('CAN CG has VLSD flag set; VLSD channels not supported — skipping')
        cgOff = cg.links[0]
        continue
      }
      // Walk CN chain: first CN is master (Timestamp), second carries the composition.
      let tsCn: CnInfo | null = null
      let compRoot: CnInfo | null = null
      let cnOff = cg.links[1]
      while (cnOff !== 0) {
        const info = readCn(buf, cnOff)
        const cnData = readBlock(buf, cnOff).dataOff
        const cnType = buf.readUInt8(cnData + 0)
        if (cnType === 2) tsCn = info
        else if (info.compositionLink !== 0) compRoot = info
        cnOff = nextCn(buf, cnOff)
      }
      if (!tsCn) {
        warnings.push('CAN CG missing Timestamp master — skipping')
        cgOff = cg.links[0]
        continue
      }
      if (!compRoot) {
        warnings.push('CAN CG missing CAN_DataFrame composition — skipping')
        cgOff = cg.links[0]
        continue
      }
      const subs = collectSubCns(buf, compRoot.compositionLink)
      const need = ['CAN_DataFrame.ID', 'CAN_DataFrame.IDE', 'CAN_DataFrame.DLC', 'CAN_DataFrame.DataLength', 'CAN_DataFrame.DataBytes']
      const missing = need.find((n) => !subs.has(n))
      if (missing) {
        warnings.push(`CAN CG missing sub-channel ${missing} — skipping`)
        cgOff = cg.links[0]
        continue
      }
      const id = subs.get('CAN_DataFrame.ID')!.field
      const ide = subs.get('CAN_DataFrame.IDE')!.field
      const dlc = subs.get('CAN_DataFrame.DLC')!.field
      const dataLen = subs.get('CAN_DataFrame.DataLength')!.field
      const dataBytesField = subs.get('CAN_DataFrame.DataBytes')!.field
      const edl = subs.get('CAN_DataFrame.EDL')?.field ?? null

      const layout: CanLayout = {
        recordSize: recIdSize + dataBytes + invalBytes,
        recIdSize,
        recordId,
        tsByteOff: tsCn.field.byteOffset,
        tsBitCount: tsCn.field.bitCount,
        tsCc: readLinearCc(buf, tsCn.ccLink),
        idByteOff: id.byteOffset,
        ideByteOff: ide.byteOffset,
        ideBitOff: ide.bitOffset,
        edlByteOff: edl ? edl.byteOffset : null,
        edlBitOff: edl ? edl.bitOffset : 0,
        dlcByteOff: dlc.byteOffset,
        dataLenByteOff: dataLen.byteOffset,
        dataBytesByteOff: dataBytesField.byteOffset,
        dataBytesMax: Math.floor(dataBytesField.bitCount / 8)
      }
      return { layout, dataLink }
    }
    cgOff = cg.links[0]
  }
  return null
}

export async function iterateCanRecords(
  stream: Buffer,
  layout: CanLayout,
  onProgress?: ProgressCb
): Promise<{ frames: Frame[]; fdSkipped: number; malformed: number }> {
  const frames: Frame[] = []
  let fdSkipped = 0
  let malformed = 0
  const { recordSize, recIdSize, recordId } = layout
  if (recordSize <= 0) return { frames, fdSkipped, malformed }
  const numRecords = Math.floor(stream.length / recordSize)
  for (let i = 0; i < numRecords; i++) {
    const rs = i * recordSize
    if (recIdSize > 0) {
      let rid = 0
      if (recIdSize === 1) rid = stream.readUInt8(rs)
      else if (recIdSize === 2) rid = stream.readUInt16LE(rs)
      else if (recIdSize === 4) rid = stream.readUInt32LE(rs)
      else if (recIdSize === 8) rid = Number(stream.readBigUInt64LE(rs))
      if (rid !== recordId) continue
    }
    const d = rs + recIdSize
    // Timestamp — raw u64 LE, apply linear CC if present.
    const tsRaw = Number(stream.readBigUInt64LE(d + layout.tsByteOff))
    const timestamp = layout.tsCc
      ? layout.tsCc.offset + layout.tsCc.scale * tsRaw
      : tsRaw
    // FD rejection
    if (layout.edlByteOff !== null) {
      const edlByte = stream.readUInt8(d + layout.edlByteOff)
      if (((edlByte >> layout.edlBitOff) & 1) === 1) {
        fdSkipped++
        continue
      }
    }
    const rawId = stream.readUInt32LE(d + layout.idByteOff) & 0x1fffffff
    const ideByte = stream.readUInt8(d + layout.ideByteOff)
    const extended = ((ideByte >> layout.ideBitOff) & 1) === 1
    const dataLength = stream.readUInt8(d + layout.dataLenByteOff)
    const dlen = Math.min(dataLength, 8)
    if (d + layout.dataBytesByteOff + dlen > stream.length) {
      malformed++
      continue
    }
    const data = Uint8Array.prototype.slice.call(
      stream,
      d + layout.dataBytesByteOff,
      d + layout.dataBytesByteOff + dlen
    ) as Uint8Array
    frames.push({ timestamp, id: rawId, extended, data })
    if ((i & (PARSE_CHUNK - 1)) === PARSE_CHUNK - 1) {
      onProgress?.({ stage: 'parsing', current: i + 1, total: numRecords })
      await yieldControl()
    }
  }
  onProgress?.({ stage: 'parsing', current: numRecords, total: numRecords })
  return { frames, fdSkipped, malformed }
}

export async function parseMf4(filePath: string, onProgress?: ProgressCb): Promise<Mf4ParseResult> {
  onProgress?.({ stage: 'reading', current: 0, total: 1 })
  const buf = await readFile(filePath)
  onProgress?.({ stage: 'reading', current: 1, total: 1 })

  if (buf.length < 128) throw new Error('MF4 file too small')
  const fileId = buf.toString('ascii', 0, 8)
  if (fileId !== 'MDF     ') throw new Error(`Not an MF4 file (id: ${JSON.stringify(fileId)})`)
  const version = buf.readUInt16LE(28)
  if (version < 400) throw new Error(`MF4 version ${version} too old; need >= 4.00`)

  const hd = readBlock(buf, 64)
  if (hd.id !== '##HD') throw new Error(`Expected ##HD at 64, got ${hd.id}`)

  const warnings: string[] = []
  const frames: Frame[] = []
  let fdSkipped = 0
  let malformed = 0

  let dgOff = hd.links[0]
  while (dgOff !== 0) {
    const picked = pickCanLayout(buf, dgOff, warnings)
    if (picked) {
      const stream = expandDataStream(buf, picked.dataLink)
      const res = await iterateCanRecords(stream, picked.layout, onProgress)
      for (const f of res.frames) frames.push(f)
      fdSkipped += res.fdSkipped
      malformed += res.malformed
    }
    dgOff = readBlock(buf, dgOff).links[0]
  }

  if (fdSkipped > 0) warnings.push(`Skipped ${fdSkipped} CAN-FD frame(s) — FD not supported in this phase`)
  if (malformed > 0) warnings.push(`Skipped ${malformed} malformed record(s)`)
  if (frames.length === 0) warnings.push('No CAN_DataFrame channel group found')

  // Timestamps across DGs are per-DG relative. Sort globally for monotonic x-axis.
  frames.sort((a, b) => a.timestamp - b.timestamp)

  return { frames, skipped: fdSkipped + malformed, warnings }
}
