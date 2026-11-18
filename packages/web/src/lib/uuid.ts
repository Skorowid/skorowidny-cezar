/** RFC 9562 UUIDv7: 48-bit Unix-ms timestamp, then random bits. Used for idempotency keys. */
export function uuidv7(now: number = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  for (let i = 0; i < 6; i++) b[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
