/**
 * The dashboard end to end (D10): sign in through the stand-in issuer as the owner of a
 * live workspace, then D1 (banner, credits, today, agents, checklist, recent calls, the
 * 30-day chart, and since ADR 0041 the §7.2 chip, bell and pill, announcements, the
 * messages/sentiment/days-left figures, the agent card's buttons, the checklist rows, a
 * blocked-request pass), D2 (URL-synced filters, sort, pagination, selection, bulk mark handled,
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
 *
 * With E2E_USER_FILE (the issuer's LOCAL_ISSUER_USER_FILE) the run ends with a viewer
 * pass: the owner invites a viewer, the identity file is rewritten, the invite is
 * accepted, and D1 is read as the viewer — no Top up, no Publish, no Test, the API
 * refusing checkout and publish. Without it that pass is SKIP.
 */
import { launch } from './cdp.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
/** Radix menus (the bell, the account menu) open on pointer down, like its tabs; press the trigger the way a pointer does. */
const pressMenu = (selector) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })); el.click(); return 'ok'; })()`);
/** The page's own token and workspace, for a request the script makes from Node so an intended refusal never lands in the browser console. */
const pageSession = () => b.evaluate(`(() => { const keys = Object.keys(localStorage).filter(k => k.startsWith('@@auth0spajs@@') && !k.includes('@@user@@')); let token = null; for (const k of keys) { try { token = JSON.parse(localStorage.getItem(k)).body.access_token; } catch {} } const ws = localStorage.getItem('portal:workspace') ?? localStorage.getItem('portal-workspace') ?? null; return { token, wsId: ws && ws.startsWith('"') ? JSON.parse(ws) : ws }; })()`);
const nodeCall = async (method, route, body) => { const s = await pageSession(); const res = await fetch(`${API}${route}`, { method, headers: { Authorization: `Bearer ${s.token}`, 'X-Workspace-Id': s.wsId, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: res.status, json }; };
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
  ok('D1 checklist follows the server: hidden once every row is done, shown with progress otherwise', checklist.json?.all_done ? !home.includes('Set-up checklist') : /of [78] done/.test(home), `all_done=${checklist.json?.all_done}`);
  ok('D1 30-day chart draws bars from /stats', (await count('svg[role="img"] path')) > 5, `bars=${await count('svg[role="img"] path')}`);
  ok('D1 recent calls lists 5 rows', (await b.evaluate(`[...document.querySelectorAll('a[href^="/app/calls/?call="]')].length`)) === 5);
  ok('D1 live indicator is green (SSE open)', Boolean(await waitFor(`document.body.innerText.includes('Live')`, 10000)));

  // 1b. §7.2 shell and the D1 widgets of ADR 0041, each read against the API it renders.
  const agentsApi = await apiCall('GET', '/agents?limit=10');
  const agentRows = agentsApi.json?.items ?? [];
  const anyUnpublished = agentRows.some((a) => a.has_unpublished_changes);
  const chips = await count('[data-testid="unpublished-chip"]');
  ok('shell unpublished-changes chip follows the agents\' draft state', anyUnpublished ? chips === 1 : chips === 0, `unpublished=${anyUnpublished} chips=${chips}`);
  if (anyUnpublished) {
    const href = await b.evaluate(`document.querySelector('[data-testid="unpublished-chip"]')?.getAttribute('href')`);
    const changed = agentRows.filter((a) => a.has_unpublished_changes);
    ok('shell chip opens the one agent\'s Test tab, or the list for several', changed.length === 1 ? href === `/app/agents/detail/?id=${changed[0].id}&tab=test` : href === '/app/agents/', href);
  }
  const liveState = await b.evaluate(`document.querySelector('[data-testid="agent-live"]')?.getAttribute('data-state') ?? null`);
  const liveWallet = await apiCall('GET', '/wallet');
  const liveWs = await apiCall('GET', '/workspace');
  const liveAgents = agentRows.filter((a) => a.status === 'live').length;
  const answering = liveAgents > 0 && !liveWs.json?.paused && Number(liveWallet.json?.balance ?? 0) > 0;
  const expectedLive = answering ? 'live' : liveAgents > 0 || agentRows.some((a) => a.status === 'paused') ? 'paused' : null;
  ok('shell "Agent live" follows the agents, the workspace pause and the wallet', liveState === expectedLive, `shown=${liveState} expected=${expectedLive}`);
  ok('shell notifications bell renders', (await count('[data-testid="notifications-bell"]')) === 1);
  const feedApi = await apiCall('GET', '/notifications');
  const badge = await b.evaluate(`document.querySelector('[data-testid="notifications-unread"]')?.textContent ?? null`);
  ok('shell bell unread badge matches GET /notifications', feedApi.json?.unread > 0 ? badge !== null : badge === null, `unread=${feedApi.json?.unread} badge=${badge}`);
  await pressMenu('[data-testid="notifications-bell"]'); await sleep(900);
  const menu = await b.evaluate(`document.querySelector('[role="menu"]')?.innerText ?? ''`);
  ok('shell bell opens with the list or the empty state', menu.includes('Notifications') && ((feedApi.json?.items ?? []).length ? !menu.includes('Nothing new') : menu.includes('Nothing new')), menu.replace(/\n/g, ' | ').slice(0, 120));
  await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(500);
  if (feedApi.json?.unread > 0) { const after = await apiCall('GET', '/notifications'); ok('shell bell marks the feed seen on open', after.json?.unread === 0, `unread=${after.json?.unread}`); }
  const walletApi = await apiCall('GET', '/wallet');
  const pill = await b.evaluate(`document.querySelector('aside [data-testid="balance-pill"]')?.innerText ?? ''`);
  ok('shell balance pill shows credits and ≈ minutes, or the paused copy at ≤ 0', walletApi.json?.balance > 0 ? /credits · ≈ \d+ min/.test(pill) : /Agent paused/.test(pill), pill);
  ok('D1 credits outlook shows ≈ minutes, days left and says it is an estimate', /≈ \d+ min at Standard/.test(home) && /(≈ \d+ days? left|No calls in the last 7 days|Out of credits)/.test(home) && home.includes('Estimates from'), (home.match(/≈ [^\n]*/) ?? [''])[0]);
  ok('D1 credits card states the auto top-up setting', /Auto top-up is (on|off)/.test(home));
  ok('D1 top-up button is offered to the owner', (await count('[data-testid="top-up"]')) === 1);
  const statsApi = await apiCall('GET', '/stats?range=today');
  const messagesTxt = await b.evaluate(`document.querySelector('[data-testid="messages-taken"] dd')?.textContent ?? null`);
  ok('D1 today card shows messages taken from /stats', messagesTxt !== null && Number(messagesTxt.replace(/[^\d]/g, '')) === statsApi.json?.messages_taken, `card=${messagesTxt} api=${statsApi.json?.messages_taken}`);
  const sentimentTxt = await b.evaluate(`document.querySelector('[data-testid="sentiment"]')?.innerText ?? ''`);
  const known = (s) => (s?.positive ?? 0) + (s?.neutral ?? 0) + (s?.negative ?? 0);
  ok('D1 today card shows the positive share or "no rated calls"', known(statsApi.json?.sentiment) > 0 ? /\d+%/.test(sentimentTxt) : sentimentTxt.includes('No rated calls'), sentimentTxt.replace(/\n/g, ' | '));
  const publishable = agentRows.some((a) => a.draft_has_prompt && (a.has_unpublished_changes || a.published_version === null));
  ok('D1 agent card offers Test and Edit, and Publish only while a draft waits', (await count('[data-testid="agent-test"]')) >= 1 && (await count('[data-testid="agent-edit"]')) >= 1 && ((await count('[data-testid="agent-publish"]')) >= 1) === publishable, `publishable=${publishable}`);
  ok('D1 agent card shows the agent\'s number', !agentRows.some((a) => a.number_e164) || /\+1 \d{3} \d{3} \d{4}/.test(home));
  ok('D1 shows no paused-by-staff banner on a running workspace', (await count('[data-testid="paused-banner"]')) === 0 && !home.includes('Your account is paused'));
  const rowsShown = await b.evaluate(`[...document.querySelectorAll('[data-testid^="checklist-"]')].map(a => a.dataset.testid.slice('checklist-'.length) + ':' + a.dataset.done)`);
  ok('D1 checklist rows mirror GET /workspace/checklist', checklist.json?.all_done ? rowsShown.length === 0 : rowsShown.length >= 7 && rowsShown.every((r) => { const [k, d] = r.split(':'); return String(checklist.json[k]) === d; }), rowsShown.join(','));
  await b.shot(`${S}/shot-d1-home.png`, true);

  // 1c. A staff announcement, from the table SA10 will write (D20): shown, then hidden per browser.
  try {
    const { withAnnouncement } = await import('./e2e-db.mjs');
    const annText = `E2E notice ${Date.now().toString(36)}: planned maintenance tonight.`;
    const shown = await withAnnouncement({ body: annText, severity: 'warning' }, async () => {
      await b.goto(`${BASE}/app/`, 3000);
      const seen = await waitFor(`document.body.innerText.includes(${JSON.stringify(annText)})`, 15000);
      const before = await bodyText();
      await b.evaluate(`document.querySelector('[data-testid="announcements"] button')?.click()`); await sleep(500);
      return { seen: Boolean(seen), before, after: await bodyText() };
    });
    ok('D1 shows an active staff announcement from GET /announcements/active', shown.seen && shown.before.includes('From the Oraly team'));
    ok('D1 hides a dismissible announcement on Hide, per browser', !shown.after.includes(annText));
    await b.shot(`${S}/shot-d1-announcement.png`);
  } catch (e) {
    results.push(`SKIP D1 announcement (no database access from this box: ${String(e).slice(0, 120)})`); console.log(results.at(-1));
  }

  // 1d. Blocked requests: announcements, the bell and the 7-day stats fail; Home still renders.
  await b.send('Network.enable', {});
  await b.send('Network.setBlockedURLs', { urls: ['*/announcements/active*', '*/notifications*', '*/stats?range=7d*'] });
  await b.goto(`${BASE}/app/`, 3000); await waitFor(`document.body.innerText.includes('Recent calls')`, 15000); await sleep(1500);
  const broken = await bodyText();
  ok('D1 survives failed announcements, notifications and 7-day stats requests', broken.includes('Recent calls') && broken.includes('Credits') && /≈ \d+ min at Standard/.test(broken) && (await count('[data-testid="notifications-bell"]')) === 1);
  await pressMenu('[data-testid="notifications-bell"]'); await sleep(900);
  ok('shell bell shows the failure and a retry when its request fails', (await b.evaluate(`document.querySelector('[role="menu"]')?.innerText ?? ''`)).includes('could not be loaded'));
  await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await sleep(300);
  await b.send('Network.setBlockedURLs', { urls: [] });
  await b.goto(`${BASE}/app/`, 3000); await waitFor(`document.body.innerText.includes('Recent calls')`, 15000);
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
  ok('D2 drawer shows the summary', typeof drawer === 'string' && /asked to book a table|Summary/i.test(drawer));
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
  // The list's own link, not the header's unpublished-changes chip (which opens the Test tab).
  await b.evaluate(`document.querySelector('main a[href^="/app/agents/detail/?id="]').click()`); await sleep(2500);
  ok('D3 opens the detail page with ?id=', (await path()).startsWith('/app/agents/detail/?id='), await path());
  await waitFor(`document.body.innerText.includes('Configuration')`, 15000);
  // The overview's recent-calls card is its own query; wait for both before reading the page.
  await waitFor(`document.body.innerText.includes('Max call length') && document.body.innerText.includes('Recent calls')`, 15000);
  ok('D3 Overview shows live vs draft settings', (await bodyText()).includes('Max call length') && (await bodyText()).includes('Recent calls'));
  await b.shot(`${S}/shot-d3-overview.png`, true);
  const tabs = ['Brief', 'Advanced', 'Voice', 'Knowledge', 'Test', 'Versions', 'Settings'];
  const expect = { Brief: '#about_business', Advanced: '#prompt-body', Voice: '[data-testid="voice-card"]', Knowledge: 'form, [class*="rounded-lg"]', Test: 'button', Versions: 'tbody tr', Settings: '#agent-name' };
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
    // The seeded agent holds no number, so the message is "is published", not "is live".
    const published = await waitFor(`/Version \\d+ is (live|published)|already live/.test(document.body.innerText) ? document.body.innerText.match(/Version \\d+ is (live|published)|already live[^\\n]*/)[0] : null`, 60000, 500);
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

  // 8. The viewer (§6.1 on D1): invite, switch identity, accept, read Home with no money or publish controls.
  const userFile = process.env.E2E_USER_FILE;
  if (!userFile) {
    results.push('SKIP viewer pass (set E2E_USER_FILE to the issuer\'s LOCAL_ISSUER_USER_FILE)'); console.log(results.at(-1));
  } else {
    const original = readFileSync(userFile, 'utf8');
    try {
      await b.send('Emulation.clearDeviceMetricsOverride', {});
      await b.goto(`${BASE}/app/`, 3000); await waitFor(`document.body.innerText.includes('Recent calls')`, 15000);
      const ws2 = await apiCall('GET', '/workspace');
      const liveAgent = (await apiCall('GET', '/agents?limit=10')).json?.items?.[0];
      const id = Date.now().toString(36);
      const email = `e2e-viewer-${id}@example.test`;
      const invite = await apiCall('POST', '/invites', { email, role: 'viewer' });
      ok('owner invites a viewer through POST /invites', invite.status === 201 && Boolean(invite.json?.token), `status=${invite.status}`);
      // Sign out through the account menu, switch the issuer's identity, sign in from the invite link.
      await pressMenu('button[aria-label="Account"]'); await sleep(600);
      await clickText('Sign out', '[role="menuitem"]'); await sleep(3000);
      writeFileSync(userFile, JSON.stringify({ sub: `auth0|e2e-viewer-${id}`, email, name: 'E2E Viewer', email_verified: true }));
      await b.goto(`${BASE}/invite/?token=${encodeURIComponent(invite.json?.token ?? '')}`, 3000);
      await waitFor(`location.pathname === '/login/' || document.body.innerText.includes('Accept invitation')`, 15000);
      if ((await path()).startsWith('/login/')) { await clickText('Sign in'); await sleep(2500); }
      // A new person meets the Terms screen first (ADR 0036) and is sent on to the invite afterwards.
      await waitFor(`location.pathname === '/terms/' || document.body.innerText.includes('Accept invitation')`, 20000);
      if ((await path()).startsWith('/terms/')) {
        await waitFor(`!!document.querySelector('#terms-agree')`, 10000);
        await b.evaluate(`document.querySelector('#terms-agree').click()`); await sleep(300);
        await clickText('Continue'); await sleep(2000);
        ok('viewer accepts the Terms and is sent on to the invitation', Boolean(await waitFor(`document.body.innerText.includes('Accept invitation')`, 20000)), await path());
      }
      await waitFor(`document.body.innerText.includes('Accept invitation')`, 20000);
      await clickText('Accept invitation'); await sleep(1500);
      ok('viewer accepts the invitation', Boolean(await waitFor(`document.body.innerText.includes('Open workspace')`, 15000)));
      // The sign-in's return path is the invite page itself, so "Open workspace" can land back on it; Home is the destination.
      await clickText('Open workspace'); await sleep(2500);
      if ((await path()) !== '/app/') await b.goto(`${BASE}/app/`, 3000);
      await waitFor(`location.pathname === '/app/'`, 20000);
      await waitFor(`document.body.innerText.includes('Recent calls') && !document.querySelector('[aria-busy]')`, 20000); await sleep(1000);
      const vhome = await bodyText();
      ok('viewer lands on D1 with the dashboard information', (await path()) === '/app/' && /\d+(\.\d+)? credits/.test(vhome) && vhome.includes('Today') && vhome.includes('Recent calls'), await path());
      ok('viewer sees no Top up button', (await count('[data-testid="top-up"]')) === 0 && !/Buy credits/.test(vhome));
      ok('viewer sees no Publish or Test on the agent card, only View', (await count('[data-testid="agent-publish"]')) === 0 && (await count('[data-testid="agent-test"]')) === 0 && (await count('[data-testid="agent-view"]')) >= 1);
      ok('viewer sees the bell and the balance pill', (await count('[data-testid="notifications-bell"]')) === 1 && (await count('[data-testid="balance-pill"]')) >= 1);
      await b.shot(`${S}/shot-d1-viewer.png`, true);
      if (liveAgent) {
        await b.goto(`${BASE}/app/agents/detail/?id=${liveAgent.id}&tab=test`, 3000); await sleep(2000);
        ok('viewer opening the Test tab by URL gets the editors-only note and no publish bar', (await bodyText()).includes('Test calls can be made by editors') && !/Publish v\d+/.test(await bodyText()));
        const publish = await nodeCall('POST', `/agents/${liveAgent.id}/publish`, {});
        ok('API refuses a viewer\'s publish', publish.status === 403 && publish.json?.code === 'FORBIDDEN_ROLE', `status=${publish.status}`);
      }
      await b.goto(`${BASE}/app/wallet/`, 3000); await sleep(1500);
      ok('viewer opening the wallet by URL sees the read-only note', (await bodyText()).includes('An owner or admin manages payments'));
      const checkout = await nodeCall('POST', '/wallet/checkout', { pack_id: 'growth' });
      ok('API refuses a viewer\'s checkout', checkout.status === 403 && checkout.json?.code === 'FORBIDDEN_ROLE', `status=${checkout.status}`);
      void ws2;
    } finally {
      writeFileSync(userFile, original);
    }
  }
} catch (e) {
  ok('script completed without an exception', false, e?.stack ?? String(e));
}
const errors = b.logs.filter((l) => !/favicon|posthog|Download the React DevTools|net::ERR_ABORTED/.test(l));
ok('no unexpected console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(`${S}/e2e-dashboard-results.txt`, results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.filter((r) => !r.startsWith('SKIP')).length} passed, ${results.filter((r) => r.startsWith('SKIP')).length} skipped`);
b.close(); process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
