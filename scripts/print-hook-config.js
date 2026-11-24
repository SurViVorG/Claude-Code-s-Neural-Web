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
