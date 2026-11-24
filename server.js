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

function readHistory(all) {
  if (DEMO) return demoEvents.slice(-MAX_HISTORY);
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n');
    return (all ? lines : lines.slice(-MAX_HISTORY - 1)).map(parseLine).filter(Boolean);
  } catch {
    return [];
  }
}

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(data);
}

/* ---------- directory trees (every file under each session's base folder) ---------- */
// big generated folders: listed, but their contents load only when clicked
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  'dist', 'build', 'out', 'coverage', 'target', 'vendor', '.venv', 'venv', '__pycache__',
  '.idea', '.vs', '.gradle', 'bin', 'obj',
]);
const TREE_LIMIT = 5000; // entries per request; folders past it are sent unloaded

function normKey(p) {
  const s = String(p).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

// only folders Claude Code sessions worked in (and what is below them) may be listed
const knownRoots = new Set();
function noteRoots(ev) {
  if (ev.cwd) knownRoots.add(normKey(ev.cwd));
  if (ev.action === 'start') knownRoots.add(normKey(ev.path));
}
function allowedPath(p) {
  const k = normKey(p);
  for (const r of knownRoots) if (k === r || k.startsWith(r + '/')) return true;
  return false;
}

// { n: name, d: 1 if dir, c: [children] (absent = not loaded yet), s: 1 if skipped }
function buildTree(dir) {
  const root = { n: path.basename(dir) || dir, d: 1 };
  const queue = [[root, dir]];
  let count = 0;
  while (queue.length && count < TREE_LIMIT) {
    const [node, p] = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      node.c = [];
      continue;
    }
    node.c = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        const c = { n: e.name, d: 1 };
        if (SKIP_DIRS.has(e.name)) c.s = 1;
        else queue.push([c, path.join(p, e.name)]);
        node.c.push(c);
      } else {
        node.c.push({ n: e.name });
      }
    }
    count += entries.length;
  }
  return root;
}

const DEMO_ROOT = '/demo/my-app';
const DEMO_FILES = [
  'src/index.ts', 'src/app.ts', 'src/routes/users.ts', 'src/routes/auth.ts',
  'src/routes/posts.ts', 'src/routes/comments.ts', 'src/db/schema.ts', 'src/db/client.ts',
  'src/db/migrations/001_init.sql', 'src/db/migrations/002_posts.sql', 'src/lib/http.ts',
  'src/lib/logger.ts', 'src/lib/cache.ts', 'src/components/Button.tsx', 'src/components/Modal.tsx',
  'src/components/Card.tsx', 'src/components/forms/LoginForm.tsx',
  'src/components/forms/SignupForm.tsx', 'tests/users.test.ts', 'tests/auth.test.ts',
  'tests/posts.test.ts', 'package.json', 'README.md', 'tsconfig.json', '.gitignore',
  'docs/architecture.md', 'docs/api.md', 'scripts/seed.js', 'public/favicon.ico', 'public/logo.svg',
];

function demoTree(p) {
  const root = { n: 'my-app', d: 1, c: [{ n: 'node_modules', d: 1, s: 1 }] };
  for (const f of DEMO_FILES) {
    let node = root;
    const segs = f.split('/');
    segs.forEach((seg, i) => {
      let c = node.c.find((x) => x.n === seg);
      if (!c) {
        c = i === segs.length - 1 ? { n: seg } : { n: seg, d: 1, c: [] };
        node.c.push(c);
      }
      node = c;
    });
  }
  let node = root;
  for (const seg of String(p).slice(DEMO_ROOT.length).split('/').filter(Boolean)) {
    node = (node.c || []).find((x) => x.n === seg) || { n: seg, d: 1, c: [] };
  }
  return node.c ? node : { ...node, c: [] };
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
        if (ev) {
          noteRoots(ev);
          broadcast({ type: 'event', event: ev });
        }
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
  const cwd = DEMO_ROOT;
  const files = DEMO_FILES;
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
const json = (res, body) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

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
    json(res, { ok: true, demo: DEMO, clients: clients.size });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/history') {
    json(res, { demo: DEMO, log: DEMO ? null : LOG, events: readHistory() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/tree') {
    const p = url.searchParams.get('path') || '';
    if (DEMO) {
      json(res, { path: p, tree: demoTree(p) });
      return;
    }
    if (!p || !path.isAbsolute(p) || !allowedPath(p)) {
      res.writeHead(403).end('not inside a session folder');
      return;
    }
    json(res, { path: p, tree: buildTree(p) });
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
  else {
    for (const ev of readHistory(true)) noteRoots(ev);
    tailLog();
  }
  console.log(`\n  Neural Web is live → http://localhost:${PORT}`);
  console.log(DEMO ? '  mode: demo (synthetic activity)\n' : `  watching: ${LOG}\n`);
});
