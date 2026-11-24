#!/usr/bin/env node
/**
 * Neural Web server — zero dependencies.
 *
 *   node server.js            serve the UI and stream the real activity log
 *   node server.js --demo     serve the UI with a synthetic activity stream
 *
 * Env: PORT (default 4747), NEURAL_WEB_LOG (default ~/.claude/neural-web/activity.jsonl)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { StringDecoder } = require('string_decoder');

const PORT = Number(process.env.PORT) || 4747;
const HOST = '127.0.0.1'; // local only: the log contains your file paths
const LOG =
  process.env.NEURAL_WEB_LOG ||
  path.join(os.homedir(), '.claude', 'neural-web', 'activity.jsonl');
const DEMO = process.argv.includes('--demo');
const MAX_HISTORY = 20000;
const INDEX = path.join(__dirname, 'public', 'index.html');

const clients = new Set();
const demoEvents = [];

function parseLine(line) {
  try {
    const ev = JSON.parse(line);
    return ev && ev.path ? ev : null;
  } catch {
    return null;
  }
}

function readHistory() {
  if (DEMO) return demoEvents.slice(-MAX_HISTORY);
  try {
    return fs
      .readFileSync(LOG, 'utf8')
      .split('\n')
      .slice(-MAX_HISTORY - 1)
      .map(parseLine)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

/* ---------- tail the log file ---------- */
function tailLog() {
  let offset = 0;
  try {
    offset = fs.statSync(LOG).size;
  } catch {
    /* file does not exist yet — fine */
  }
  let decoder = new StringDecoder('utf8');
  let pending = '';

  fs.watchFile(LOG, { interval: 300 }, (cur) => {
    if (cur.size < offset) {
      // truncated / cleared
      offset = 0;
      pending = '';
      decoder = new StringDecoder('utf8');
      broadcast({ type: 'reset' });
    }
    if (cur.size <= offset) return;
    let fd;
    try {
      fd = fs.openSync(LOG, 'r');
      const buf = Buffer.alloc(cur.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = cur.size;
      const lines = (pending + decoder.write(buf)).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const ev = parseLine(line);
        if (ev) broadcast({ type: 'event', event: ev });
      }
    } catch (err) {
      console.error('[neural-web] read error:', err.message);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  });
}

/* ---------- demo generator ---------- */
function startDemo() {
  const cwd = '/demo/my-app';
  const files = [
    'src/index.ts', 'src/app.ts', 'src/routes/users.ts', 'src/routes/auth.ts',
    'src/routes/posts.ts', 'src/db/schema.ts', 'src/db/migrations/001_init.sql',
    'src/lib/http.ts', 'src/lib/logger.ts', 'src/components/Button.tsx',
    'src/components/Modal.tsx', 'src/components/forms/LoginForm.tsx',
    'tests/users.test.ts', 'tests/auth.test.ts', 'package.json', 'README.md',
    'tsconfig.json', 'docs/architecture.md', 'scripts/seed.js',
  ];
  const dirs = ['src', 'src/routes', 'src/components', 'tests', 'docs'];
  const weighted = [
    ['read', 'Read', 5], ['edit', 'Edit', 3], ['write', 'Write', 1],
    ['search', 'Grep', 2], ['exec', 'Bash', 1],
  ];
  const sessions = ['demo-session-a1b2', 'demo-session-c3d4'];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const pickAction = () => {
    let r = Math.random() * weighted.reduce((s, w) => s + w[2], 0);
    for (const w of weighted) if ((r -= w[2]) < 0) return w;
    return weighted[0];
  };
  let i = 0;
  const emit = () => {
    const [action, tool] = pickAction();
    let p = cwd;
    let kind = 'dir';
    if (action === 'search') p = `${cwd}/${pick(dirs)}`;
    else if (action !== 'exec') {
      p = `${cwd}/${pick(files)}`;
      kind = 'file';
    }
    const ev = {
      id: `demo-${i++}`,
      ts: Date.now(),
      session: sessions[i % 7 === 0 ? 1 : 0],
      cwd,
      tool,
      action,
      path: p,
      kind,
    };
    demoEvents.push(ev);
    broadcast({ type: 'event', event: ev });
  };
  setInterval(emit, 900);
}

/* ---------- http ---------- */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(INDEX, (err, html) => {
      if (err) {
        res.writeHead(500).end('index.html missing');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, demo: DEMO, clients: clients.size }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ demo: DEMO, log: DEMO ? null : LOG, events: readHistory() }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/clear') {
    if (DEMO) {
      demoEvents.length = 0;
      broadcast({ type: 'reset' });
    } else {
      try {
        fs.writeFileSync(LOG, '');
      } catch {
        /* nothing to clear */
      }
      // the file watcher notices the truncation and broadcasts the reset
    }
    res.writeHead(204).end();
    return;
  }

  res.writeHead(404).end('not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[neural-web] port ${PORT} is busy. Try: PORT=4848 node server.js`);
  } else {
    console.error('[neural-web]', err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  if (DEMO) startDemo();
  else tailLog();
  console.log(`\n  Neural Web is live → http://localhost:${PORT}`);
  console.log(DEMO ? '  mode: demo (synthetic activity)\n' : `  watching: ${LOG}\n`);
});
