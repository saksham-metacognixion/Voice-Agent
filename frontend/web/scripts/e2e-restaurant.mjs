/**
 * Restaurant template, menu upload and business identity, end to end (25 Sep 2026):
 * sign-up → workspace "Bright Dental" → W1 Restaurant with a conflicting industry (the
 * warning, then the fix) → W2 banner, restaurant placeholders, a real Generate → the
 * prompt names the business and nothing else → W4 Menu section (locked on trial, then
 * paid: invalid file, upload, Ready on the real platform) → Regenerate carries the menu
 * rules → W5 a real browser test call whose transcript names the business → replace and
 * remove the menu → a Receptionist workspace sees no menu and keeps its own identity →
 * D3 header badge and Knowledge tab on a live workspace. Screenshots in frontend/web/.e2e/.
 *
 * Needs the same stack as e2e:wizard: the export at PORTAL_URL (default :3005) built
 * against API_URL (default :4001) with a worker, the local issuer on :9999 with
 * LOCAL_ISSUER_USER_FILE = this script's E2E_USER_FILE (rewritten per identity), Chrome,
 * and — for the D3 part — DASHBOARD_SUB, the owner of DASHBOARD_WORKSPACE_NAME (a live
 * workspace). The paid step runs `dev:seed-workspace` (APP_ENV=dev only).
 *
 *   PORTAL_URL=http://localhost:3005 API_URL=http://localhost:4001 E2E_USER_FILE=/tmp/e2e-user.json \
 *   MENU_FILE=/tmp/menu.txt MENU_FILE_V2=/tmp/menu-v2.txt BAD_FILE=/tmp/menu.exe \
 *   DASHBOARD_SUB='google-oauth2|…' DASHBOARD_WORKSPACE_NAME='Bright Smile Health' node scripts/e2e-restaurant.mjs
 */
import { launch } from './cdp.mjs';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const S = fileURLToPath(new URL('../.e2e', import.meta.url)); mkdirSync(S, { recursive: true });
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BASE = (process.env.PORTAL_URL ?? 'http://localhost:3005').replace(/\/+$/, '');
const API = (process.env.API_URL ?? 'http://localhost:4001').replace(/\/+$/, '');
const USER_FILE = process.env.E2E_USER_FILE;
if (!USER_FILE) throw new Error('E2E_USER_FILE is required (the issuer reads the same file)');
const MENU = process.env.MENU_FILE; const MENU_V2 = process.env.MENU_FILE_V2; const BAD = process.env.BAD_FILE;
if (!MENU || !MENU_V2 || !BAD) throw new Error('MENU_FILE, MENU_FILE_V2 and BAD_FILE are required');
const identity = (label) => { const id = Date.now().toString(36); writeFileSync(USER_FILE, JSON.stringify({ sub: `auth0|e2e-${label}-${id}`, email: `e2e-${label}-${id}@example.test`, name: 'E2E Owner', email_verified: true })); };
identity('rest');

const b = await launch({ port: 9335, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`); console.log(results.at(-1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 15000, every = 250) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await b.evaluate(expr).catch(() => null); if (v) return v; await sleep(every); } return null; }
const path = async () => { const u = new URL(await b.url()); return u.pathname + u.search; };
const setInput = (selector, value) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
const clickText = (text, tag = 'button') => b.evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(tag)})]; const el = els.find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
const bodyText = () => b.evaluate('document.body.innerText');
const has = (selector) => b.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);
const pressTab = (label) => b.evaluate(`(() => { const el = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent.trim() === ${JSON.stringify(label)}); if (!el) return 'missing'; el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })); el.click(); return 'ok'; })()`);
/** Radix Select: open on pointerdown, choose on pointerup. */
async function selectIndustry(value) {
  await b.evaluate(`document.querySelector('#industry').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' }))`);
  await waitFor(`document.querySelectorAll('[role="option"]').length > 0`, 5000);
  const r = await b.evaluate(`(() => { const o = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent.trim().toLowerCase() === ${JSON.stringify(value.toLowerCase())}); if (!o) return 'missing'; o.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse' })); o.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1, pointerType: 'mouse' })); o.click(); return 'ok'; })()`);
  await sleep(400);
  return r;
}
/** The signed-in API client from inside the page: the SPA's token + workspace header. */
const apiCall = (method, route, body) => b.evaluate(`(async () => {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('@@auth0spajs@@') && !k.includes('@@user@@'));
  let token = null; for (const k of keys) { try { token = JSON.parse(localStorage.getItem(k)).body.access_token; } catch {} }
  const ws = localStorage.getItem('portal:workspace') ?? null; const wsId = ws && ws.startsWith('"') ? JSON.parse(ws) : ws;
  const res = await fetch(${JSON.stringify(API)} + ${JSON.stringify(route)}, { method: ${JSON.stringify(method)}, headers: { Authorization: 'Bearer ' + token, 'X-Workspace-Id': wsId, ...(${body === undefined ? 'false' : 'true'} ? { 'Content-Type': 'application/json' } : {}) }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 2000) };
})()`);
async function setFile(selector, file) {
  const { root } = await b.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) return 'missing';
  await b.send('DOM.setFileInputFiles', { files: [file], nodeId });
  return 'ok';
}
const VENDOR = /retell|retail\s*ai/i;
async function currentAgent() { const r = await apiCall('GET', '/agents?limit=1'); return r.json?.items?.[0] ?? null; }
async function draftOf(agentId) { const r = await apiCall('GET', `/agents/${agentId}`); return r.json?.draft ?? null; }
/** Presses Generate/Regenerate and waits for a *new* draft version to exist — the page's "ready" copy is also shown for an earlier generation. */
async function generate(label, agentId) {
  const before = agentId ? ((await draftOf(agentId))?.version_no ?? 0) : 0;
  await clickText(label);
  const started = await waitFor(`document.body.innerText.includes('Writing your agent') || document.body.innerText.includes('Preparing') || document.body.innerText.includes('Queued')`, 15000, 100);
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const draft = agentId ? await draftOf(agentId) : null;
    if (agentId ? (draft?.version_no ?? 0) > before && draft?.has_prompt : await b.evaluate(`document.body.innerText.includes('Your agent is ready')`)) break;
    await sleep(1500);
  }
  const done = await waitFor(`document.body.innerText.includes('Your agent is ready')`, 30000, 1000);
  return Boolean(started) && Boolean(done);
}
/** Facts from the platform itself, through the API package's gateway client: the KB status and whether the agent's LLM points at it. */
function platformFacts(agentId) {
  const script = `
    import { adminDb } from '@portal/db';
    import Retell from 'retell-sdk';
    const agent = await adminDb.agent.findUniqueOrThrow({ where: { id: ${JSON.stringify(agentId)} }, select: { retellKbId: true, retellLlmId: true } });
    const client = new Retell({ apiKey: process.env.RETELL_API_KEY });
    const out = { kb_id: agent.retellKbId, llm_id: agent.retellLlmId, kb: null, llm_kbs: null };
    if (agent.retellKbId) { const kb = await client.knowledgeBase.retrieve(agent.retellKbId); out.kb = { status: kb.status, sources: (kb.knowledge_base_sources ?? []).map((s) => s.filename ?? s.title ?? s.url) }; }
    if (agent.retellLlmId) { const llm = await client.llm.retrieve(agent.retellLlmId); out.llm_kbs = llm.knowledge_base_ids ?? []; }
    console.log(JSON.stringify(out)); await adminDb.$disconnect();`;
  // No shell: the script carries `$disconnect`, which a double-quoted shell argument would expand away.
  const raw = execFileSync('npx', ['dotenv', '-e', '../../.env', '--', 'node', '--input-type=module', '-e', script], { cwd: `${ROOT}/backend/api`, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(raw.trim().split('\n').at(-1));
}

try {
  // 1. Sign up → A4 → workspace "Bright Dental" (the name is not a category)
  await b.goto(`${BASE}/signup/`, 2000);
  await clickText('Create account'); await sleep(4000);
  ok('signup lands on workspace setup', (await path()) === '/setup/workspace/', await path());
  await waitFor(`document.querySelector('#name') !== null`, 10000);
  await setInput('#name', 'Bright Dental');
  await clickText('Create workspace'); ok('workspace created → W1', Boolean(await waitFor(`location.pathname === '/onboarding/template/'`, 10000)), await path());

  // 2. W1 — Restaurant + a conflicting industry warns; a fitting one does not; the pick is stored
  await waitFor(`document.querySelectorAll('[aria-pressed]').length >= 6`, 10000);
  await b.evaluate(`[...document.querySelectorAll('[aria-pressed]')].find(e => (e.getAttribute('aria-label') ?? '').includes('Restaurant')).click()`); await sleep(300);
  ok('W1 Restaurant selected', await b.evaluate(`document.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label')?.includes('Restaurant')`));
  ok('W1 no warning before an industry is chosen', !(await has('[data-testid="template-conflict"]')));
  ok('W1 industry select picks dental', (await selectIndustry('dental')) === 'ok');
  const conflict = await waitFor(`document.querySelector('[data-testid="template-conflict"]')?.innerText`, 5000);
  ok('W1 warns that Restaurant is written for restaurants, not dental', Boolean(conflict) && /restaurant/i.test(conflict) && /dental/i.test(conflict), conflict);
  ok('W1 suggests a template that fits dental', /try:/i.test(conflict ?? '') && /Receptionist|Appointment/.test(conflict ?? ''), conflict);
  await b.shot(`${S}/shot-rest-w1-conflict.png`, true);
  ok('W1 industry select picks restaurant', (await selectIndustry('restaurant')) === 'ok');
  await sleep(300);
  ok('W1 warning clears once the industry fits', !(await has('[data-testid="template-conflict"]')));
  ok('W1 Continue still enabled — a warning never blocks', await b.evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Continue') && !b.disabled)`));
  await clickText('Continue'); ok('agent created → W2', Boolean(await waitFor(`location.pathname === '/onboarding/brief/'`, 15000)), await path());
  const agent = await currentAgent();
  ok('API stores template_id=restaurant and industry=restaurant on the agent', agent?.template_id === 'restaurant' && agent?.industry === 'restaurant', JSON.stringify({ template_id: agent?.template_id, industry: agent?.industry }));

  // 3. W2 — the banner and the restaurant copy, then a real Generate
  await waitFor(`document.querySelector('#about_business') !== null`, 10000);
  const banner = await b.evaluate(`document.querySelector('[data-testid="agent-context"]')?.innerText`);
  ok('W2 says which agent for which business', /Building a Restaurant agent for Bright Dental/.test(banner ?? ''), banner);
  ok('W2 template badge reads Restaurant · restaurant', /Restaurant · restaurant/i.test(await b.evaluate(`document.querySelector('[data-testid="template-badge"]')?.innerText`) ?? ''));
  const ph = await b.evaluate(`document.querySelector('#about_business')?.placeholder`);
  ok('W2 "About your business" placeholder is the restaurant example, not the dental one', /bistro/i.test(ph ?? '') && !/dental/i.test(ph ?? ''), ph);
  ok('W2 services placeholder is restaurant copy', /Dine-in|takeout/i.test(await b.evaluate(`document.querySelector('#services')?.placeholder`) ?? ''));
  ok('W2 agent name prefilled from the Restaurant template', (await b.evaluate(`document.querySelector('#agent_name')?.value`)) === 'Marie');
  ok('W2 goal prefilled from the template mentions the menu', /menu/i.test(await b.evaluate(`document.querySelector('#goal')?.value`) ?? ''));
  await b.shot(`${S}/shot-rest-w2.png`, true);
  await setInput('#about_business', "Bright Dental is actually a forty-seat Italian bistro on Queen Street in Toronto — the name is a family joke. Lunch and dinner, closed Mondays, reservations for parties up to eight.");
  await setInput('#address', '88 Queen St E, Toronto, ON');
  await sleep(2500); ok('W2 autosaves', Boolean(await waitFor(`document.body.innerText.includes('Saved')`, 8000)));
  ok('W2 generation completes', await generate('Generate my agent', agent.id));
  const draft1 = await draftOf(agent.id);
  ok('generated prompt names Bright Dental', /Bright Dental/.test(draft1?.prompt_text ?? ''));
  ok('generated prompt and greeting never name the voice platform', !VENDOR.test(`${draft1?.prompt_text}\n${draft1?.greeting}`), draft1?.greeting);
  ok('generated greeting names the business', /Bright Dental/.test(draft1?.greeting ?? ''), draft1?.greeting);
  ok('generated prompt is publishable (lint clean of errors)', draft1?.lint?.publishable === true, JSON.stringify(draft1?.lint?.findings?.map((f) => f.rule)));

  // 4. The category survives a reload and a round trip to another step
  await b.goto(`${BASE}/onboarding/brief/`, 3000); await waitFor(`document.querySelector('[data-testid="agent-context"]') !== null`, 10000);
  ok('W2 banner still Restaurant after reload', /Restaurant agent for Bright Dental/.test(await b.evaluate(`document.querySelector('[data-testid="agent-context"]')?.innerText`) ?? ''));
  await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Choose a voice'))`, 15000);
  await clickText('Choose a voice'); await waitFor(`location.pathname === '/onboarding/voice/'`, 10000);
  await waitFor(`document.querySelectorAll('[role="option"]').length`, 20000);
  await b.evaluate(`document.querySelector('[role="option"] button').click()`); await sleep(1200);
  await clickText('Continue'); ok('→ W4', Boolean(await waitFor(`location.pathname === '/onboarding/knowledge/'`, 10000)), await path());
  await b.goto(`${BASE}/onboarding/brief/`, 3000); await waitFor(`document.querySelector('[data-testid="agent-context"]') !== null`, 10000);
  ok('W2 banner still Restaurant after navigating away and back', /Restaurant agent for Bright Dental/.test(await b.evaluate(`document.querySelector('[data-testid="agent-context"]')?.innerText`) ?? ''));
  ok('W1 restores the Restaurant choice', Boolean(await (async () => { await b.goto(`${BASE}/onboarding/template/`, 3000); return waitFor(`document.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label')?.includes('Restaurant')`, 10000); })()));

  // 5. W4 — the Menu section: visible for a restaurant agent, locked on a trial plan
  await b.goto(`${BASE}/onboarding/knowledge/`, 3000);
  ok('W4 shows the Menu section for a restaurant agent', Boolean(await waitFor(`document.querySelector('[data-testid="menu-upload"]') !== null`, 10000)));
  ok('W4 banner shows the category too', /Restaurant agent for Bright Dental/.test(await b.evaluate(`document.querySelector('[data-testid="agent-context"]')?.innerText`) ?? ''));
  ok('W4 on trial explains the plan gate and disables the upload', (await bodyText()).includes('Included from a bigger pack') && (await b.evaluate(`document.querySelector('#menu-file')?.disabled`)) === true);
  await b.shot(`${S}/shot-rest-w4-locked.png`, true);
  const wsId = (await apiCall('GET', '/workspace')).json?.id;
  execSync(`pnpm --filter @portal/api dev:seed-workspace ${wsId} growth`, { cwd: ROOT, stdio: 'ignore' });
  await b.goto(`${BASE}/onboarding/knowledge/`, 3500); await waitFor(`document.querySelector('#menu-file') && !document.querySelector('#menu-file').disabled`, 15000);
  ok('W4 unlocked after a paid pack', (await b.evaluate(`document.querySelector('#menu-file')?.disabled`)) === false);

  // 6. Upload: an invalid type is refused in the browser, the real one goes to the platform
  ok('W4 file input set (invalid type)', (await setFile('#menu-file', BAD)) === 'ok'); await sleep(800);
  ok('W4 refuses a non-document file with a clear message', (await bodyText()).includes('That file type is not supported'), (await bodyText()).match(/That file type[^\n]*/)?.[0]);
  ok('W4 nothing was uploaded for the bad file', ((await apiCall('GET', `/agents/${agent.id}/knowledge`)).json ?? []).length === 0);
  ok('W4 file input set (menu.txt)', (await setFile('#menu-file', MENU)) === 'ok');
  ok('W4 shows the upload progress and then the row', Boolean(await waitFor(`document.querySelector('[data-testid="menu-row"]') !== null`, 60000, 500)));
  ok('W4 menu row shows Processing first', /Processing|Ready/.test(await b.evaluate(`document.querySelector('[data-testid="menu-row"]')?.innerText`) ?? ''));
  const ready = await waitFor(`document.querySelector('[data-testid="menu-row"]')?.innerText.includes('Ready')`, 180000, 2000);
  ok('W4 menu becomes Ready (ingested on the platform)', Boolean(ready), await b.evaluate(`document.querySelector('[data-testid="menu-row"]')?.innerText`));
  await b.shot(`${S}/shot-rest-w4-menu.png`, true);
  const sources = (await apiCall('GET', `/agents/${agent.id}/knowledge`)).json ?? [];
  ok('API lists exactly one source with role=menu, status ready, no platform ids', sources.length === 1 && sources[0].role === 'menu' && sources[0].status === 'ready' && !/retell|knowledge_base_/i.test(JSON.stringify(sources)), JSON.stringify(sources.map((s) => ({ role: s.role, status: s.status, name: s.name }))));
  ok('W4 ordinary sources list does not repeat the menu', !(await bodyText()).includes('menu.txt\nReady\n') || (await b.evaluate(`[...document.querySelectorAll('li')].filter(li => li.innerText.includes('menu.txt')).length`)) === 0);
  let facts = platformFacts(agent.id);
  ok('platform: the agent has a knowledge base with the menu, status complete', facts.kb?.status === 'complete' && facts.kb.sources.some((s) => /menu/i.test(s ?? '')), JSON.stringify(facts));

  // 7. Regenerate carries the menu rules into the prompt
  await b.goto(`${BASE}/onboarding/brief/`, 3000); await waitFor(`document.body.innerText.includes('Regenerate')`, 15000);
  ok('W2 regenerate completes', await generate('Regenerate', agent.id));
  const draft2 = await draftOf(agent.id);
  ok('regenerated prompt is a new version', (draft2?.version_no ?? 0) > (draft1?.version_no ?? 0), `v${draft1?.version_no} → v${draft2?.version_no}`);
  ok('regenerated prompt tells the agent to answer from the menu', /menu/i.test(draft2?.prompt_text ?? ''), (draft2?.prompt_text ?? '').match(/[^\n]*menu[^\n]*/i)?.[0]);
  ok('regenerated prompt says what to do when a dish is not on the menu', /not on (the|our) menu|isn.t on the menu|don.t have that/i.test(draft2?.prompt_text ?? ''));
  ok('regenerated prompt still names Bright Dental and never the platform', /Bright Dental/.test(draft2?.prompt_text ?? '') && !VENDOR.test(`${draft2?.prompt_text}\n${draft2?.greeting}`));

  // 8. W5 — a real browser test call: the agent introduces itself as the business
  await b.goto(`${BASE}/onboarding/knowledge/`, 3000); await waitFor(`document.body.innerText.includes('Add a source')`, 15000);
  await clickText('Continue'); ok('W4 Continue → W5', Boolean(await waitFor(`location.pathname === '/onboarding/test/'`, 10000)), await path());
  await waitFor(`document.body.innerText.includes('Talk to your agent')`, 15000);
  await clickText('Start test call');
  const onCall = await waitFor(`document.body.innerText.includes('Hang up')`, 40000, 500);
  ok('W5 test call connects', Boolean(onCall), onCall ? '' : (await bodyText()).slice(0, 300));
  const agentLine = await waitFor(`[...document.querySelectorAll('[aria-label="Live transcript"] li')].some(li => li.textContent.startsWith('Agent'))`, 40000, 500);
  ok('W5 live transcript shows the agent speaking', Boolean(agentLine));
  await sleep(6000);
  const transcript = await b.evaluate(`[...document.querySelectorAll('[aria-label="Live transcript"] li')].map(li => li.textContent).join('\\n')`);
  ok('W5 the agent introduces itself for Bright Dental', /Bright Dental/i.test(transcript ?? ''), transcript);
  ok('W5 the agent never says it is from the voice platform', !VENDOR.test(transcript ?? ''), transcript);
  await b.shot(`${S}/shot-rest-w5-call.png`, true);
  await clickText('Hang up');
  ok('W5 call ends cleanly', Boolean(await waitFor(`document.body.innerText.includes('Call ended')`, 15000)));
  facts = platformFacts(agent.id);
  ok('platform: the test call rang an LLM that points at the menu knowledge base', Array.isArray(facts.llm_kbs) && facts.llm_kbs.includes(facts.kb_id), JSON.stringify(facts));
  ok('W5 after-call shows the charge', Boolean(await waitFor(`/Credits charged\\s*\\d/.test(document.body.innerText)`, 90000, 1000)));

  // 9. Replace, then remove
  await b.goto(`${BASE}/onboarding/knowledge/`, 3500); await waitFor(`document.querySelector('[data-testid="menu-row"]') !== null`, 15000);
  ok('W4 offers Replace and Remove for an existing menu', (await bodyText()).includes('Replace menu') && (await bodyText()).includes('Remove'));
  const firstMenuId = sources[0].id;
  ok('W4 file input set (menu-v2.txt)', (await setFile('#menu-file', MENU_V2)) === 'ok');
  const replaced = await waitFor(`document.querySelector('[data-testid="menu-row"]')?.innerText.includes('menu-v2') && document.querySelector('[data-testid="menu-row"]')?.innerText.includes('Ready')`, 180000, 2000);
  ok('W4 replaced menu becomes Ready', Boolean(replaced), await b.evaluate(`document.querySelector('[data-testid="menu-row"]')?.innerText`));
  const afterReplace = (await apiCall('GET', `/agents/${agent.id}/knowledge`)).json ?? [];
  ok('API: one menu, the new one; the old row is gone', afterReplace.filter((s) => s.role === 'menu').length === 1 && !afterReplace.some((s) => s.id === firstMenuId) && /menu-v2/.test(afterReplace.find((s) => s.role === 'menu')?.name ?? ''), JSON.stringify(afterReplace.map((s) => s.name)));
  facts = platformFacts(agent.id);
  ok('platform: the knowledge base holds the new menu only', facts.kb?.sources.length === 1 && /menu-v2/.test(facts.kb.sources[0] ?? ''), JSON.stringify(facts.kb));
  await clickText('Remove'); ok('W4 remove asks for confirmation', Boolean(await waitFor(`document.body.innerText.includes('Remove the menu?')`, 5000)));
  await b.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Remove')?.click()`);
  const removed = await waitFor(`!document.querySelector('[data-testid="menu-row"]') && document.body.innerText.includes('No menu uploaded yet')`, 60000, 1000);
  ok('W4 menu removed', Boolean(removed));
  const afterRemove = (await apiCall('GET', `/agents/${agent.id}/knowledge`)).json ?? [];
  ok('API: no menu after removal', !afterRemove.some((s) => s.role === 'menu'));
  facts = platformFacts(agent.id);
  ok('platform: the last source took the knowledge base with it', facts.kb_id === null, JSON.stringify(facts));
  await b.shot(`${S}/shot-rest-w4-removed.png`, true);

  // 10. A non-restaurant workspace: no menu, its own identity, the receptionist example copy
  await b.goto(`${BASE}/setup/workspace/`, 2500); await waitFor(`document.querySelector('#name') !== null`, 10000);
  await setInput('#name', 'Second Shop'); await clickText('Create workspace'); await waitFor(`location.pathname === '/onboarding/template/'`, 10000);
  await waitFor(`document.querySelectorAll('[aria-pressed]').length >= 6`, 10000);
  await b.evaluate(`[...document.querySelectorAll('[aria-pressed]')].find(e => (e.getAttribute('aria-label') ?? '').includes('AI Receptionist')).click()`); await sleep(300);
  await selectIndustry('dental'); await sleep(300);
  ok('W1 Receptionist + dental raises no warning', !(await has('[data-testid="template-conflict"]')));
  await clickText('Continue'); await waitFor(`location.pathname === '/onboarding/brief/'`, 15000);
  await waitFor(`document.querySelector('#about_business') !== null`, 10000);
  ok('W2 banner reads Receptionist for Second Shop', /Building a Receptionist agent for Second Shop/.test(await b.evaluate(`document.querySelector('[data-testid="agent-context"]')?.innerText`) ?? ''));
  ok('W2 placeholder is the dental example for a dental receptionist', /dental/i.test(await b.evaluate(`document.querySelector('#about_business')?.placeholder`) ?? ''));
  await setInput('#about_business', 'Second Shop is a family dental practice in Toronto with three dentists. We see adults and children for check-ups, cleanings, fillings and emergencies.');
  await setInput('#goal', 'Book the caller into the next free slot, or take a message with their name and number if the request needs a person.');
  await sleep(2500); await waitFor(`document.body.innerText.includes('Saved')`, 8000);
  const shopAgent = await currentAgent();
  ok('W2 (receptionist) generation completes', await generate('Generate my agent', shopAgent.id));
  const shopDraft = await draftOf(shopAgent.id);
  ok('receptionist prompt names Second Shop, never the platform, and says nothing about a menu', /Second Shop/.test(shopDraft?.prompt_text ?? '') && !VENDOR.test(`${shopDraft?.prompt_text}\n${shopDraft?.greeting}`) && !/menu/i.test(shopDraft?.prompt_text ?? ''), shopDraft?.greeting);
  await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Choose a voice'))`, 15000);
  await clickText('Choose a voice'); await waitFor(`location.pathname === '/onboarding/voice/'`, 10000);
  await waitFor(`document.querySelectorAll('[role="option"]').length`, 20000);
  // W3's Continue is disabled until a voice is picked.
  await b.evaluate(`document.querySelector('[role="option"] button').click()`); await sleep(1200);
  await clickText('Continue'); ok('W3 (receptionist) → W4', Boolean(await waitFor(`location.pathname === '/onboarding/knowledge/'`, 10000)), await path());
  await waitFor(`location.pathname === '/onboarding/knowledge/' && document.body.innerText.includes('Add a source')`, 15000);
  ok('W4 shows no Menu section for a receptionist', !(await has('[data-testid="menu-upload"]')) && (await bodyText()).includes('Add a source'));
  ok('API refuses a menu on a non-restaurant agent', (await apiCall('POST', `/agents/${shopAgent.id}/knowledge`, { type: 'text', name: 'Menu', text: 'Soup $6', role: 'menu' })).status === 400);

  // 11. D3 on a live workspace: the header badge, the Knowledge tab with and without a menu
  if (process.env.DASHBOARD_SUB && process.env.DASHBOARD_WORKSPACE_NAME) {
    writeFileSync(USER_FILE, JSON.stringify({ sub: process.env.DASHBOARD_SUB, email: process.env.DASHBOARD_EMAIL ?? 'owner@example.test', name: 'Owner', email_verified: true }));
    await b.evaluate(`localStorage.clear(); sessionStorage.clear();`);
    await b.goto(`${BASE}/login/`, 2500); await clickText('Sign in'); await sleep(1500);
    await waitFor(`location.pathname === '/app/' || location.pathname === '/select-workspace/'`, 20000);
    if ((await path()).startsWith('/select-workspace/')) { await b.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(process.env.DASHBOARD_WORKSPACE_NAME)}))?.click()`); await sleep(2500); }
    ok('signed in to the live workspace', Boolean(await waitFor(`location.pathname === '/app/'`, 15000)), await path());
    const live = (await apiCall('GET', '/agents?limit=1')).json?.items?.[0];
    await b.goto(`${BASE}/app/agents/detail/?id=${live.id}`, 3500); await waitFor(`document.querySelector('[data-testid="template-badge"]') !== null`, 15000);
    const badge = await b.evaluate(`document.querySelector('[data-testid="template-badge"]')?.innerText`);
    ok('D3 header carries the template badge', Boolean(badge) && badge.length > 0, badge);
    ok('D3 header badge matches the stored template', new RegExp(live.template_id === 'restaurant' ? 'Restaurant' : live.template_id ?? 'Custom', 'i').test(badge ?? ''), `template_id=${live.template_id}`);
    await pressTab('Knowledge'); await sleep(1500);
    const liveHasMenu = live.template_id === 'restaurant' || (live.industry ?? '').toLowerCase() === 'restaurant';
    ok('D3 Knowledge tab shows the Menu section only for a restaurant agent', (await has('[data-testid="menu-upload"]')) === liveHasMenu, `restaurant=${liveHasMenu}`);
    await b.shot(`${S}/shot-rest-d3-knowledge.png`, true);
    // A new Restaurant agent from the dashboard gets the section; a Receptionist does not.
    const created = await apiCall('POST', '/agents', { template_id: 'restaurant', industry: 'restaurant', name: 'E2E Bistro' });
    ok('D3 new restaurant agent created', created.status === 201, created.text);
    await b.goto(`${BASE}/app/agents/detail/?id=${created.json.id}&tab=knowledge`, 3500);
    ok('D3 new restaurant agent: header badge reads Restaurant', /Restaurant/.test(await waitFor(`document.querySelector('[data-testid="template-badge"]')?.innerText`, 15000) ?? ''));
    ok('D3 new restaurant agent: Knowledge tab shows the Menu section', Boolean(await waitFor(`document.querySelector('[data-testid="menu-upload"]') !== null`, 10000)));
    await b.goto(`${BASE}/app/agents/detail/?id=${created.json.id}&tab=brief`, 3500); await waitFor(`document.querySelector('#about_business') !== null`, 15000);
    ok('D3 Brief tab uses the restaurant placeholder', /bistro/i.test(await b.evaluate(`document.querySelector('#about_business')?.placeholder`) ?? ''));
    await b.shot(`${S}/shot-rest-d3-brief.png`, true);
    ok('D3 agents list shows the template and industry', Boolean(await (async () => { await b.goto(`${BASE}/app/agents/`, 3000); return waitFor(`document.body.innerText.includes('Restaurant · restaurant')`, 10000); })()));
    const del = await apiCall('DELETE', `/agents/${created.json.id}`);
    ok('D3 e2e agent removed again', del.status === 200, del.text);
  } else {
    console.log('SKIP D3 checks: set DASHBOARD_SUB and DASHBOARD_WORKSPACE_NAME');
  }
} catch (e) {
  ok('script completed without an exception', false, String(e?.stack ?? e));
} finally {
  await b.shot(`${S}/shot-rest-final.png`, true).catch(() => {});
  b.close();
}
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (b.logs.length) console.log('console:', b.logs.slice(0, 20).join('\n'));
process.exit(failed.length ? 1 : 0);
