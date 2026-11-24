#!/usr/bin/env node
/**
 * Prints the Claude Code hook configuration for this checkout, with the
 * absolute path to hooks/log-activity.js already filled in. Paste the output
 * into ~/.claude/settings.json (all projects) or <project>/.claude/settings.json.
 */
const path = require('path');

const hook = path.resolve(__dirname, '..', 'hooks', 'log-activity.js').replace(/\\/g, '/');
const autostart = path.resolve(__dirname, 'autostart.js').replace(/\\/g, '/');

const config = {
  hooks: {
    SessionStart: [
      {
        matcher: 'startup',
        hooks: [{ type: 'command', command: `node "${autostart}"` }],
      },
      {
        // records where each session was opened (startup, resume, /clear)
        hooks: [{ type: 'command', command: `node "${hook}"` }],
      },
    ],
    SessionEnd: [
      {
        // marks the session as closed, so the UI stops showing it as live
        hooks: [{ type: 'command', command: `node "${hook}"` }],
      },
    ],
    PreToolUse: [
      {
        // snapshots the working directory so the files a command changed can be found
        matcher: 'Bash|PowerShell',
        hooks: [{ type: 'command', command: `node "${hook}"` }],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep|Bash|PowerShell',
        hooks: [{ type: 'command', command: `node "${hook}"` }],
      },
    ],
  },
};

console.log(JSON.stringify(config, null, 2));
