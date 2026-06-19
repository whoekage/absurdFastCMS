/**
 * be-04 MEDIA test fixtures — REAL, minimal but valid image byte buffers (no mocks, no library). The
 * dimensions are encoded in the headers so `image-size` reads them back exactly. A non-image fixture is a
 * plain text buffer (image-size throws => null dimensions).
 */

/** A real 1x1 (here sized 2x3) PNG: 8-byte signature + IHDR chunk carrying width/height + a CRC. */
export function pngBytes(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // IHDR: length(13) + 'IHDR' + width(4) + height(4) + bitDepth + colorType + compression + filter + interlace + CRC.
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);
  // A minimal IDAT + IEND so it is a well-formed (if tiny) PNG stream.
  const idat = chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01]));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Tiny CRC32 (PNG-spec polynomial) so the chunks are valid; image-size doesn't verify CRC but real
// tooling does, so we keep the fixture honest.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A plain UTF-8 text buffer — NOT an image, so metadata extraction yields null dimensions. */
export function textBytes(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}
