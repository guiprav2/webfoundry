/**
 * Minimal ustar + gzip builder for Nasty overlay payloads (browser + Node).
 * Compatible with `tar -xzf` used by nasty-bundle overlay-boot.
 * Uses CompressionStream (available in modern browsers and Node 20+).
 */

const BLOCK = 512;

async function gzipBytes(uint8) {
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([uint8]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gzipSync } = await import('node:zlib');
  return gzipSync(uint8);
}

function encodeOctal(value, length) {
  const s = Math.max(0, value | 0).toString(8);
  return s.padStart(length - 1, '0') + '\0';
}

function checksum(header) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  return sum;
}

function writeString(buf, offset, str, length) {
  const bytes = new TextEncoder().encode(str);
  buf.set(bytes.subarray(0, length - 1), offset);
}

/**
 * @param {Record<string, Uint8Array|string|Blob>} files path → content
 * @returns {Promise<Uint8Array>} gzip-compressed ustar
 */
export async function createTarGz(files) {
  const parts = [];
  for (const [rawPath, content] of Object.entries(files)) {
    let path = rawPath.replace(/^\/+/, '');
    if (!path || path.endsWith('/')) continue;
    let data;
    if (content instanceof Uint8Array) data = content;
    else if (typeof content === 'string') data = new TextEncoder().encode(content);
    else if (content instanceof Blob) data = new Uint8Array(await content.arrayBuffer());
    else data = new TextEncoder().encode(String(content));

    const header = new Uint8Array(BLOCK);
    writeString(header, 0, path, 100);
    writeString(header, 100, encodeOctal(0o644, 8), 8);
    writeString(header, 108, encodeOctal(0, 8), 8);
    writeString(header, 116, encodeOctal(0, 8), 8);
    writeString(header, 124, encodeOctal(data.length, 12), 12);
    writeString(header, 136, encodeOctal(Math.floor(Date.now() / 1000), 12), 12);
    header.fill(0x20, 148, 156); // checksum field spaces
    header[156] = '0'.charCodeAt(0); // regular file
    writeString(header, 257, 'ustar', 6);
    writeString(header, 263, '00', 2);
    const sum = checksum(header);
    writeString(header, 148, encodeOctal(sum, 8), 8);
    // GNU/ustar checksum is 6 octal digits + NUL + space — write carefully
    const chk = sum.toString(8).padStart(6, '0');
    for (let i = 0; i < 6; i++) header[148 + i] = chk.charCodeAt(i);
    header[154] = 0;
    header[155] = 0x20;

    parts.push(header);
    parts.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2)); // end blocks
  const total = parts.reduce((n, p) => n + p.length, 0);
  const tar = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    tar.set(p, o);
    o += p.length;
  }
  return gzipBytes(tar);
}

export const OVERLAY_MAGIC = new TextEncoder().encode('NASTYOV1');

/**
 * Concatenate runtime AppImage + tar.gz overlay + trailer.
 * @param {Blob|ArrayBuffer|Uint8Array} runtime
 * @param {Uint8Array} tarGz
 * @returns {Blob}
 */
export function appendOverlay(runtime, tarGz) {
  const footer = new Uint8Array(16);
  const view = new DataView(footer.buffer);
  view.setBigUint64(0, BigInt(tarGz.length), true);
  footer.set(OVERLAY_MAGIC, 8);
  return new Blob([runtime, tarGz, footer], { type: 'application/octet-stream' });
}
