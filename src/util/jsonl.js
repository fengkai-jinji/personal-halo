export function parseJSON(line, onError) {
  try { return JSON.parse(line); }
  catch { onError('JSONParse'); return undefined; }
}

// Retain only an unfinished line; the decoder must survive split UTF-8 bytes.
export function splitLines(chunk, state, onLine) {
  let start = 0;
  let end;
  while ((end = chunk.indexOf(10, start)) !== -1) {
    const tail = chunk.subarray(start, end);
    const bytes = state.partial ? Buffer.concat([...state.partial, tail]) : tail;
    if (bytes.length) onLine(bytes.toString('utf8'));
    state.partial = null;
    start = end + 1;
  }
  // Accumulating fragments avoids copying an entire long line for every 64KB read.
  if (start < chunk.length) (state.partial ??= []).push(Buffer.from(chunk.subarray(start)));
}
