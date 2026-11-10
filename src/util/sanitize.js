import path from 'node:path';

export function clean(value, max = 80, left = false) {
  if (value == null) return null;
  const text = String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  if (/(api[_-]?key|token|secret|password)\s*[=:]/i.test(text) || /[A-Za-z0-9+/=]{32,}/.test(text)) return '[redacted]';
  const chars = [...text];
  return (left ? chars.slice(-max) : chars.slice(0, max)).join('');
}
export function basename(value) {
  return path.posix.basename(String(value).replaceAll('\\', '/').replace(/\/+$/, ''));
}
export function textSnippet(text) {
  return typeof text === 'string' ? clean(text.slice(0, 120), 120) : null;
}
export function timestamp(value, now) {
  return typeof value === 'number' ? value : Date.parse(value) || now();
}
export const taskStatus = status => ({ completed: 'done', in_progress: 'active', pending: 'pending', cancelled: 'cancelled', done: 'done', active: 'active' })[status];
