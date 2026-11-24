#!/usr/bin/env node
/**
 * Neural Web — Claude Code PostToolUse hook.
 *
 * Claude Code pipes a JSON payload describing each tool call to this script on
 * stdin. We turn file/directory-touching tools into one JSON line appended to
 * the activity log, which the Neural Web server tails and streams to the UI.
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

// Safety net: never hang if stdin is not closed for some reason.
setTimeout(() => process.exit(0), 3000).unref();

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

function append(event) {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(event) + '\n');
}

const newId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

function record(payload) {
  const cwd = payload.cwd || process.cwd();

  // SessionStart: remember where the session was opened (its root neuron).
  if (payload.hook_event_name === 'SessionStart') {
    if (payload.source === 'compact') return; // same session, nothing new
    append({
      id: newId(),
      ts: Date.now(),
      session: payload.session_id || 'unknown',
      cwd: norm(cwd),
      tool: 'SessionStart',
      action: 'start',
      path: norm(cwd),
      kind: 'dir',
    });
    return;
  }

  const tool = payload.tool_name;
  const action = ACTIONS[tool];
  if (!action) return;

  const input = payload.tool_input || {};

  // Which path did the tool touch? Shell commands map to the working directory.
  let target = input.file_path || input.notebook_path || input.path || cwd;
  if (action === 'exec') target = cwd;
  if (!path.isAbsolute(target)) target = path.resolve(cwd, target);

  let kind = input.file_path || input.notebook_path ? 'file' : 'dir';
  try {
    kind = fs.statSync(target).isDirectory() ? 'dir' : 'file';
  } catch {
    /* path may not exist (e.g. failed read); keep the guess */
  }

  append({
    id: newId(),
    ts: Date.now(),
    session: payload.session_id || 'unknown',
    cwd: norm(cwd),
    tool,
    action,
    path: norm(target),
    kind,
  });
}
