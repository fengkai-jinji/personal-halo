// Derived from agent-halo (commit 4a22a69c6ad9) collector/src/util/zstd.js
// under PolyForm Noncommercial 1.0.0. Change for personal-halo: a lenient
// variant that tolerates torn trailing frames (the source appends frame by
// frame, so the last frame is regularly incomplete mid-write).
import { zstdDecompressSync } from 'node:zlib';

// Walk one frame starting at pos; returns the end offset. Throws Zstd* on
// malformed or incomplete frames.
function frameEnd(bytes, pos) {
  const magic = bytes.readUInt32LE(pos);
  pos += 4;
  if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) return pos + 4 + bytes.readUInt32LE(pos);
  if (magic !== 0xfd2fb528) throw new Error('ZstdFrame');
  const descriptor = bytes[pos++];
  const single = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const sizeFlag = descriptor >> 6;
  pos += (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3];
  pos += sizeFlag === 0 ? single : [0, 2, 4, 8][sizeFlag];
  let last = false;
  while (!last) {
    const block = bytes.readUIntLE(pos, 3);
    pos += 3;
    last = Boolean(block & 1);
    const type = (block >> 1) & 3;
    if (type === 3) throw new Error('ZstdBlock');
    pos += type === 1 ? 1 : block >> 3;
  }
  pos += checksum * 4;
  if (pos > bytes.length) throw new Error('ZstdIncomplete');
  return pos;
}

// Node's decoder stops at the first frame on the installed runtime.
export function decompressFrames(bytes) {
  const chunks = [];
  let pos = 0;
  while (pos < bytes.length) {
    const start = pos;
    pos = frameEnd(bytes, pos);
    chunks.push(zstdDecompressSync(bytes.subarray(start, pos)));
  }
  return Buffer.concat(chunks);
}

// Torn trailing frames are normal while a session log is being appended: decode
// the longest prefix of complete frames and drop the incomplete tail so earlier
// records stay usable. The tail completes on a later append and is then read in
// full (the caller tracks a line cursor over the decoded stream).
export function decompressFramesLenient(bytes) {
  const chunks = [];
  let pos = 0;
  let droppedTail = false;
  while (pos < bytes.length) {
    const start = pos;
    let end;
    let decoded;
    try {
      end = frameEnd(bytes, pos);
      decoded = zstdDecompressSync(bytes.subarray(start, end));
    } catch {
      droppedTail = true;
      break;
    }
    chunks.push(decoded);
    pos = end;
  }
  return { data: Buffer.concat(chunks), droppedTail };
}
