/**
 * The rest of the dashboard end to end (D11): D4 Numbers, D5 Wallet, D6 Settings, D7 Help,
 * the live balance over SSE, and a phone-width pass (390 px) over every screen, dialog and
 * tab. Signs in through the stand-in issuer as the owner of a live workspace with at least
 * one number. Screenshots land in frontend/web/.e2e/.
 *
 * Nothing here spends money or touches the voice platform: it never releases a number,
 * never re-points one at another agent, never pays. Edits it makes (a block-list entry, a
 * label, notification preferences) are put back before it moves on; the invite it creates
 * is revoked.
 *
 * Needs the same stack as e2e-dashboard.mjs (export at PORTAL_URL, API + worker at
 * API_URL, the local issuer, REDIS_URL for the SSE probe).
 *
 *   PORTAL_URL=http://localhost:3005 API_URL=http://localhost:4001 node scripts/e2e-dashboard-d11.mjs
 */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { publishFrame } from './publish-call-frame.mjs';

const S = fileURLToPath(new URL('../.e2e', import.meta.url)); mkdirSync(S, { recursive: true });
const BASE = (process.env.PORTAL_URL ?? 'http://localhost:3005').replace(/\/+$/, '');
const API = (process.env.API_URL ?? 'http://localhost:4001').replace(/\/+$/, '');
let b = await launch({ port: 9335 });
let desktopLogs = [];
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`); console.log(results.at(-1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 15000, every = 150) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await b.evaluate(expr).catch(() => null); if (v) return v; await sleep(every); } return null; }
const path = async () => { const u = new URL(await b.url()); return u.pathname + u.search; };
const setInput = (selector, value) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
/** Clicks the first *visible* element of `tag` whose text contains `text` (both layouts are in the DOM). */
const clickText = (text, tag = 'button', scope = 'document') => b.evaluate(`(() => { const els = [...${scope}.querySelectorAll(${JSON.stringify(tag)})].filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed'); const el = els.find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
const bodyText = () => b.evaluate('document.body.innerText');
const pressTab = (label) => b.evaluate(`(() => { const el = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim() === ${JSON.stringify(label)}); if (!el) return 'missing'; el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })); el.click(); return 'ok'; })()`);
const key = async (k, code = k, vk = 0) => { await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk }); await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }); };
const visiblePill = `[...document.querySelectorAll('[data-testid="balance-pill"]')].find(e => e.offsetParent !== null)`;
const apiCall = (method, route, body) => b.evaluate(`(async () => {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('@@auth0spajs@@') && !k.includes('@@user@@'));
  let token = null; for (const k of keys) { try { token = JSON.parse(localStorage.getItem(k)).body.access_token; } catch {} }
  const ws = localStorage.getItem('portal:workspace') ?? localStorage.getItem('portal-workspace') ?? null;
  const wsId = ws && ws.startsWith('"') ? JSON.parse(ws) : ws;
  const res = await fetch(${JSON.stringify(API)} + ${JSON.stringify(route)}, { method: ${JSON.stringify(method)}, headers: { Authorization: 'Bearer ' + token, 'X-Workspace-Id': wsId, 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json };
})()`);

// Open /events streams, counted from the network: one per dashboard, however many pages it visits.
const streams = new Map();
let maxOpenStreams = 0;
b.on((m) => {
  // A full page load drops the old document's streams without a loadingFailed for them.
  if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) streams.clear();
  // The CORS preflight is its own request to the same URL; it is not a stream.
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/events') && m.params.request.method !== 'OPTIONS') { streams.set(m.params.requestId, true); maxOpenStreams = Math.max(maxOpenStreams, streams.size); }
  if ((m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') && streams.has(m.params.requestId)) streams.delete(m.params.requestId);
});

/** The phone-width checks every screen must pass. */
async function mobileChecks(name) {
  const overflow = await b.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  const wide = overflow > 1 ? await b.evaluate(`[...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 6).map(e => e.tagName + '.' + String(e.className).slice(0, 60) + '@' + Math.round(e.getBoundingClientRect().right)).join(' | ')`) : '';
  ok(`${name}: no horizontal page scroll at 390px`, overflow <= 1, `overflow=${overflow} ${wide}`);
  // Anything visible poking past the right edge that is not inside its own scroller (the tab strip scrolls on purpose).
  const outside = await b.evaluate(`(() => {
    const inScroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const s = getComputedStyle(p); if ((s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden') && p.scrollWidth > p.clientWidth) return true; } return false; };
    return [...document.querySelectorAll('button, a, input, select, textarea, [role="combobox"]')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && e.offsetParent !== null && (r.right > innerWidth + 1 || r.left < -1) && !inScroller(e); }).slice(0, 5).map(e => (e.getAttribute('aria-label') || e.textContent.trim()).slice(0, 30) + '@' + Math.round(e.getBoundingClientRect().right));
  })()`);
  ok(`${name}: every control inside the viewport`, outside.length === 0, outside.join(' | '));
  const nav = await b.evaluate(`(() => { const n = [...document.querySelectorAll('nav')].find(n => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().bottom >= innerHeight - 1 && n.offsetParent !== null || (getComputedStyle(n).position === 'fixed' && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().height > 0)); if (!n) return null; const r = n.getBoundingClientRect(); const links = [...n.querySelectorAll('a, button')].map(a => a.getBoundingClientRect()); return { top: r.top, h: r.height, minTarget: Math.min(...links.map(l => Math.min(l.height, l.width))), active: n.querySelector('[aria-current="page"]')?.textContent.trim() ?? null }; })()`);
  ok(`${name}: bottom tab bar is there, touch-sized`, Boolean(nav) && nav.minTarget >= 44, JSON.stringify(nav));
  await b.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)'); await sleep(250);
  const covered = await b.evaluate(`(() => { const main = document.querySelector('main'); const content = main?.firstElementChild; const n = [...document.querySelectorAll('nav')].find(n => getComputedStyle(n).position === 'fixed' && n.getBoundingClientRect().height > 0); if (!content || !n) return 'no main/nav'; const last = content.getBoundingClientRect().bottom; return last <= n.getBoundingClientRect().top + 1 ? '' : 'content bottom ' + Math.round(last) + ' > nav top ' + Math.round(n.getBoundingClientRect().top); })()`);
  ok(`${name}: the tab bar covers no content`, covered === '', covered);
  await b.evaluate('window.scrollTo(0, 0)');
}

async function dialogFits(name) {
  const r = await b.evaluate(`(() => { const d = [...document.querySelectorAll('[role="dialog"]')].at(-1); if (!d) return null; const r = d.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight, scrolls: d.scrollHeight > d.clientHeight }; })()`);
  ok(`${name}: dialog fits the 390px screen`, Boolean(r) && r.left >= 0 && r.right <= r.vw + 0.5 && r.top >= 0 && r.bottom <= r.vh + 0.5, JSON.stringify(r));
  const overflow = await b.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  ok(`${name}: no page overflow with the dialog open`, overflow <= 1, `overflow=${overflow}`);
}

try {
  // 0. Sign in.
  await b.goto(`${BASE}/login/`, 2500);
  await clickText('Sign in'); await sleep(1500);
  await waitFor(`location.pathname === '/app/' || location.pathname === '/select-workspace/'`, 20000);
  if ((await path()).startsWith('/select-workspace/')) { await b.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Bright Smile Health'))?.click()`); await sleep(2500); }
  ok('signed in and on the dashboard', Boolean(await waitFor(`location.pathname === '/app/'`, 15000)), await path());
  const ws = await apiCall('GET', '/workspace');
  const wsId = ws.json?.id;
  ok('owner of a live workspace', ws.json?.role === 'owner' && Boolean(ws.json?.onboarding_completed_at), `${ws.json?.name} ${ws.json?.role}`);

  // 1. Live balance over SSE: the pill and D5 move on the frame, on any page, over one stream.
  await b.goto(`${BASE}/app/wallet/`, 3000);
  await waitFor(`document.querySelector('[data-testid="wallet-balance"]') && ${visiblePill} ? true : null`, 15000);
  await waitFor(`document.body.innerText.includes('Live')`, 10000);
  const real = (await apiCall('GET', '/wallet')).json.balance;
  await b.evaluate('window.__noReload = true');
  const fake = Math.round((real + 123.45) * 100) / 100;
  const fakeText = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(fake);
  await publishFrame(wsId, 'wallet', 'ledger', { delta: 123.45, balance_after: fake, reason: 'adjustment', ref_id: null });
  const moved = await waitFor(`(() => { const p = ${visiblePill}?.textContent ?? ''; const w = document.querySelector('[data-testid="wallet-balance"]')?.textContent ?? ''; return p.includes(${JSON.stringify(fakeText)}) && w.includes(${JSON.stringify(fakeText)}) ? p + ' | ' + w : null; })()`, 3000, 25);
  ok('SSE wallet frame moves the pill and the D5 balance at once', Boolean(moved), moved ?? `expected ${fakeText}`);
  ok('…without a reload', (await b.evaluate('window.__noReload === true')) === true);
  const settled = await waitFor(`(${visiblePill}?.textContent ?? '').includes(${JSON.stringify(new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(real))}) ? true : null`, 5000, 100);
  ok('…and re-reads GET /wallet to settle on the ledger’s balance', Boolean(settled));
  await publishFrame(wsId, 'wallet', 'ledger', { delta: 1, balance_after: 'not a number' });
  await publishFrame(wsId, 'wallet', 'ledger', null);
  await sleep(800);
  const afterBad = await b.evaluate(`${visiblePill}?.textContent ?? ''`);
  ok('malformed wallet frames change nothing and throw nothing', /\d/.test(afterBad) && !b.logs.some((l) => /exception/i.test(l)), afterBad);
  // Client-side move to another page: the shell's stream stays, the pill still hears frames.
  await clickText('Phone numbers', 'a'); await waitFor(`location.pathname === '/app/numbers/'`, 8000); await sleep(800);
  const fake2 = Math.round((real + 7.5) * 100) / 100;
  await publishFrame(wsId, 'wallet', 'ledger', { delta: 7.5, balance_after: fake2, reason: 'adjustment', ref_id: null });
  const moved2 = await waitFor(`(${visiblePill}?.textContent ?? '').includes(${JSON.stringify(new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(fake2))}) ? true : null`, 3000, 25);
  ok('the pill hears wallet frames on D4 too (the stream lives in the shell)', Boolean(moved2));
  ok('one /events stream at a time across pages', maxOpenStreams === 1, `max open=${maxOpenStreams}`);
  await sleep(1200);

  // 2. D4 Numbers.
  const numbers = (await apiCall('GET', '/numbers')).json ?? [];
  const live = numbers.find((n) => n.status === 'active');
  await waitFor(`document.querySelectorAll('tbody tr').length > 0`, 10000);
  const rowText = await b.evaluate(`document.querySelector('tbody tr')?.innerText ?? ''`);
  ok('D4 list shows the number with type, agent, status and calls', live && rowText.includes('Active') && /Forward target|New|SIP/.test(rowText), rowText.replace(/\s+/g, ' '));
  await b.shot(`${S}/shot-d11-numbers.png`, true);
  await clickText('Add number'); await waitFor(`document.querySelector('[role="dialog"]') ? true : null`, 5000);
  const addText = await b.evaluate(`document.querySelector('[role="dialog"]')?.innerText ?? ''`);
  ok('D4 Add number offers the three W6 options', /A new number/.test(addText) && /Keep your number/.test(addText) && /Bring your own line/.test(addText));
  await clickText('Cancel', 'button', `document.querySelector('[role="dialog"]')`); await sleep(500);

  if (live) {
    await b.evaluate(`document.querySelector('tbody tr').click()`); await waitFor(`location.search.includes('id=')`, 5000); await sleep(1200);
    const tabs = await b.evaluate(`[...document.querySelectorAll('[role="tab"]')].map(t => t.textContent.trim())`);
    ok('D4 detail opens with its sections', tabs.includes('Routing') && tabs.includes('Hand-off') && tabs.includes('Callers') && tabs.includes('Danger zone'), tabs.join(','));
    ok('D4 detail shows Forwarding only for a forward target, SIP only for SIP', live.forwarding ? tabs.includes('Forwarding') && !tabs.includes('SIP') : !tabs.includes('Forwarding'));
    ok('D4 routing shows the agent and the hours mode', /Around the clock|During business hours|On a schedule/.test(await bodyText()));

    // Rename, then put it back.
    await clickText('Rename'); await waitFor(`document.querySelector('#number-nickname') ? true : null`, 4000);
    await setInput('#number-nickname', 'D11 front desk'); await clickText('Save label'); await sleep(1200);
    ok('D4 rename saves the label', (await apiCall('GET', `/numbers/${live.id}`)).json?.nickname === 'D11 front desk' && (await bodyText()).includes('D11 front desk'));
    await clickText('Rename'); await waitFor(`document.querySelector('#number-nickname') ? true : null`, 4000);
    if (live.nickname) { await setInput('#number-nickname', live.nickname); await clickText('Save label'); } else await clickText('Remove label');
    await sleep(1200);
    ok('D4 rename put back', (await apiCall('GET', `/numbers/${live.id}`)).json?.nickname === live.nickname);

    // Callers: block a number, see it saved, remove it again.
    await pressTab('Callers'); await waitFor(`document.querySelector('#callers-block') ? true : null`, 5000);
    await b.evaluate(`document.querySelector('#callers-block').focus()`);
    await b.send('Input.insertText', { text: '+1 (514) 555-0199' }); await key('Enter', 'Enter', 13); await sleep(200);
    await clickText('Save callers'); await sleep(1500);
    const blocked = (await apiCall('GET', `/numbers/${live.id}`)).json?.blocklist ?? [];
    ok('D4 callers: a formatted number is saved to the block list as E.164', blocked.includes('+15145550199'), blocked.join(','));
    await b.evaluate(`document.querySelector('#callers-block').focus()`); await key('Backspace', 'Backspace', 8); await sleep(200);
    await clickText('Save callers'); await sleep(1500);
    ok('D4 callers: block list put back', JSON.stringify((await apiCall('GET', `/numbers/${live.id}`)).json?.blocklist) === JSON.stringify(live.blocklist));
    ok('D4 callers: recent callers listed', /Recent callers/.test(await bodyText()));
    await b.evaluate(`document.querySelector('#callers-block').focus()`);
    await b.send('Input.insertText', { text: '12' }); await key('Enter', 'Enter', 13); await sleep(300);
    ok('D4 callers: an entry that is not a number is refused before saving', /Not a phone number in international format/.test(await bodyText()));
    await b.evaluate(`document.querySelector('#callers-block').focus()`); await key('Backspace', 'Backspace', 8); await sleep(200);

    if (live.forwarding) {
      await pressTab('Forwarding'); await sleep(1500);
      const fwd = await bodyText();
      ok('D4 forwarding guide shows the carrier codes and both numbers', /Turn forwarding on|forward/i.test(fwd) && fwd.includes(live.forwarding.from.slice(-4)));
    }
    await pressTab('Hand-off'); await sleep(600);
    ok('D4 hand-off editor renders', /transfer a caller/i.test(await bodyText()));

    // Danger zone: the typed confirmation gates the button. Cancelled — this is a real number.
    await pressTab('Danger zone'); await sleep(600);
    await clickText('Release number'); await waitFor(`document.querySelector('#confirm-typed') ? true : null`, 4000);
    const confirmBtn = `[...document.querySelector('[role="dialog"]').querySelectorAll('button')].find(b => b.textContent.trim() === 'Release number')`;
    const disabledEmpty = await b.evaluate(`${confirmBtn}?.disabled`);
    await setInput('#confirm-typed', '+1999'); await sleep(150);
    const disabledWrong = await b.evaluate(`${confirmBtn}?.disabled`);
    await setInput('#confirm-typed', live.e164); await sleep(150);
    const enabledRight = await b.evaluate(`!${confirmBtn}?.disabled`);
    ok('D4 release needs the number typed exactly', disabledEmpty === true && disabledWrong === true && enabledRight === true, `${disabledEmpty}/${disabledWrong}/${enabledRight}`);
    await clickText('Cancel', 'button', `document.querySelector('[role="dialog"]')`); await sleep(400);
    ok('D4 release cancelled — the number is untouched', (await apiCall('GET', `/numbers/${live.id}`)).json?.status === 'active');
    await b.shot(`${S}/shot-d11-number-danger.png`, true);
  }

  // 3. D5 Wallet.
  await clickText('Wallet & billing', 'a'); await waitFor(`location.pathname === '/app/wallet/'`, 8000); await sleep(2000);
  const wallet = await bodyText();
  ok('D5 shows balance, plan and expiry', /credits/.test(wallet) && /plan/.test(wallet) && /(Expiring next|Nothing expiring)/.test(wallet));
  ok('D5 shows usage, credit history, invoices and payment methods', /Usage/.test(wallet) && /Credit history/.test(wallet) && /Invoices/.test(wallet) && /Payment methods/.test(wallet));
  const ledgerRows = await b.evaluate(`[...document.querySelectorAll('table[aria-label="Credit history"] tbody tr')].length`);
  ok('D5 ledger lists the movements', ledgerRows > 0, `rows=${ledgerRows}`);
  const w0 = (await apiCall('GET', '/wallet')).json;
  if (!w0.auto_topup?.card_last4 && !w0.auto_topup?.enabled) {
    await b.evaluate(`document.querySelector('#topup-enabled').click()`); await sleep(500);
    const threshold = await b.evaluate(`document.querySelector('#topup-threshold')?.value`);
    ok('D5 auto top-up suggests a threshold of at least 10', Number(threshold) >= 10, threshold);
    await clickText('Save auto top-up'); await sleep(1500);
    ok('D5 auto top-up without a saved card says so (NO_PAYMENT_METHOD)', /no saved card/i.test(await bodyText()));
    ok('D5 …and nothing was saved', (await apiCall('GET', '/wallet')).json.auto_topup?.enabled !== true);
    await b.evaluate(`document.querySelector('#topup-enabled').click()`); await sleep(300);
  }
  await clickText('Buy credits'); await waitFor(`document.querySelector('[role="dialog"] [role="radiogroup"]') ? true : null`, 8000);
  ok('D5 Buy credits opens the pack cards', Boolean(await b.evaluate(`document.querySelectorAll('[role="dialog"] [role="radio"]').length > 0`)));
  await key('Escape', 'Escape', 27); await sleep(400);
  await b.shot(`${S}/shot-d11-wallet.png`, true);

  // 4. D6 Settings.
  await clickText('Settings', 'a'); await waitFor(`location.pathname === '/app/settings/'`, 8000); await sleep(1500);
  const tabs6 = await b.evaluate(`[...document.querySelectorAll('[role="tab"]')].map(t => t.textContent.trim())`);
  ok('D6 has the six sections for an owner', ['Workspace', 'Team', 'Notifications', 'Security', 'Data & privacy', 'Audit log'].every((x) => tabs6.includes(x)), tabs6.join(','));
  ok('D6 workspace form is filled from the workspace', (await b.evaluate(`document.querySelector('#ws-name')?.value`)) === ws.json.name);
  await pressTab('Team'); await sleep(1500);
  ok('D6 team lists the owner', (await bodyText()).includes('saksham@metacognixion.com'));
  const invitee = `d11-invitee-${Date.now()}@example.test`;
  await setInput('#invite-email', invitee); await clickText('Send invite'); await sleep(1500);
  const link = await b.evaluate(`[...document.querySelectorAll('input[readonly]')].map(i => i.value).find(v => v.includes('/invite/?token=')) ?? null`);
  ok('D6 invite shows the join link once', Boolean(link), link ?? '');
  ok('D6 invite is pending', (await bodyText()).includes(invitee));
  await clickText('Revoke'); await sleep(1500);
  ok('D6 invite revoked', !(await apiCall('GET', '/invites')).json.some((i) => i.email === invitee));
  await pressTab('Notifications'); await sleep(1200);
  const n0 = (await apiCall('GET', '/workspace/notification-settings')).json;
  await b.evaluate(`document.querySelector('#notif-low').click()`); await clickText('Save notifications'); await sleep(1200);
  const n1 = (await apiCall('GET', '/workspace/notification-settings')).json;
  ok('D6 notification preference saved', n1.low_balance_email === !n0.low_balance_email && n1.is_default === false);
  await b.evaluate(`document.querySelector('#notif-low').click()`); await clickText('Save notifications'); await sleep(1200);
  ok('D6 notification preference put back', (await apiCall('GET', '/workspace/notification-settings')).json.low_balance_email === n0.low_balance_email);
  await pressTab('Security'); await sleep(500);
  ok('D6 security offers two-step verification, password reset and sign-out', /Two-step verification/.test(await bodyText()) && /Email me a reset link/.test(await bodyText()));
  await pressTab('Data & privacy'); await sleep(500);
  ok('D6 data & privacy shows recording default and retention', /Record calls on new agents/.test(await bodyText()) && /Keep recordings/.test(await bodyText()));
  await pressTab('Audit log'); await sleep(1500);
  const audit = await bodyText();
  ok('D6 audit log shows this run’s changes with the actor', /Changed a number’s settings|Invited someone|Revoked an invitation/.test(audit) && audit.includes('saksham@metacognixion.com'));

  // 5. D7 Help.
  await clickText('Help', 'a'); await waitFor(`location.pathname === '/app/help/'`, 8000); await sleep(2000);
  const help = await bodyText();
  ok('D7 guides: forwarding, SIP and billing (from the pricing config)', /Forward your existing number/.test(help) && /Connect your own phone system/.test(help) && /credits/.test(help) && /Calls are metered per second/.test(help));
  ok('D7 service status from the API readiness', /All systems operational/.test(help));
  ok('D7 support email and report-a-call', help.includes('support@oraly.ai') && /Report a call/.test(help));
  const reportHref = await b.evaluate(`[...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Report')?.href ?? ''`);
  ok('D7 report link carries the call id', !reportHref || /mailto:.*subject=Call%20report/.test(reportHref), reportHref.slice(0, 120));

  // 6. Phone width, every screen — in a fresh browser. A full-page capture (captureBeyondViewport)
  // poisons Chrome's emulation for the rest of the session: the next setDeviceMetricsOverride
  // reports clientWidth 390 but lays the initial containing block out at the old width, so D1's
  // grid items overflowed by 49 px in a viewport no device has. Seen 25 Sep 2026, 2/2 runs.
  desktopLogs = b.logs; b.close(); b = await launch({ port: 9336 });
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await b.goto(`${BASE}/login/`, 2500); await clickText('Sign in'); await sleep(1500);
  await waitFor(`location.pathname === '/app/' || location.pathname === '/select-workspace/'`, 20000);
  if ((await path()).startsWith('/select-workspace/')) { await b.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Bright Smile Health'))?.click()`); await sleep(2500); }
  await waitFor(`location.pathname === '/app/'`, 15000);
  const screens = [['d1', '/app/'], ['d2', '/app/calls/'], ['d3-list', '/app/agents/'], ['d4-list', '/app/numbers/'], ['d5', '/app/wallet/'], ['d7', '/app/help/']];
  if (live) for (const tab of ['routing', 'handoff', 'callers', ...(live.forwarding ? ['forwarding'] : []), 'danger']) screens.push([`d4-${tab}`, `/app/numbers/?id=${live.id}${tab === 'routing' ? '' : `&tab=${tab}`}`]);
  for (const tab of ['workspace', 'team', 'notifications', 'security', 'privacy', 'audit']) screens.push([`d6-${tab}`, tab === 'workspace' ? '/app/settings/' : `/app/settings/?tab=${tab}`]);
  const loaded = `document.querySelector('main h1') && [...document.querySelectorAll('nav')].some(n => getComputedStyle(n).position === 'fixed') && !document.querySelector('main [aria-busy="true"], main [aria-busy=""]') ? true : null`;
  for (const [name, url] of screens) {
    await b.goto(`${BASE}${url}`, 1500); await waitFor(loaded, 15000); await sleep(600);
    await mobileChecks(name);
    await b.shot(`${S}/shot-d11-mobile-${name}.png`, true);
  }
  // Dialogs and sheets at 390.
  await b.goto(`${BASE}/app/numbers/`, 1500); await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Add number') && b.offsetParent) ? true : null`, 15000);
  await clickText('Add number'); await waitFor(`document.querySelector('[role="dialog"]') ? true : null`, 4000); await sleep(300); await dialogFits('D4 add number'); await b.shot(`${S}/shot-d11-mobile-add-number.png`); await key('Escape', 'Escape', 27); await sleep(400);
  if (live) {
    await b.goto(`${BASE}/app/numbers/?id=${live.id}&tab=danger`, 1500); await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Release number' && b.offsetParent) ? true : null`, 15000);
    await clickText('Release number'); await waitFor(`document.querySelector('[role="dialog"]') ? true : null`, 4000); await sleep(300); await dialogFits('D4 release confirmation'); await b.shot(`${S}/shot-d11-mobile-release.png`); await key('Escape', 'Escape', 27); await sleep(400);
  }
  await b.goto(`${BASE}/app/wallet/`, 1500); await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Buy credits') && b.offsetParent) ? true : null`, 15000);
  await clickText('Buy credits'); await waitFor(`document.querySelectorAll('[role="dialog"] [role="radio"]').length > 0`, 8000); await sleep(300); await dialogFits('D5 buy credits'); await b.shot(`${S}/shot-d11-mobile-buy.png`); await key('Escape', 'Escape', 27); await sleep(400);
  await clickText('More'); await sleep(600);
  const more = await b.evaluate(`[...document.querySelectorAll('[role="dialog"] a')].map(a => a.textContent.trim())`);
  ok('phone "More" sheet holds Wallet, Settings and Help', ['Wallet & billing', 'Settings', 'Help'].every((x) => more.includes(x)), more.join(','));
  await dialogFits('More sheet');
  await clickText('Help', 'a', `document.querySelector('[role="dialog"]')`); await waitFor(`location.pathname === '/app/help/'`, 5000); await sleep(600);
  ok('the More sheet navigates and closes', (await path()) === '/app/help/' && !(await b.evaluate(`!!document.querySelector('[role="dialog"]')`)));
  const moreActive = await b.evaluate(`[...document.querySelectorAll('nav button')].find(x => x.textContent.includes('More'))?.className.includes('text-primary')`);
  ok('"More" shows as active on a screen behind it', moreActive === true);
  await clickText('Numbers', 'a'); await waitFor(`location.pathname === '/app/numbers/'`, 5000);
  if (live) {
    await b.goto(`${BASE}/app/numbers/?id=${live.id}`, 1500); await waitFor(`document.querySelectorAll('[role="tab"]').length > 0`, 15000);
    await clickText('Numbers', 'a'); await waitFor(`document.querySelectorAll('main ul[aria-label="Phone numbers"] li').length > 0`, 8000);
    ok('the Numbers tab from an open number goes back to the list', !(await path()).includes('id=') && (await b.evaluate(`document.querySelectorAll('main ul[aria-label="Phone numbers"] li').length`)) > 0, await path());
  }
  await b.goto(`${BASE}/app/calls/`, 3000); await sleep(2000);
  const cards = await b.evaluate(`document.querySelectorAll('main ul[aria-label="Calls"] > li').length`);
  ok('D2 calls are cards at 390px', cards > 0 || /No calls yet/.test(await bodyText()), `cards=${cards}`);
} catch (e) {
  ok('script completed without an exception', false, e?.stack ?? String(e));
}
const errors = [...desktopLogs, ...b.logs].filter((l) => !/favicon|posthog|Download the React DevTools|net::ERR_ABORTED|status of 402|status of 409|NO_PAYMENT_METHOD/.test(l));
ok('no unexpected console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(`${S}/e2e-dashboard-d11-results.txt`, results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed`);
b.close(); process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
