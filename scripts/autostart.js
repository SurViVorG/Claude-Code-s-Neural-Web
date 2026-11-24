#!/usr/bin/env node
/**
 * Neural Web — Claude Code SessionStart hook.
 *
 * When a Claude Code session starts:
 *   - if the Neural Web server is already running, do nothing (no tab spam);
 *   - otherwise start it in the background and open the UI in the browser.
 *
 * SessionStart hook stdout is added to Claude's context, so this script prints
 * nothing, never fails, and exits quickly.
 *
 * Env: PORT (default 4747), NEURAL_WEB_NO_BROWSER=1 to only start the server.
 */
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 4747;
const URL = `http://localhost:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server.js');

setTimeout(() => process.exit(0), 5000).unref();

function isRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/history`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(600, () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function openBrowser() {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', URL], opts).unref();
  else if (process.platform === 'darwin') spawn('open', [URL], opts).unref();
  else spawn('xdg-open', [URL], opts).unref();
}

(async () => {
  try {
    if (await isRunning()) return process.exit(0);

    spawn(process.execPath, [SERVER], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    }).unref();

    // wait for the server to come up before opening the page
    for (let i = 0; i < 20 && !(await isRunning()); i++) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (process.env.NEURAL_WEB_NO_BROWSER !== '1') openBrowser();
  } catch {
    /* never break Claude Code */
  }
  process.exit(0);
})();
