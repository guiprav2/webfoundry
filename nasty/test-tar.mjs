/**
 * Quick check that tar.js builds a trailer-compatible payload (Node).
 * Run: node nasty/test-tar.mjs [path/to/nasty-runtime-x86_64.AppImage]  (default: Nasty's runtime cache)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createTarGz, appendOverlay, OVERLAY_MAGIC } from './tar.js';

const files = {
  'main.js': 'console.log("hi")\n',
  '.nasty-entry': 'main.js\n',
};
const tarGz = await createTarGz(files);
const runtime = readFileSync(process.argv[2] || `${homedir()}/prog/nasty-tools/appimage/nasty-runtime-x86_64.AppImage`);
const blob = appendOverlay(runtime.buffer.slice(runtime.byteOffset, runtime.byteOffset + runtime.byteLength), tarGz);
const buf = new Uint8Array(await blob.arrayBuffer());
const magic = buf.subarray(buf.length - 8);
if (Buffer.from(magic).compare(Buffer.from(OVERLAY_MAGIC)) !== 0) {
  throw new Error('bad magic');
}
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const len = Number(view.getBigUint64(buf.length - 16, true));
if (len !== tarGz.length) throw new Error(`length mismatch ${len} vs ${tarGz.length}`);
writeFileSync('/tmp/wf-export-smoke.AppImage', buf);
console.log('ok', buf.length, 'overlay', len);
