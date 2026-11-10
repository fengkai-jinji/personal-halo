import { basename, clean, taskStatus } from './sanitize.js';
import { parseJSON } from './jsonl.js';

export function extractTarget(tool, raw, detail = 'basic', onError = () => {}) {
  return extractToolTarget(tool, raw, detail, onError).target;
}

export function extractToolTarget(tool, raw, detail = 'basic', onError = () => {}) {
  const name = tool.split('.').at(-1);
  if (name === 'exec' || name === 'Script') return { target: codeTarget(typeof raw === 'string' ? raw : raw?.script ?? raw?.code), files: [] };
  const patch = name === 'apply_patch';
  const args = typeof raw === 'string' && !patch ? parseJSON(raw, onError) : raw;
  const patchText = patch ? (typeof raw === 'string' ? raw : args?.patchText) : null;
  const paths = patchText ? [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1]) : [];
  const file = paths[0] ?? args?.file_path ?? args?.filePath ?? args?.path ?? args?.absolute_path ?? args?.notebook_path;
  if (file) {
    const suffix = paths.length > 1 ? ` +${paths.length - 1}` : '';
    const writes = /(?:^|__)(?:edit|multiedit|multi_edit|write|create|apply_patch|create_file|write_file|edit_file|writefile|editfile|createfile|strreplacefile|replace_in_file|notebookedit)$/i.test(name);
    return {
      target: clean((detail === 'basic' ? basename(file) : clean(file, 80 - suffix.length, true)) + suffix, 80, true),
      files: writes ? [...new Set((paths.length ? paths : [file]).map(f => clean(basename(f), 80)))] : [],
    };
  }
  let command = args?.command ?? args?.cmd;
  if (!command) return { target: null, files: [] };
  if (Array.isArray(command)) command = /^(?:bash|sh|powershell|pwsh)(?:\.exe)?$/i.test(basename(command[0])) && /^-(?:lc|c|Command)$/i.test(command[1]) ? command.at(-1) : command.join(' ');
  if (detail === 'full') return { target: clean(command, 80), files: [] };
  const segments = command.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean);
  const words = (segments.find(s => !/^(?:cd|pushd|set-location|sl)\b|^\$env:/i.test(s)) ?? segments[0] ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '') || words[0] === 'sudo') words.shift();
  if (!words.length) return { target: null, files: [] };
  const program = basename(words[0].replace(/^['"]|['"]$/g, '')).replace(/\.(exe|cmd)$/i, '');
  return { target: clean(program + (/^[A-Za-z][A-Za-z0-9_]*$/.test(words[1] ?? '') ? ' ' + words[1] : ''), 80), files: [] };
}

// Code-mode tools carry a whole program; only the nested tool names are exposed.
function codeTarget(code) {
  if (typeof code !== 'string') return null;
  const names = [...code.matchAll(/\btools\.([A-Za-z_][\w]*)\s*\(/g)].map(m => m[1]);
  if (!names.length) return null;
  const same = names.every(n => n === names[0]);
  return clean(names[0] + (names.length > 1 ? (same ? ` ×${names.length}` : ` +${names.length - 1}`) : ''), 80);
}

// Plan/todo arguments have one expressly permitted output: the todo list.
export function extractTasks(tool, raw, onError = () => {}) {
  const name = tool.split('.').at(-1);
  if (!['TodoWrite','update_plan','write_todos','todo_write'].includes(name)) return null;
  const args = typeof raw === 'string' ? parseJSON(raw, onError) : raw;
  if (name === 'update_plan') return (args?.plan ?? []).map(i => ({ text: i.step, status: taskStatus(i.status) })).filter(i => i.status);
  if (typeof args?.todos === 'string') return args.todos.split('\n').flatMap(line => {
    const m = line.match(/^\s*\d+\.\s*\[(completed|in_progress|pending|cancelled)\]\s*(.*)$/);
    return m ? [{ text: m[2], status: taskStatus(m[1]) }] : [];
  });
  return (args?.todos ?? []).map(i => ({ text: i.status === 'in_progress' ? i.activeForm ?? i.content : i.content, status: taskStatus(i.status) })).filter(i => i.status);
}

// Read only result metadata; output bodies are never copied into signals.
export function codexToolOK(output) {
  const blocks = Array.isArray(output) ? output : [{ text: output }];
  for (const b of blocks) {
    const text = b.text;
    if (typeof text !== 'string') continue;
    if (/^\s*\{/.test(text)) {
      const meta = parseJSON(text, () => {});
      if (meta?.isError === true || meta?.exit_code > 0) return false;
    }
    if (/^Process exited with code\s+[1-9]\d*/m.test(text)) return false;
  }
  return true;
}
