/**
 * The dashboard end to end (D10): sign in through the stand-in issuer as the owner of a
 * live workspace, then D1 (banner, credits, today, agents, checklist, recent calls, the
 * 30-day chart), D2 (URL-synced filters, sort, pagination, selection, bulk mark handled,
 * CSV export, the detail drawer with summary, captured fields, transcript, recording,
 * note) and D3 (list, every tab, the Advanced editor's live lint and save, versions,
 * settings). A `call:` frame is pushed through the API's own event bus to prove the SSE
 * path updates D1 and D2 without a reload. Screenshots land in frontend/web/.e2e/.
 *
 * Needs: the export at PORTAL_URL (default http://localhost:3005), the API it was built
 * against at API_URL (default http://localhost:4001) with a worker, the local issuer
 * minting the workspace owner's identity, and ADMIN_DATABASE_URL for the SSE probe
 * (it inserts nothing; it publishes one frame on the workspace's channel).
 *
 *   PORTAL_URL=http://localhost:3005 API_URL=http://localhost:4001 node scripts/e2e-dashboard.mjs
 */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const S = fileURLToPath(new URL('../.e2e', import.meta.url)); mkdirSync(S, { recursive: true });
const BASE = (process.env.PORTAL_URL ?? 'http://localhost:3005').replace(/\/+$/, '');
const API = (process.env.API_URL ?? 'http://localhost:4001').replace(/\/+$/, '');
const b = await launch({ port: 9334, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`); console.log(results.at(-1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `expr` should yield a primitive: a DOM node does not survive `returnByValue`. */
async function waitFor(expr, timeout = 15000, every = 250) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await b.evaluate(expr).catch(() => null); if (v) return v; await sleep(every); } return null; }
const path = async () => { const u = new URL(await b.url()); return u.pathname + u.search; };
const setInput = (selector, value) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
const clickText = (text, tag = 'button') => b.evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(tag)})]; const el = els.find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
const bodyText = () => b.evaluate('document.body.innerText');
const count = (selector) => b.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
/** Radix Tabs activate on pointer/mouse down, not on click; press the tab the way a pointer does. */
const pressTab = (label) => b.evaluate(`(() => { const el = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim() === ${JSON.stringify(label)}); if (!el) return 'missing'; el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })); el.click(); return 'ok'; })()`);
/** The open drawer's text (Radix marks its content `data-state="open"`). */
const drawerText = () => b.evaluate(`document.querySelector('#call-note')?.closest('[data-state="open"], [role="dialog"]')?.innerText ?? document.body.innerText`);
/** The signed-in API client from inside the page: the SPA's token + workspace header. */
const apiCall = (method, route, body) => b.evaluate(`(async () => {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('@@auth0spajs@@') && !k.includes('@@user@@'));
  let token = null; for (const k of keys) { try { token = JSON.parse(localStorage.getItem(k)).body.access_token; } catch {} }
  const ws = localStorage.getItem('portal:workspace') ?? localStorage.getItem('portal-workspace') ?? null;
  const wsId = ws && ws.startsWith('"') ? JSON.parse(ws) : ws;
  const res = await fetch(${JSON.stringify(API)} + ${JSON.stringify(route)}, { method: ${JSON.stringify(method)}, headers: { Authorization: 'Bearer ' + token, 'X-Workspace-Id': wsId, 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 2000), headers: Object.fromEntries(res.headers.entries()) };
})()`);

try {
  // 0. Sign in through the issuer (no form) → the dashboard, since the workspace is live.
  await b.goto(`${BASE}/login/`, 2500);
  await clickText('Sign in'); await sleep(1500);
  const landed = await waitFor(`location.pathname === '/app/' || location.pathname === '/select-workspace/'`, 20000);
  ok('signed in through the issuer', Boolean(landed), await path());
  if ((await path()).startsWith('/select-workspace/')) {
    await b.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Bright Smile Health'))?.click()`); await sleep(2500);
  }
  await waitFor(`location.pathname === '/app/'`, 15000);
  ok('lands on D1 Home', (await path()) === '/app/', await path());

  // 1. D1 — every widget with real data
  await waitFor(`document.body.innerText.includes('Recent calls') && !document.querySelector('[aria-busy]')`, 20000);
  await sleep(1500);
  const home = await bodyText();
  ok('D1 credits card shows the wallet balance', /\d+(\.\d+)? credits/.test(home), (home.match(/\d+(\.\d+)? credits/) ?? [''])[0]);
  ok('D1 today card renders', home.includes('Today') && home.includes('Missed'));
  ok('D1 agent card lists the agent', home.includes('Restaurant Reservations'));
  const checklist = await apiCall('GET', '/workspace/checklist');
  ok('D1 checklist follows the server: hidden when complete, shown with progress otherwise', checklist.json?.complete ? !home.includes('Set-up checklist') : home.includes('of 6 done'), `complete=${checklist.json?.complete}`);
  ok('D1 30-day chart draws bars from /stats', (await count('svg[role="img"] path')) > 5, `bars=${await count('svg[role="img"] path')}`);
  ok('D1 recent calls lists 5 rows', (await b.evaluate(`[...document.querySelectorAll('a[href^="/app/calls/?call="]')].length`)) === 5);
  ok('D1 live indicator is green (SSE open)', Boolean(await waitFor(`document.body.innerText.includes('Live')`, 10000)));
  await b.shot(`${S}/shot-d1-home.png`, true);
  await b.evaluate(`localStorage.setItem('portal-theme', 'dark')`); await b.goto(`${BASE}/app/`, 3500); await waitFor(`document.body.innerText.includes('Recent calls')`, 15000); await sleep(1000);
  await b.shot(`${S}/shot-d1-home-dark.png`, true);
  await b.evaluate(`localStorage.setItem('portal-theme', 'light')`);

  // 2. SSE: publish a call frame on the workspace channel and watch D1 react without a reload.
  await b.goto(`${BASE}/app/`, 3000); await waitFor(`document.body.innerText.includes('Recent calls') && document.body.innerText.includes('Live')`, 15000);
  const beforeToast = await bodyText();
  const probe = await apiCall('GET', '/workspace');
  ok('page holds a usable session (GET /workspace 200)', probe.status === 200, `status=${probe.status}`);
  const wsId = probe.json?.id;
  // The frame is published by the API's own EventsService through a dev-only helper in this script's sibling
  // (scripts/publish-call-frame.mjs), which uses the same Redis channel the API subscribes to.
  const { publishCallFrame } = await import('./publish-call-frame.mjs');
  const fakeCallId = `d10live_${Date.now().toString(36)}`;
  await publishCallFrame(wsId, fakeCallId, 'registered', { call_id: fakeCallId, from_number: '+14165550999', agent_id: null, channel: 'phone', direction: 'inbound', is_test: false, decline_reason: null });
  const toast = await waitFor(`document.body.innerText.includes('New inbound call')`, 10000);
  ok('D1 shows the new-call toast from the SSE frame', Boolean(toast));
  ok('D1 toast names the caller', (await bodyText()).includes('+1 416 555 0999'));
  await b.shot(`${S}/shot-d1-sse-toast.png`);
  void beforeToast;

  // 3. D2 — list, count, filters in the URL
  await b.goto(`${BASE}/app/calls/`, 3000);
  await waitFor(`document.querySelectorAll('tbody tr').length > 0`, 20000);
  const rows = await count('tbody tr');
  ok('D2 lists a page of 25 calls', rows === 25, `rows=${rows}`);
  ok('D2 shows the total from the API', /Showing 1–25 of \d+/.test(await bodyText()), (await bodyText()).match(/Showing[^\n]*/)?.[0]);
  await b.shot(`${S}/shot-d2-list.png`, true);

  // filter: status = missed → URL + rows
  await b.evaluate(`[...document.querySelectorAll('button[role="combobox"]')][0].click()`); await sleep(400);
  await b.evaluate(`[...document.querySelectorAll('[role="option"]')].find(o => o.textContent.trim() === 'Missed')?.click()`); await sleep(1500);
  ok('D2 status filter writes the URL', (await path()).includes('status=missed'), await path());
  const missedBadges = await b.evaluate(`[...document.querySelectorAll('tbody tr')].every(tr => tr.innerText.includes('Missed'))`);
  ok('D2 status filter narrows the rows', missedBadges && (await count('tbody tr')) > 0, `rows=${await count('tbody tr')}`);
  await b.shot(`${S}/shot-d2-filter-missed.png`);
  // refresh keeps the filter
  await b.goto(`${BASE}${await path()}`, 3000); await waitFor(`document.querySelectorAll('tbody tr').length > 0`, 15000);
  ok('D2 filter survives a refresh', (await path()).includes('status=missed') && (await b.evaluate(`[...document.querySelectorAll('tbody tr')].every(tr => tr.innerText.includes('Missed'))`)));
  // back button clears it
  await b.evaluate('history.back()'); await sleep(1500);
  ok('D2 back button restores the previous filter state', !(await path()).includes('status=missed'), await path());
  await waitFor(`document.querySelectorAll('tbody tr').length === 25`, 15000);

  // sort by duration desc → URL + first row longest
  await clickText('Length'); await sleep(1500);
  ok('D2 sort writes the URL', (await path()).includes('sort=duration_s'), await path());
  const durations = await b.evaluate(`[...document.querySelectorAll('tbody tr')].map(tr => tr.children[tr.children.length - 5].innerText.trim())`);
  const toS = (d) => d.split(':').reduce((a, x) => a * 60 + Number(x), 0);
  ok('D2 rows come back sorted by the server', durations.length > 2 && toS(durations[0]) >= toS(durations[1]) && toS(durations[1]) >= toS(durations[2]), durations.slice(0, 3).join(','));
  await clickText('Length'); await sleep(1500);
  ok('D2 second click flips the order', (await path()).includes('order=asc'), await path());
  await b.goto(`${BASE}/app/calls/`, 3000); await waitFor(`document.querySelectorAll('tbody tr').length === 25`, 15000);

  // pagination
  const firstIds = await b.evaluate(`[...document.querySelectorAll('tbody tr')].map(tr => tr.innerText.split('\\n')[0])`);
  await clickText('Next'); await sleep(2000); await waitFor(`document.querySelectorAll('tbody tr').length > 0 && location.search.includes('cursor=')`, 15000);
  const secondIds = await b.evaluate(`[...document.querySelectorAll('tbody tr')].map(tr => tr.innerText.split('\\n')[0])`);
  ok('D2 next page changes the rows and the URL', (await path()).includes('cursor=') && secondIds[0] !== firstIds[0], `${firstIds[0]} → ${secondIds[0]}`);
  ok('D2 pager counts from the cursor position', /Showing 26–\d+ of \d+/.test(await bodyText()), (await bodyText()).match(/Showing[^\n]*/)?.[0]);
  await b.shot(`${S}/shot-d2-page2.png`);
  await clickText('Previous'); await sleep(1500);
  ok('D2 previous returns to page one', !(await path()).includes('cursor='), await path());

  // selection + bulk mark handled (only rows not yet handled)
  await waitFor(`document.querySelectorAll('tbody tr').length === 25`, 15000);
  await b.evaluate(`[...document.querySelectorAll('tbody tr')].slice(0, 3).forEach(tr => tr.querySelector('button[role="checkbox"]').click())`); await sleep(500);
  ok('D2 selecting rows shows the bulk bar', (await bodyText()).includes('3 selected'));
  await b.shot(`${S}/shot-d2-bulk.png`);
  await clickText('Mark handled'); await sleep(2500);
  ok('D2 bulk mark handled reports how many changed', Boolean(await waitFor(`document.body.innerText.includes('calls marked handled')`, 8000)));
  const handledTicks = await b.evaluate(`[...document.querySelectorAll('tbody tr')].slice(0, 3).every(tr => tr.querySelector('svg[aria-label="Handled"]'))`);
  ok('D2 the three rows now show the handled tick', handledTicks);

  // CSV export through the page's own session (the button downloads; the request is checked directly)
  const csv = await apiCall('POST', '/calls/export', { status: 'missed' });
  ok('D2 CSV export answers text/csv with the header row', csv.status === 200 && csv.headers['content-type']?.startsWith('text/csv') && csv.text.startsWith('call_id,started_at'), `status=${csv.status}`);
  ok('D2 CSV export honours the filter', csv.text.split('\r\n').filter(Boolean).slice(1).every((l) => l.includes(',missed,')), `rows=${csv.text.split('\r\n').filter(Boolean).length - 1}`);
  const exportBtn = await b.evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Export CSV') && !b.disabled)`);
  ok('D2 Export CSV button is enabled', Boolean(exportBtn));

  // drawer
  // A seeded phone call that was analysed: it carries the captured fields the drawer lists.
  await b.evaluate(`[...document.querySelectorAll('tbody tr')].find(tr => tr.innerText.includes('Done') && tr.innerText.includes('+1 416 555'))?.click()`); await sleep(1500);
  ok('D2 clicking a row opens the drawer and writes ?call=', (await path()).includes('call=') && Boolean(await waitFor(`!!document.querySelector('#call-note')`, 8000)), await path());
  await waitFor(`document.body.innerText.includes('Call ID')`, 10000);
  const drawer = await bodyText();
  ok('D2 drawer shows the summary', typeof drawer === 'string' && /asked to book a table|Summary/.test(drawer));
  ok('D2 drawer shows the captured fields', typeof drawer === 'string' && drawer.includes('Customer name') && drawer.includes('Party size'));
  ok('D2 drawer shows the transcript as turns', typeof drawer === 'string' && drawer.includes('Thanks for calling Bright Smile') && drawer.includes('Caller'));
  ok('D2 drawer shows the facts', typeof drawer === 'string' && drawer.includes('Call ID') && drawer.includes('Rate') && drawer.includes('Started'));
  await b.shot(`${S}/shot-d2-drawer.png`, true);
  // note + handled toggle persist
  const noteText = `Called back and confirmed (${new Date().toISOString().slice(11, 19)}).`;
  await setInput('#call-note', noteText); await sleep(300);
  await b.evaluate(`[...(document.querySelector('#call-note')?.closest('[data-state="open"], [role="dialog"]') ?? document).querySelectorAll('button')].find(b => b.textContent.trim() === 'Save')?.click()`); await sleep(1500);
  ok('D2 drawer saves a note', Boolean(await waitFor(`document.body.innerText.includes('Note saved')`, 8000)));
  const drawerPath = await path();
  await b.goto(`${BASE}${drawerPath}`, 3000);
  ok('D2 a pasted drawer link reopens the same call', Boolean(await waitFor(`document.querySelector('#call-note')?.value === ${JSON.stringify(noteText)}`, 12000)));
  // recording: a real recorded test call from the platform
  await b.goto(`${BASE}/app/calls/?channel=web`, 3000); await waitFor(`document.querySelectorAll('tbody tr').length > 0`, 15000);
  await b.evaluate(`[...document.querySelectorAll('tbody tr')].find(tr => tr.innerText.includes('Done'))?.click()`); await sleep(1500);
  await waitFor(`document.body.innerText.includes('Recording')`, 10000);
  const hasLoad = await b.evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Load recording'))`);
  ok('D2 drawer offers the recording for a recorded call', hasLoad);
  if (hasLoad) {
    await b.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Load recording')).click()`);
    const audio = await waitFor(`document.querySelector('audio')?.src`, 15000);
    if (!audio) ok('D2 recording: drawer text after Load', false, await drawerText());
    // The link points at API_PUBLIC_URL (what the browser and the platform reach); locally that is the
    // dev ngrok origin from .env, so the proxy route itself is exercised against the API under test.
    ok('D2 recording link is our signed proxy route, never the platform URL', typeof audio === 'string' && /\/calls\/[^/]+\/recording\/stream\?token=/.test(audio) && !/retell|s3\.amazonaws|storage\.googleapis/.test(audio), String(audio).slice(0, 90));
    const swapped = audio ? String(audio).replace(/^https?:\/\/[^/]+/, API) : `${API}/calls/none/recording/stream?token=none`;
    const head = await b.evaluate(`fetch(${JSON.stringify(swapped)}, { headers: { Range: 'bytes=0-1' } }).then(r => ({ status: r.status, type: r.headers.get('content-type'), len: r.headers.get('content-length'), range: r.headers.get('content-range') })).catch(e => ({ error: String(e) }))`);
    ok('D2 recording proxy streams audio with Range support', head && (head.status === 206 || head.status === 200) && /audio|octet/.test(head.type ?? ''), JSON.stringify(head));
    const sameOrigin = String(audio).startsWith(API);
    if (sameOrigin) {
      const ready = await waitFor(`(() => { const a = document.querySelector('audio'); return a && a.readyState >= 1 ? a.duration : null; })()`, 15000);
      ok('D2 recording metadata loads in the player', typeof ready === 'number' && ready > 0, `duration=${ready}`);
    } else {
      results.push(`SKIP D2 recording playback in the player — the link is minted for API_PUBLIC_URL (${String(audio).replace(/\/calls.*$/, '')}), not the API under test; the proxy route was verified directly above`);
      console.log(results.at(-1));
    }
    await b.shot(`${S}/shot-d2-recording.png`, true);
  }
  // D2 SSE: a frame arrives while the list is open → toast + list refetch
  await b.goto(`${BASE}/app/calls/`, 3000); await waitFor(`document.querySelectorAll('tbody tr').length === 25 && document.body.innerText.includes('Live')`, 15000);
  const liveId = `d10live_${Date.now().toString(36)}`;
  await publishCallFrame(wsId, liveId, 'in_progress', { call_id: liveId, from_number: '+14165550777', agent_id: null, channel: 'phone', direction: 'inbound', is_test: false, started_at: new Date().toISOString(), rate: 1 });
  ok('D2 shows the new-call toast from the SSE frame', Boolean(await waitFor(`document.body.innerText.includes('New inbound call')`, 10000)));
  await b.shot(`${S}/shot-d2-sse-toast.png`);

  // 4. D3 — list and tabs
  await b.goto(`${BASE}/app/agents/`, 3000); await waitFor(`document.body.innerText.includes('Restaurant Reservations')`, 15000);
  ok('D3 lists the agent with its status', (await bodyText()).includes('Draft'));
  await b.shot(`${S}/shot-d3-list.png`);
  await b.evaluate(`document.querySelector('a[href^="/app/agents/detail/?id="]').click()`); await sleep(2500);
  ok('D3 opens the detail page with ?id=', (await path()).startsWith('/app/agents/detail/?id='), await path());
  await waitFor(`document.body.innerText.includes('Configuration')`, 15000);
  ok('D3 Overview shows live vs draft settings', (await bodyText()).includes('Max call length') && (await bodyText()).includes('Recent calls'));
  await b.shot(`${S}/shot-d3-overview.png`, true);
  const tabs = ['Brief', 'Advanced', 'Voice', 'Knowledge', 'Test', 'Versions', 'Settings'];
  const expect = { Brief: '#about_business', Advanced: '#prompt-body', Voice: '[role="option"]', Knowledge: 'form, [class*="rounded-lg"]', Test: 'button', Versions: 'tbody tr', Settings: '#agent-name' };
  for (const tab of tabs) {
    await pressTab(tab); await sleep(500);
    const found = await waitFor(`!!document.querySelector(${JSON.stringify(expect[tab])})`, 15000);
    ok(`D3 ${tab} tab renders`, Boolean(found), await path());
    ok(`D3 ${tab} tab is in the URL`, (await path()).includes(`tab=${tab === 'Advanced' ? 'prompt' : tab.toLowerCase()}`), await path());
    await b.shot(`${S}/shot-d3-${tab.toLowerCase()}.png`, true);
  }

  // Versions: compare two + view
  await pressTab('Versions'); await waitFor(`document.querySelectorAll('tbody tr').length > 1`, 10000);
  const versionRows = await count('tbody tr');
  ok('D3 Versions lists every version', versionRows >= 6, `rows=${versionRows}`);
  await b.evaluate(`[...document.querySelectorAll('tbody tr input[type="checkbox"]')].slice(0, 2).forEach(c => c.click())`); await sleep(300);
  await b.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Compare v')).click()`);
  ok('D3 Versions compare shows a diff', Boolean(await waitFor(`document.body.innerText.includes('lines added')`, 15000)));
  await b.shot(`${S}/shot-d3-diff.png`);
  await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(500);

  // Advanced: lint runs, an edit saves as a new version
  await pressTab('Advanced'); await waitFor(`!!document.querySelector('#prompt-body')`, 10000);
  const before = (await b.evaluate(`document.querySelector('#prompt-body')?.value`)) ?? '';
  ok('D3 Advanced loads the current editable prompt', typeof before === 'string' && before.length > 50 && !/Platform rules|PLATFORM GUARDRAILS/i.test(before.slice(0, 40)), `chars=${before.length}`);
  ok('D3 Advanced shows the stored lint result', (await bodyText()).includes('Checks'));
  await setInput('#prompt-body', 'too short'); 
  const lintErr = await waitFor(`document.body.innerText.includes('Write at least 50 characters')`, 5000);
  ok('D3 Advanced refuses a too-short prompt client-side', Boolean(lintErr));
  await setInput('#prompt-greeting', ''); await sleep(1200);
  const serverLint = await waitFor(`document.body.innerText.includes('Missing greeting')`, 10000);
  ok('D3 Advanced live lint comes from the server (no_greeting)', Boolean(serverLint));
  await b.shot(`${S}/shot-d3-prompt-lint.png`, true);
  await setInput('#prompt-greeting', 'Thanks for calling Bright Smile, how can I help you today?');
  await setInput('#prompt-body', before + '\n\nIf the caller asks about parking, say there is free parking behind the building.'); await sleep(1500);
  ok('D3 Advanced shows unsaved state', (await bodyText()).includes('Unsaved changes'));
  await clickText('Save as new version');
  ok('D3 Advanced save creates a new version', Boolean(await waitFor(`document.body.innerText.includes('Saved as version')`, 15000)));
  await pressTab('Versions'); await sleep(1500); await waitFor(`document.querySelectorAll('tbody tr').length > ${versionRows}`, 15000);
  ok('D3 Versions shows the manual version on top', (await b.evaluate(`document.querySelector('tbody tr')?.innerText`))?.includes('Manual edit'));
  await b.shot(`${S}/shot-d3-versions.png`, true);

  // Settings: save a draft change; live copy untouched
  await pressTab('Settings'); await waitFor(`!!document.querySelector('#agent-name')`, 10000);
  await setInput('#agent-industry', `Restaurants ${Date.now() % 1000}`); await sleep(300);
  await b.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Save' && !b.disabled)?.click()`);
  ok('D3 Settings saves through PATCH /agents/:id/draft', Boolean(await waitFor(`document.body.innerText.includes('Settings saved')`, 10000)));
  await b.shot(`${S}/shot-d3-settings.png`, true);

  // Brief: autosave lands on the draft version
  await pressTab('Brief'); await waitFor(`!!document.querySelector('#address')`, 10000);
  const address = `${100 + (Date.now() % 800)} Queen St W, Toronto, ON`;
  await setInput('#address', address); await sleep(2500);
  ok('D3 Brief autosaves', Boolean(await waitFor(`document.body.innerText.includes('Saved')`, 8000)));
  await b.goto(`${BASE}${await path()}`, 3000); await waitFor(`document.querySelector('#address')?.value.length > 0`, 12000);
  ok('D3 Brief change persisted on the API', (await b.evaluate(`document.querySelector('#address')?.value`)) === address);

  // Publish bar → a real publish (lint, platform sync, live)
  const publishBtn = await waitFor(`[...document.querySelectorAll('button')].find(b => /^Publish v\\d+/.test(b.textContent.trim()) && !b.disabled) ? true : null`, 8000);
  ok('D3 publish bar offers the draft', Boolean(publishBtn));
  if (publishBtn) {
    await b.evaluate(`[...document.querySelectorAll('button')].find(b => /^Publish v\\d+/.test(b.textContent.trim())).click()`);
    const published = await waitFor(`/Version \\d+ is live|already live/.test(document.body.innerText) ? document.body.innerText.match(/Version \\d+ is live|already live[^\\n]*/)[0] : null`, 60000, 500);
    ok('D3 publish goes live (real platform sync)', Boolean(published), String(published));
    await sleep(1500);
    await pressTab('Overview'); await sleep(1500);
    ok('D3 Overview now shows Live', (await bodyText()).includes('Live'));
    await b.shot(`${S}/shot-d3-published.png`, true);
  }

  // Phone-width pass on the three screens
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  for (const [name, url] of [['d1', '/app/'], ['d2', '/app/calls/'], ['d3', (await path())]]) {
    await b.goto(`${BASE}${url}`, 3500); await sleep(1500);
    const overflow = await b.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    const wide = overflow > 1 ? await b.evaluate(`[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 6).map(e => e.tagName + '.' + String(e.className).slice(0, 60) + '@' + Math.round(e.getBoundingClientRect().right)).join(' | ')`) : '';
    ok(`${name} has no horizontal page scroll at 390px`, overflow <= 1, `overflow=${overflow} ${wide}`);
    await b.shot(`${S}/shot-mobile-${name}.png`, true);
  }
} catch (e) {
  ok('script completed without an exception', false, e?.stack ?? String(e));
}
const errors = b.logs.filter((l) => !/favicon|posthog|Download the React DevTools|net::ERR_ABORTED/.test(l));
ok('no unexpected console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(`${S}/e2e-dashboard-results.txt`, results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.filter((r) => !r.startsWith('SKIP')).length} passed, ${results.filter((r) => r.startsWith('SKIP')).length} skipped`);
b.close(); process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
