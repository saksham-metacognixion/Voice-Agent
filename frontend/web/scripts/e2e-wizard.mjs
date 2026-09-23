/**
 * The D8 exit check as a script: sign-up → workspace → W1 → W2 (autosave, restore, a real
 * Generate over SSE/polling) → W3 (voice persisted) → guards → dashboard shell, switcher,
 * A5, A6, both themes. Screenshots land in frontend/web/.e2e/.
 *
 * Needs: the portal served at PORTAL_URL (default http://localhost:3000 — the static
 * export behind `pnpm serve:export`, or `next dev`), the API + worker it was built
 * against, and an issuer the SDK can drive without a form (infra/scripts/local-issuer.mjs).
 * Each run wants a FRESH identity: set LOCAL_ISSUER_SUB/_EMAIL on the issuer, or point
 * both the issuer's LOCAL_ISSUER_USER_FILE and this script's E2E_USER_FILE at one file,
 * which this script rewrites with a new identity before it starts.
 */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const S = fileURLToPath(new URL('../.e2e', import.meta.url)); mkdirSync(S, { recursive: true });
const BASE = (process.env.PORTAL_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
if (process.env.E2E_USER_FILE) { const id = Date.now().toString(36); writeFileSync(process.env.E2E_USER_FILE, JSON.stringify({ sub: `auth0|e2e-${id}`, email: `e2e-${id}@example.test`, name: 'E2E Owner', email_verified: true })); }
const b = await launch({ port: 9333 });
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); console.log(results.at(-1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 15000, every = 250) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await b.evaluate(expr).catch(() => null); if (v) return v; await sleep(every); } return null; }
const path = async () => new URL(await b.url()).pathname + new URL(await b.url()).search;
const setInput = (selector, value) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
const clickText = (text, tag = 'button') => b.evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(tag)})]; const el = els.find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
const bodyText = () => b.evaluate('document.body.innerText');
const theme = () => b.evaluate('getComputedStyle(document.body).backgroundColor + " " + document.documentElement.className');

try {
  // 1. Anonymous → /login
  await b.goto(`${BASE}/`, 2500);
  ok('root redirects anonymous visitor to /login', (await path()).startsWith('/login/'), await path());
  await b.shot(`${S}/shot-login-light.png`);
  ok('login page in light theme', !(await theme()).includes('dark'), await theme());
  await b.evaluate(`localStorage.setItem('portal-theme', 'dark')`); await b.goto(`${BASE}/login/`, 2000);
  ok('dark theme persists across reload', (await theme()).includes('dark'), await theme());
  await b.shot(`${S}/shot-login-dark.png`);
  await b.evaluate(`localStorage.setItem('portal-theme', 'light')`);

  // 2. Protected route → login with next
  await b.goto(`${BASE}/onboarding/brief/`, 2500);
  ok('protected wizard route redirects with ?next', (await path()) === '/login/?next=%2Fonboarding%2Fbrief%2F', await path());
  await b.goto(`${BASE}/app/`, 2500);
  ok('dashboard redirects with ?next', (await path()).startsWith('/login/?next=%2Fapp'), await path());

  // 3. Signup through the issuer → callback → A4
  await b.goto(`${BASE}/signup/`, 2000);
  ok('signup page renders CTA', (await bodyText()).includes('Create account'));
  await clickText('Create account'); await sleep(4000);
  ok('after signup callback lands on workspace setup', (await path()) === '/setup/workspace/', await path());
  await b.shot(`${S}/shot-a4-setup.png`);

  // 4. A4 form
  await setInput('#name', 'Bright Smile Dental'); await setInput('#phone', '+14165550123'); await setInput('#website', 'https://brightsmile.example');
  await clickText('Create workspace'); const w1 = await waitFor(`location.pathname === '/onboarding/template/'`, 10000);
  ok('workspace created → W1', Boolean(w1), await path());

  // 5. W1
  const cards = await waitFor(`document.querySelectorAll('[aria-pressed]').length`, 10000);
  ok('W1 shows template cards', Number(cards) >= 6, `cards=${cards}`);
  await b.shot(`${S}/shot-w1.png`);
  // The W1 card's clickable element is the invisible overlay button (`absolute inset-0`),
  // which carries `aria-label` and no text of its own — the heading is a sibling behind
  // `pointer-events-none`. Match the label first, then fall back to text.
  await b.evaluate(`[...document.querySelectorAll('[aria-pressed]')].find(e => ((e.getAttribute('aria-label') ?? '') + e.textContent).includes('AI Receptionist')).click()`);
  await sleep(300);
  ok('W1 selects a template', await b.evaluate(`[...document.querySelectorAll('[aria-pressed="true"]')].length`) === 1);
  await clickText('Continue'); const w2 = await waitFor(`location.pathname === '/onboarding/brief/'`, 15000);
  ok('agent created → W2', Boolean(w2), await path());

  // 6. W2 — fields, autosave, restore
  await waitFor(`document.querySelector('#about_business')`, 10000);
  ok('W2 prefilled from template (agent name)', (await b.evaluate(`document.querySelector('#agent_name')?.value`)) === 'Sophie');
  await setInput('#about_business', 'We are a family dental practice in Toronto with three dentists. We see adults and children for check-ups, cleanings, fillings and emergencies.');
  await setInput('#goal', 'Book the caller into the next free slot, or take a message with their name and number if the request needs a person.');
  await setInput('#address', '120 King St W, Toronto, ON');
  await setInput('#pricing', 'Check-up and cleaning from $150.');
  await sleep(2500);
  const saved = await waitFor(`document.body.innerText.includes('Saved')`, 8000);
  ok('W2 autosaves 1.5 s after typing', Boolean(saved));
  await b.shot(`${S}/shot-w2.png`, true);
  await b.goto(`${BASE}/onboarding/brief/`, 3000); await waitFor(`document.querySelector('#about_business')?.value.length > 0`, 10000);
  ok('W2 restores saved values on return', (await b.evaluate(`document.querySelector('#address')?.value`)) === '120 King St W, Toronto, ON');

  // 7. Generate
  const genEnabled = await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Generate my agent') && !b.disabled)`, 5000);
  ok('Generate enabled once fields 1–2 valid', Boolean(genEnabled));
  await clickText('Generate my agent');
  const started = await waitFor(`document.body.innerText.includes('Writing your agent')`, 10000);
  ok('generation progress shown', Boolean(started));
  await sleep(1500); await b.shot(`${S}/shot-w2-generating.png`);
  const dup = await b.evaluate(`[...document.querySelectorAll('button')].filter(b => b.textContent.includes('Generate my agent')).length`);
  ok('Generate button hidden while running (no duplicate)', dup === 0);
  const done = await waitFor(`document.body.innerText.includes('Your agent is ready')`, 120000, 1000);
  ok('generation completes (SSE/polling)', Boolean(done));
  ok('brief card comes from the generated agent', Boolean(await waitFor(`document.body.innerText.includes('From your generated agent')`, 15000)));
  await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Choose a voice'))`, 15000);
  await b.shot(`${S}/shot-w2-generated.png`, true);
  await clickText('Choose a voice'); const w3 = await waitFor(`location.pathname === '/onboarding/voice/'`, 10000);
  ok('→ W3', Boolean(w3), await path());

  // 8. W3
  const voices = await waitFor(`document.querySelectorAll('[role="option"]').length`, 15000);
  ok('W3 lists voices', Number(voices) > 0, `voices=${voices}`);
  await b.evaluate(`document.querySelector('[role="option"] button').click()`); await sleep(1500);
  ok('W3 selects a voice (persisted)', await b.evaluate(`document.querySelector('[role="option"][aria-selected="true"]') !== null`));
  await b.shot(`${S}/shot-w3.png`, true);
  await b.goto(`${BASE}/onboarding/voice/`, 3000); await waitFor(`document.querySelectorAll('[role="option"]').length`, 15000);
  ok('W3 voice restored after reload', await b.evaluate(`document.querySelector('[role="option"][aria-selected="true"]') !== null`));
  await b.evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Hear this voice'))?.click()`); await sleep(1500);
  await clickText('Continue'); const w4 = await waitFor(`location.pathname === '/onboarding/knowledge/'`, 10000);
  ok('→ W4 placeholder', Boolean(w4), await path());

  // 9. Guards after W3
  await b.goto(`${BASE}/onboarding/test/`, 2500);
  ok('cannot skip ahead to W5', (await path()) !== '/onboarding/test/', await path());
  await b.goto(`${BASE}/onboarding/brief/`, 3000);
  ok('can revisit W2', (await path()) === '/onboarding/brief/', await path());
  ok('W2 revisit shows Regenerate', Boolean(await waitFor(`document.body.innerText.includes('Regenerate')`, 10000)));

  // 10. Dashboard shell
  await b.goto(`${BASE}/app/`, 3000);
  ok('dashboard reachable past W3', (await path()) === '/app/', await path());
  ok('shell shows workspace and balance', (await bodyText()).includes('Bright Smile Dental') && /\d+ credits/.test(await bodyText()));
  await b.shot(`${S}/shot-app-light.png`);
  await b.evaluate(`localStorage.setItem('portal-theme', 'dark')`); await b.goto(`${BASE}/app/`, 2500);
  await b.shot(`${S}/shot-app-dark.png`);
  ok('dashboard dark theme', (await theme()).includes('dark'));
  await b.evaluate(`localStorage.setItem('portal-theme', 'light')`);
  await b.goto(`${BASE}/app/settings/`, 2500);
  ok('settings page renders', (await bodyText()).includes('Appearance'));

  // 11. Switcher + second workspace + sign out
  await b.goto(`${BASE}/setup/workspace/`, 2500); await setInput('#name', 'Second Shop'); await clickText('Create workspace'); await waitFor(`location.pathname === '/onboarding/template/'`, 10000);
  await b.goto(`${BASE}/app/`, 3000);
  ok('new workspace starts onboarding (redirected from /app)', (await path()) === '/onboarding/template/', await path());
  await b.evaluate(`localStorage.removeItem('portal:workspace')`); await b.goto(`${BASE}/`, 3000);
  ok('two workspaces, none chosen → switcher page', (await path()) === '/select-workspace/', await path());
  await b.shot(`${S}/shot-a7.png`);
  await clickText('Bright Smile Dental'); await waitFor(`location.pathname === '/app/'`, 10000);
  ok('switcher selects and lands on dashboard', (await path()) === '/app/', await path());
  await b.goto(`${BASE}/mfa/`, 2500);
  ok('A5 page shows MFA status', (await bodyText()).includes('Two-factor'));
  await b.goto(`${BASE}/forgot-password/`, 2000); await setInput('#email', 'd8-owner@example.test'); await clickText('Send reset link'); await sleep(1500);
  ok('A6 forgot password sends and confirms', (await bodyText()).includes('Check your inbox'));
} catch (e) { ok('script error', false, String(e)); }
console.log('--- console errors ---'); console.log(b.logs.filter(l => !l.includes('favicon')).slice(0, 15).join('\n') || '(none)');
writeFileSync(`${S}/e2e-results.txt`, results.join('\n'));
b.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
