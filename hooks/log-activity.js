#!/usr/bin/env node
/**
 * Neural Web — Claude Code hook.
 *
 * Claude Code pipes a JSON payload describing each hook event to this script on
 * stdin. We turn file/directory-touching tools into JSON lines appended to the
 * activity log, which the Neural Web server tails and streams to the UI.
 *
 * Events handled:
 *   SessionStart  -> where the session was opened (its root neuron)
 *   SessionEnd    -> the session closed (the UI stops showing it as live)
 *   PreToolUse    -> (Bash/PowerShell only) snapshot the working directory
 *   PostToolUse   -> what the tool touched; for shell commands, the files that
 *                    changed since the snapshot plus the files named in the command
 *
 * This script must never block or break Claude Code: every failure is
 * swallowed and the process always exits 0 without writing to stdout.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG =
  process.env.NEURAL_WEB_LOG ||
  path.join(os.homedir(), '.claude', 'neural-web', 'activity.jsonl');
const SNAP_DIR = path.join(os.tmpdir(), 'neural-web-snapshots');

// tool name -> action shown in the UI
const ACTIONS = {
  Read: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Glob: 'search',
  Grep: 'search',
  Bash: 'exec',
  PowerShell: 'exec',
};

// directories never worth scanning for shell-command changes
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  'dist', 'build', 'out', 'coverage', 'target', 'vendor', '.venv', 'venv', '__pycache__',
  '.idea', '.vs', '.gradle', 'bin', 'obj',
]);
const SNAP_MAX_FILES = 20000;
const SNAP_BUDGET_MS = 400;
const MAX_CHANGED = 60; // cap on per-file events from one command
const MAX_REFERENCED = 15;

// Safety net: never hang if stdin is not closed for some reason.
setTimeout(() => process.exit(0), 4000).unref();

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    record(JSON.parse(raw));
  } catch {
    /* ignore malformed payloads */
  }
  process.exit(0);
});

function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

function append(events) {
  if (!events.length) return;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, events.map((e) => JSON.stringify(e) + '\n').join(''));
}

let seq = 0;
const newId = () =>
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + (seq++ ? '-' + seq : '');

function kindOf(p, guess) {
  try {
    return fs.statSync(p).isDirectory() ? 'dir' : 'file';
  } catch {
    return guess;
  }
}

/* ---------- working-directory snapshots (for shell commands) ---------- */

// { files: {relPath: "mtime:size"}, done: [relDir...] } — `done` lists the
// directories that were read completely, so a truncated scan never reports
// files it simply did not reach as created or deleted.
function snapshot(root) {
  const files = {};
  const done = [];
  const start = Date.now();
  let count = 0;
  const queue = [''];
  while (queue.length) {
    if (count >= SNAP_MAX_FILES || Date.now() - start > SNAP_BUDGET_MS) break;
    const rel = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(r);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(path.join(root, r));
          files[r] = st.mtimeMs + ':' + st.size;
        } catch {
          /* vanished */
        }
        count++;
      }
    }
    done.push(rel);
  }
  return { files, done };
}

const snapFile = (payload) =>
  path.join(
    SNAP_DIR,
    String(payload.tool_use_id || payload.session_id || 'unknown').replace(/[^\w.-]/g, '_') + '.json'
  );

function saveSnapshot(payload, cwd) {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  fs.writeFileSync(snapFile(payload), JSON.stringify({ cwd, ...snapshot(cwd) }));
  // tidy up snapshots whose PostToolUse never came (interrupted commands)
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(SNAP_DIR)) {
      const p = path.join(SNAP_DIR, f);
      if (now - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(p);
    }
  } catch {
    /* ignore */
  }
}

function loadSnapshot(payload) {
  const file = snapFile(payload);
  try {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    return snap;
  } catch {
    return null;
  }
}

// files created / modified / deleted under cwd between the two snapshots
function diffSnapshots(before, after) {
  const changes = [];
  const doneBefore = new Set(before.done);
  const doneAfter = new Set(after.done);
  const dirOf = (r) => (r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : '');
  for (const [r, sig] of Object.entries(after.files)) {
    if (!(r in before.files)) {
      if (doneBefore.has(dirOf(r))) changes.push({ rel: r, action: 'write' });
    } else if (before.files[r] !== sig) {
      changes.push({ rel: r, action: 'edit' });
    }
  }
  for (const r of Object.keys(before.files)) {
    if (!(r in after.files) && doneAfter.has(dirOf(r))) changes.push({ rel: r, action: 'delete' });
  }
  return changes;
}

// existing files/directories named in the command text (e.g. `node server.js`, `cat "a b.txt"`)
function referencedPaths(command, cwd) {
  const out = [];
  const seen = new Set();
  const tokens = String(command || '').match(/"[^"]*"|'[^']*'|[^\s|&;<>()]+/g) || [];
  for (let t of tokens) {
    t = t.replace(/^["']|["']$/g, '').replace(/^[a-z-]+=/i, ''); // --flag=path
    if (!t || t.length > 400 || t.startsWith('-') || /[*?$`{}]/.test(t) || /^[a-z]+:\/\//i.test(t)) continue;
    if (t === '.' || t === '..' || t === '/' || t === '~') continue;
    if (t.startsWith('~/')) t = path.join(os.homedir(), t.slice(2));
    const abs = path.isAbsolute(t) ? t : path.resolve(cwd, t);
    const key = norm(abs).toLowerCase();
    if (seen.has(key) || key === norm(cwd).toLowerCase()) continue;
    // drive roots and the home folder say nothing about where the command worked
    if (path.parse(abs).root === abs || /^[a-z]:\/?$|^\/$/i.test(norm(abs)) || key === norm(os.homedir()).toLowerCase()) continue;
    try {
      const st = fs.statSync(abs);
      seen.add(key);
      out.push({ abs, kind: st.isDirectory() ? 'dir' : 'file' });
    } catch {
      /* not a path */
    }
    if (out.length >= MAX_REFERENCED) break;
  }
  return out;
}

/* ---------- main ---------- */

function record(payload) {
  const cwd = payload.cwd || process.cwd();
  const event = payload.hook_event_name;
  const base = {
    session: payload.session_id || 'unknown',
    cwd: norm(cwd),
  };
  const ev = (fields) => ({ id: newId(), ts: Date.now(), ...base, ...fields });

  // SessionStart: remember where the session was opened (its root neuron).
  if (event === 'SessionStart') {
    if (payload.source === 'compact') return; // same session, nothing new
    append([ev({ tool: 'SessionStart', action: 'start', path: norm(cwd), kind: 'dir' })]);
    return;
  }

  // SessionEnd: the console was closed / cleared.
  if (event === 'SessionEnd') {
    append([ev({ tool: 'SessionEnd', action: 'end', path: norm(cwd), kind: 'dir' })]);
    return;
  }

  const tool = payload.tool_name;
  const action = ACTIONS[tool];
  if (!action) return;
  const input = payload.tool_input || {};

  // PreToolUse: only used to snapshot the folder before a shell command runs.
  if (event === 'PreToolUse') {
    if (action === 'exec') saveSnapshot(payload, cwd);
    return;
  }

  if (action === 'exec') {
    const events = [];
    const touched = new Set();
    const before = loadSnapshot(payload);
    if (before && norm(before.cwd) === norm(cwd)) {
      const changes = diffSnapshots(before, snapshot(cwd)).slice(0, MAX_CHANGED);
      for (const c of changes) {
        const p = norm(path.join(cwd, c.rel));
        touched.add(p.toLowerCase());
        events.push(ev({ tool, action: c.action, path: p, kind: 'file' }));
      }
    }
    for (const r of referencedPaths(input.command, cwd)) {
      const p = norm(r.abs);
      if (touched.has(p.toLowerCase())) continue;
      events.push(ev({ tool, action: 'exec', path: p, kind: r.kind }));
    }
    // nothing specific found: the command just ran in its working directory
    if (!events.length) events.push(ev({ tool, action, path: norm(cwd), kind: 'dir' }));
    append(events);
    return;
  }

  // Which path did the tool touch?
  let target = input.file_path || input.notebook_path || input.path || cwd;
  if (!path.isAbsolute(target)) target = path.resolve(cwd, target);
  const kind = kindOf(target, input.file_path || input.notebook_path ? 'file' : 'dir');
  append([ev({ tool, action, path: norm(target), kind })]);
}
