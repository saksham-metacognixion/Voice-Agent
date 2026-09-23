// Minimal Chrome DevTools Protocol driver on the built-in WebSocket of Node 22+. No dependency.
// CHROME_PATH overrides the macOS default location of Chrome.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function launch({ port = 9333, dark = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));
  const chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,1000', '--hide-scrollbars', ...(dark ? ['--force-dark-mode'] : []), 'about:blank',
  ], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (targets.length) break; } catch {} await new Promise(r => setTimeout(r, 200)); }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); } else if (msg.method) listeners.forEach(l => l(msg)); };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  const on = (fn) => listeners.push(fn);
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable');
  const logs = []; on((m) => { if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) logs.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`); if (m.method === 'Runtime.exceptionThrown') logs.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)); if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url ?? '')); });
  const navs = []; on((m) => { if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) navs.push(m.params.frame.url); });
  const goto = async (url, wait = 1500) => { await send('Page.navigate', { url }); await new Promise(r => setTimeout(r, wait)); };
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
  const shot = async (path, full = false) => { const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full }); await import('node:fs').then(fs => fs.writeFileSync(path, Buffer.from(data, 'base64'))); };
  const url = async () => evaluate('location.href');
  const close = () => { try { chrome.kill(); } catch {} };
  return { send, goto, evaluate, shot, url, logs, navs, close };
}
