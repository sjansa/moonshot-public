// tiff.js -- the one TIFF the elevation service sends: uncompressed, one band of 32-bit floats,
// in strips or tiles. No DOM. -> {width, height, data: Float32Array (row-major, top row first)}
export function readFloatTiff(buf) {
  const v = new DataView(buf), le = v.getUint16(0) === 0x4949;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  if (u16(2) !== 42) throw new Error('Not a TIFF.');
  const ifd = u32(4), n = u16(ifd), tags = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12, tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = type === 3 ? 2 : 4, at = count * size <= 4 ? e + 8 : u32(e + 8);
    const vals = [];
    for (let k = 0; k < count; k++) vals.push(type === 3 ? u16(at + k * 2) : u32(at + k * 4));
    tags[tag] = vals;
  }
  const W = tags[256][0], H = tags[257][0], bps = tags[258]?.[0], comp = tags[259]?.[0] ?? 1, fmt = tags[339]?.[0] ?? 1;
  if (bps !== 32 || fmt !== 3 || comp !== 1) throw new Error('Unsupported elevation TIFF.');
  const data = new Float32Array(W * H);
  const put = (off, x0, y0, w, h, stride) => {          // a block of w x h floats at off, rows `stride` floats apart
    for (let y = 0; y < h && y0 + y < H; y++) for (let x = 0; x < w && x0 + x < W; x++) data[(y0 + y) * W + x0 + x] = v.getFloat32(off + (y * stride + x) * 4, le);
  };
  if (tags[324]) {                                       // tiles
    const tw = tags[322][0], th = tags[323][0], across = Math.ceil(W / tw);
    tags[324].forEach((off, i) => put(off, (i % across) * tw, Math.floor(i / across) * th, tw, th, tw));
  } else {                                               // strips
    const rps = tags[278]?.[0] ?? H;
    tags[273].forEach((off, i) => put(off, 0, i * rps, W, rps, W));
  }
  return { width: W, height: H, data };
}
