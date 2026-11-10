// Only the four product sources are registered. Adding more adapters would
// widen the read-only surface into unrelated user directories.
import codex from './codex.js';
import dsh from './dsh.js';
import zcode from './zcode.js';
import workbuddy from './workbuddy.js';

export default [codex, dsh, zcode, workbuddy];
