/** Width and height from an image's header bytes (PNG, GIF, JPEG, WebP), without decoding it. */
export function imageSize(bytes: Uint8Array, mime: string): { width: number; height: number } | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fits = (n: number) => bytes.length >= n
  if (mime === 'image/png' && fits(24)) return { width: view.getUint32(16), height: view.getUint32(20) }
  if (mime === 'image/gif' && fits(10)) return { width: view.getUint16(6, true), height: view.getUint16(8, true) }
  if (mime === 'image/webp' && fits(30)) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16))
    if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X') return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) }
  }
  if (mime === 'image/jpeg') {
    // Walk the segments to the first start-of-frame marker (SOF0–SOF15, not DHT/JPG/DAC).
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return undefined
      const marker = bytes[offset + 1]!
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      }
      offset += 2 + view.getUint16(offset + 2)
    }
  }
  return undefined
}
