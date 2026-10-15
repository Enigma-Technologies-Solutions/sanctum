// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Enigma Technologies Solutions
//
// Pixel size of a PNG or WebP, read from the header. No decoding and no dependencies.

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');

/** `{ width, height }`, or throws if the bytes are not a PNG or WebP we can read. */
export function imageSize(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_MAGIC) && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return { type: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 30 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      return { type: 'webp', width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    if (chunk === 'VP8 ') {
      return { type: 'webp', width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const b = bytes.readUInt32LE(21);
      return { type: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  throw new Error('not a PNG or WebP image');
}
