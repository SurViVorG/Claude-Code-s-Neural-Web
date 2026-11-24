# Neural Web

A live, neural-network style map of the files and directories **Claude Code** is working in.

Every time Claude reads, edits, writes, searches, or runs a command, a signal fires from
the project's root "neuron" down the directory "dendrites" to the file it touched. Active
neurons glow in the colour of the last action and slowly fade back to rest, so at a glance
you can see where Claude is working right now and where it has been.

```
            ┌──────────── Claude Code ────────────┐
            │  Read / Edit / Write / Grep / Bash  │
            └──────────────────┬──────────────────┘
                               │ PostToolUse hook (JSON on stdin)
                               ▼
                    hooks/log-activity.js
                               │ appends one line per touch
                               ▼
              ~/.claude/neural-web/activity.jsonl
                               │ tailed by
                               ▼
                server.js  ──SSE──▶  browser (public/index.html)
```

No dependencies: just Node.js 18+.

## Quick start

### 1. Try the demo (no setup)

```bash
npm run demo
```

Open <http://localhost:4747>. You will see a fake project being worked on, so you can get
a feel for the UI before wiring it to Claude Code.

### 2. Install the hook

Claude Code tells the Neural Web what it is doing through a
[`PostToolUse` hook](https://docs.claude.com/en/docs/claude-code/hooks). Print the hook
configuration for your checkout (the absolute path is filled in for you):

```bash
npm run hook-config
```

It prints something like:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "node \"/path/to/neural-web/scripts/autostart.js\"" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep|Bash|PowerShell",
        "hooks": [
          { "type": "command", "command": "node \"/path/to/neural-web/hooks/log-activity.js\"" }
        ]
      }
    ]
  }
}
```

Merge it into one of Claude Code's settings files:

| File | Scope |
| --- | --- |
| `~/.claude/settings.json` | every project on your machine (recommended) |
| `<project>/.claude/settings.json` | one project, shared with your team |
| `<project>/.claude/settings.local.json` | one project, just for you |

If the file already has a `"hooks"` section, add the `SessionStart` and `PostToolUse`
entries to it instead of replacing it. Restart Claude Code (or run `/hooks` to check it was
picked up).

The hooks do different jobs:

- **`PostToolUse`** records every file Claude touches. This one is required.
- **`SessionStart` → `log-activity.js`** records the folder each session was opened in, so it
  becomes that session's root neuron straight away, before Claude touches anything.
- **`SessionStart`** (optional) opens the Neural Web automatically: when a Claude Code
  session starts and the server is not running yet, it starts the server in the background
  and opens <http://localhost:4747> in your browser. If the server is already running it
  does nothing, so new sessions don't open extra tabs. Set `NEURAL_WEB_NO_BROWSER=1` to
  start the server without opening the browser. Leave this hook out if you prefer to run
  `npm start` yourself.

> On Windows, `~` is `C:\Users\<you>`, so the global file is
> `C:\Users\<you>\.claude\settings.json`.

### 3. Start the Neural Web

With the `SessionStart` hook installed, just start Claude Code: the UI opens by itself.
Otherwise run:

```bash
npm start
```

and open <http://localhost:4747>, then start a Claude Code session in any project. Neurons appear
as soon as Claude touches a file.

## Using the Neural Web

### Reading the map

| Element | Meaning |
| --- | --- |
| Big white-cored neuron | Project root (the directory Claude Code was started in) |
| Ringed neuron | Directory — grows with the number of children |
| Solid neuron | File — grows with the number of times it was touched |
| Travelling spark | A tool call happening right now, flowing from the root to its target |
| Expanding ring | The moment the target was reached |
| Glow | Recent activity; fades out over ~20 seconds |

Colours show the last action on each neuron:

| Colour | Action | Tools |
| --- | --- | --- |
| 🔵 cyan | read | `Read` |
| 🟣 magenta | edit | `Edit`, `MultiEdit`, `NotebookEdit` |
| 🟠 orange | write | `Write` (create / overwrite) |
| 🟡 yellow | search | `Glob`, `Grep` (on the searched directory) |
| 🟢 green | exec | `Bash`, `PowerShell` (on the working directory) |
| ⚪ white | session start | the folder Claude Code was opened in |

Files outside the project root (for example `~/.claude/...`) appear as their own small
clusters, rooted at their parent directory.

### Controls

| Action | How |
| --- | --- |
| Zoom | Mouse wheel / trackpad scroll |
| Pan | Drag the background |
| Move a neuron | Drag it |
| Focus a neuron | Click it, or click an entry in the live feed |
| Details | Hover a neuron: full path, touch count, actions breakdown, last touched |
| Fit everything | **Fit view** button or `f` |
| Freeze the layout | **Pause** button or `Space` |
| Follow Claude | **Follow** checkbox — the camera glides to each new touch (turns off when you pan) |
| Show every label | **All labels** checkbox |
| Highlight paths | Type in **Highlight path…** (matches any part of the full path) |
| Current session | **Current session** (default) shows only the session Claude is working in now, and switches by itself when a new session starts in another folder (or the shown one has been idle for 2 minutes) |
| One session only | Session dropdown (project · start time · number of signals) |
| All sessions | **All sessions** in the dropdown |
| Panel | **Panel** button hides/shows the side panel |
| Start fresh | **Clear log** — empties the activity log file |

The status dot next to the title is green while the browser is connected to the server. Under the
title, **opened in** shows the folder the shown session started in and **working in** the folder of
Claude's latest touch.

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `PORT` | `4747` | server |
| `NEURAL_WEB_LOG` | `~/.claude/neural-web/activity.jsonl` | hook **and** server |

If you change `NEURAL_WEB_LOG`, set it for both Claude Code (e.g. in the `"env"` block of
`settings.json`) and the server, so they agree on the file.

```bash
PORT=5000 npm start                      # macOS / Linux / Git Bash
$env:PORT=5000; npm start                # PowerShell
```

## Log format

One JSON object per line:

```json
{"id":"m3x1k2-a9f0c1","ts":1764000000000,"session":"5f2c…","cwd":"/home/me/app","tool":"Edit","action":"edit","path":"/home/me/app/src/index.ts","kind":"file"}
```

The log grows forever until you press **Clear log** (or delete the file). The UI loads the
last 20,000 lines.

## Privacy & safety

- Everything stays on your machine. The server only listens on `127.0.0.1`.
- The hook only records **paths**, the tool name, and the session id — never file contents
  or command text.
- The hook never blocks Claude Code: it swallows every error, prints nothing, and always
  exits with code 0.

## Uninstall

Remove the `SessionStart` and `PostToolUse` entries from your `settings.json`, stop the
server (it keeps running in the background if the autostart hook launched it — close the
`node` process listening on port 4747), and delete `~/.claude/neural-web/`.

## Project layout

```
neural-web/
├── hooks/log-activity.js       # Claude Code hook → appends to the activity log
├── public/index.html           # the Neural Web UI (canvas, no dependencies)
├── scripts/autostart.js        # SessionStart hook → starts the server + opens the browser
├── scripts/print-hook-config.js# prints the settings.json snippet for this checkout
├── server.js                   # serves the UI, tails the log, streams via SSE
└── package.json
```
