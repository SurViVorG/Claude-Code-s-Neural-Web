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

If the file already has a `"hooks"` section, add the `PostToolUse` entry to it instead of
replacing it. Restart Claude Code (or run `/hooks` to check it was picked up).

> On Windows, `~` is `C:\Users\<you>`, so the global file is
> `C:\Users\<you>\.claude\settings.json`.

### 3. Start the Neural Web

```bash
npm start
```

Open <http://localhost:4747> and start a Claude Code session in any project. Neurons appear
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
| One session only | Session dropdown (project · start time · number of signals) |
| Panel | **Panel** button hides/shows the side panel |
| Start fresh | **Clear log** — empties the activity log file |

The status dot next to the title is green while the browser is connected to the server.

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

Remove the `PostToolUse` entry from your `settings.json` and delete
`~/.claude/neural-web/`.

## Project layout

```
neural-web/
├── hooks/log-activity.js       # Claude Code hook → appends to the activity log
├── public/index.html           # the Neural Web UI (canvas, no dependencies)
├── scripts/print-hook-config.js# prints the settings.json snippet for this checkout
├── server.js                   # serves the UI, tails the log, streams via SSE
└── package.json
```
