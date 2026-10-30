import { deflateSync } from 'node:zlib'

/** A real PNG of the given size (solid colour), built from its chunks. */
export function png(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)))
    return out
  }
  const header = new Uint8Array(13)
  const hv = new DataView(header.buffer)
  hv.setUint32(0, width)
  hv.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8) // 8-bit RGB
  const rows = new Uint8Array((width * 3 + 1) * height)
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) out.set(p, (offset += p.length) - p.length)
  return out
}

/** The start of a JPEG (SOI, JFIF APP0, SOF0 with the size). Enough for sniffing and dimensions. */
export function jpegHeader(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ])
}

/** A minimal Windows executable header (MZ + PE signature). */
export function exe(): Uint8Array {
  const bytes = new Uint8Array(512)
  bytes.set([0x4d, 0x5a], 0)
  new DataView(bytes.buffer).setUint32(0x3c, 0x80, true)
  bytes.set([0x50, 0x45, 0x00, 0x00, 0x4c, 0x01], 0x80)
  return bytes
}

export const file = (bytes: Uint8Array | string, name: string, type = 'application/octet-stream') => new File([bytes as BlobPart], name, { type })
