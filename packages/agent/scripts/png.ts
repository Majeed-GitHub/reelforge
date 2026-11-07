/**
 * Minimal PNG reader for verification scripts.
 *
 * Why not a library: the repo has no image dependency in Node, and the point of
 * the redaction test is to prove that the *saved PNG bytes* contain black boxes.
 * Chromium screenshots are 8-bit RGB/RGBA, non-interlaced; that is all this
 * decodes. Anything else throws instead of silently reporting wrong pixels.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

export type Rgba = { r: number; g: number; b: number; a: number };

export type PngImage = {
  width: number;
  height: number;
  /** Pixel at CSS px coordinates (device scale factor is 1 in these runs). */
  pixel: (x: number, y: number) => Rgba;
  /** True when every channel is at/below the threshold (opaque mask black). */
  isBlack: (x: number, y: number, threshold?: number) => boolean;
  /** Average colour over a rectangle (used for visual diffing regions). */
  average: (x: number, y: number, width: number, height: number) => Rgba;
};

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

type Header = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
};

function readHeader(buffer: Buffer): Header {
  if (buffer.length < 24) throw new Error('not a PNG: too short');
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (buffer[index] !== PNG_SIGNATURE[index]) throw new Error('not a PNG: bad signature');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height, bitDepth: buffer[24], colorType: buffer[25], interlace: buffer[28] };
}

function paeth(left: number, up: number, upLeft: number): number {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upLeft;
}

export function readPng(input: string | Buffer): PngImage {
  const buffer = typeof input === 'string' ? fs.readFileSync(input) : input;
  const header = readHeader(buffer);
  if (header.bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${header.bitDepth}`);
  if (header.interlace !== 0) throw new Error('interlaced PNGs are not supported');
  if (header.colorType !== 2 && header.colorType !== 6) {
    throw new Error(`unsupported PNG colour type ${header.colorType} (expected RGB or RGBA)`);
  }

  const channels = header.colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (idat.length === 0) throw new Error('PNG has no image data');

  const inflated = zlib.inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const raw = Buffer.alloc(header.height * stride);

  let source = 0;
  for (let row = 0; row < header.height; row += 1) {
    const filter = inflated[source];
    source += 1;
    const rowStart = row * stride;
    const previousStart = rowStart - stride;
    for (let column = 0; column < stride; column += 1) {
      const rawValue = inflated[source + column];
      const left = column >= channels ? raw[rowStart + column - channels] : 0;
      const up = row > 0 ? raw[previousStart + column] : 0;
      const upLeft = row > 0 && column >= channels ? raw[previousStart + column - channels] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = rawValue;
          break;
        case 1:
          value = rawValue + left;
          break;
        case 2:
          value = rawValue + up;
          break;
        case 3:
          value = rawValue + Math.floor((left + up) / 2);
          break;
        case 4:
          value = rawValue + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unsupported PNG filter ${filter} on row ${row}`);
      }
      raw[rowStart + column] = value & 0xff;
    }
    source += stride;
  }

  const pixel = (x: number, y: number): Rgba => {
    const px = Math.max(0, Math.min(header.width - 1, Math.round(x)));
    const py = Math.max(0, Math.min(header.height - 1, Math.round(y)));
    const index = py * stride + px * channels;
    return {
      r: raw[index],
      g: raw[index + 1],
      b: raw[index + 2],
      a: channels === 4 ? raw[index + 3] : 255
    };
  };

  return {
    width: header.width,
    height: header.height,
    pixel,
    isBlack: (x, y, threshold = 8) => {
      const colour = pixel(x, y);
      return colour.r <= threshold && colour.g <= threshold && colour.b <= threshold;
    },
    average: (x, y, width, height) => {
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let row = Math.max(0, Math.round(y)); row < Math.min(header.height, Math.round(y + height)); row += 1) {
        for (let column = Math.max(0, Math.round(x)); column < Math.min(header.width, Math.round(x + width)); column += 1) {
          const colour = pixel(column, row);
          r += colour.r;
          g += colour.g;
          b += colour.b;
          count += 1;
        }
      }
      if (count === 0) return { r: 0, g: 0, b: 0, a: 255 };
      return { r: r / count, g: g / count, b: b / count, a: 255 };
    }
  };
}
