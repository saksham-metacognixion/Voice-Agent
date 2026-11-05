/**
 * The wizard end to end: sign-up → workspace → W1 (searchable industry, Save and exit,
 * the dashboard's "Continue setup") → W2 (hours default, never-do presets, services free
 * text, FAQ routing, autosave, restore, Back, the free note, a real Generate over
 * SSE/polling with the spec's three stages, the Regenerate dialog) → W3 (country default,
 * auto-picked voice, accent filter, sliders, Save and exit, voice persisted) → guards →
 * W5 (a real browser test call, after-call card, feedback → new version) → W6 (A/B/C,
 * forwarding guide, transfer targets, persistence) → W7 (packs, Stripe Checkout redirect,
 * cancel and unpaid returns) → switcher, A5, A6, both themes. Screenshots land in
 * frontend/web/.e2e/. Paying and going live is not scripted: activation buys a real number.
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
// Chrome's fake microphone: the W5 permission prompt is accepted and a test tone is sent.
const b = await launch({ port: 9333, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); console.log(results.at(-1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 15000, every = 250) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await b.evaluate(expr).catch(() => null); if (v) return v; await sleep(every); } return null; }
const path = async () => new URL(await b.url()).pathname + new URL(await b.url()).search;
const setInput = (selector, value) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
const clickText = (text, tag = 'button') => b.evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(tag)})]; const el = els.find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
const bodyText = () => b.evaluate('document.body.innerText');
const theme = () => b.evaluate('getComputedStyle(document.body).backgroundColor + " " + document.documentElement.className');
const testid = (id) => `document.querySelector('[data-testid="${id}"]')`;
const click = (selector) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
/** A Radix slider thumb takes the keyboard: Home/End/arrows move it in steps. */
/** One press per round trip: the slider is controlled, so React must paint between presses. */
async function sliderKey(id, key, times = 1) { for (let i = 0; i < times; i++) { await b.evaluate(`(() => { const el = ${testid(id)}?.querySelector('[role="slider"]'); if (!el) return 'missing'; el.focus(); el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); return 'ok'; })()`); await sleep(60); } }
const sliderNow = (id) => b.evaluate(`Number(${testid(id)}?.querySelector('[role="slider"]')?.getAttribute('aria-valuenow'))`);
const sliderRange = (id) => b.evaluate(`(() => { const el = ${testid(id)}?.querySelector('[role="slider"]'); return el ? el.getAttribute('aria-valuemin') + '-' + el.getAttribute('aria-valuemax') : null; })()`);

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
  // ADR 0036: the Terms screen is the first door after sign-in; accept it and move on.
  if ((await path()).startsWith('/terms/')) {
    ok('after signup callback the Terms screen comes first (ADR 0036)', true);
    await b.evaluate(`document.querySelector('#terms-agree')?.click(); 'ok'`); await sleep(300);
    await clickText('Continue'); await waitFor(`!location.pathname.startsWith('/terms')`, 10000); await sleep(1500);
  }
  ok('after terms the callback lands on workspace setup', (await path()) === '/setup/workspace/', await path());
  await b.shot(`${S}/shot-a4-setup.png`);

  // 4. A4 form
  await setInput('#name', 'Bright Smile Dental'); await setInput('#phone', '+14165550123'); await setInput('#website', 'https://brightsmile.example');
  await clickText('Create workspace'); const w1 = await waitFor(`location.pathname === '/onboarding/template/'`, 10000);
  ok('workspace created → W1', Boolean(w1), await path());

  // 5. W1
  const cards = await waitFor(`document.querySelectorAll('[aria-pressed]').length`, 10000);
  ok('W1 shows template cards', Number(cards) >= 6, `cards=${cards}`);
  await b.shot(`${S}/shot-w1.png`);
  // §8 W1 "hear sample": a static clip, played and paused by the same button; a second clip stops the first.
  const sampleButtons = `[...document.querySelectorAll('button[aria-label="Play"]')]`;
  await b.evaluate(`${sampleButtons}[0]?.click()`);
  ok('W1 sample plays', Boolean(await waitFor(`document.querySelectorAll('button[aria-label="Pause"]').length === 1`, 5000)));
  await b.evaluate(`${sampleButtons}[0]?.click()`); await sleep(300);
  ok('W1 a second sample stops the first (one playing at a time)', await b.evaluate(`document.querySelectorAll('button[aria-label="Pause"]').length === 1`));
  await b.evaluate(`document.querySelector('button[aria-label="Pause"]')?.click()`); await sleep(300);
  ok('W1 pause stops the sample', await b.evaluate(`document.querySelectorAll('button[aria-label="Pause"]').length === 0 && document.querySelectorAll('button[aria-label="Play"]').length >= 6`));
  ok('W1 no sample button is unavailable', await b.evaluate(`document.querySelectorAll('button[aria-label="Sample unavailable"]').length === 0`));
  // The W1 card's clickable element is the invisible overlay button (`absolute inset-0`),
  // which carries `aria-label` and no text of its own — the heading is a sibling behind
  // `pointer-events-none`. Match the label first, then fall back to text.
  ok('W1 Continue waits for a template (footer, §7.3)', await b.evaluate(`${testid('wizard-continue')}?.disabled === true && !document.querySelector('[data-testid="wizard-back"]')`));
  await b.evaluate(`[...document.querySelectorAll('[aria-pressed]')].find(e => ((e.getAttribute('aria-label') ?? '') + e.textContent).includes('AI Receptionist')).click()`);
  await sleep(300);
  ok('W1 selects a template', await b.evaluate(`[...document.querySelectorAll('[aria-pressed="true"]')].length`) === 1);
  // The §8 searchable industry select (~40 options, ADR 0039): open, search, pick.
  await click('#industry'); await waitFor(`document.querySelectorAll('[role="option"]').length > 0`, 5000);
  const industryCount = await b.evaluate(`document.querySelectorAll('[role="option"]').length`);
  ok('W1 industry list has about 40 options', Number(industryCount) >= 40, `options=${industryCount}`);
  await setInput('[role="combobox"]', 'dent'); await sleep(200);
  const narrowed = await b.evaluate(`[...document.querySelectorAll('[role="option"]')].map(o => o.textContent.trim())`);
  ok('W1 industry search narrows the list', Array.isArray(narrowed) && narrowed.length < Number(industryCount) && narrowed.includes('Dental'), JSON.stringify(narrowed));
  await b.evaluate(`[...document.querySelectorAll('[role="option"]')].find(o => o.textContent.trim() === 'Dental')?.click()`); await sleep(300);
  ok('W1 industry pick is shown on the field', (await b.evaluate(`document.querySelector('#industry')?.textContent.trim()`)) === 'Dental');
  // "Save and exit" (§7.3, §6.4 dismissal): the pick is kept, the dashboard opens with "Continue setup".
  await click('[data-testid="save-exit"]'); const exited = await waitFor(`location.pathname === '/app/'`, 15000);
  ok('W1 Save and exit opens the dashboard', Boolean(exited), await path());
  ok('dashboard offers to continue the set-up', Boolean(await waitFor(`document.body.innerText.includes('Continue setup')`, 10000)));
  await b.shot(`${S}/shot-w1-exited.png`);
  await clickText('Continue setup', 'a'); const resumed = await waitFor(`location.pathname === '/onboarding/brief/'`, 15000);
  ok('Continue setup resumes at W2 with the agent created on exit', Boolean(resumed), await path());
  await b.goto(`${BASE}/onboarding/template/`, 3000); await waitFor(`document.querySelectorAll('[aria-pressed]').length`, 10000);
  ok('W1 restores the template and industry on return', await b.evaluate(`document.querySelectorAll('[aria-pressed="true"]').length === 1 && document.querySelector('#industry')?.textContent.trim() === 'Dental'`));
  await clickText('Continue'); const w2 = await waitFor(`location.pathname === '/onboarding/brief/'`, 15000);
  ok('agent kept → W2', Boolean(w2), await path());

  // 6. W2 — fields, autosave, restore
  await waitFor(`document.querySelector('#about_business')`, 10000);
  ok('W2 prefilled from template (agent name)', (await b.evaluate(`document.querySelector('#agent_name')?.value`)) === 'Sophie');
  ok('W2 says which template for which business', /Building a Receptionist agent for Bright Smile Dental/.test(await b.evaluate(`document.querySelector('[data-testid="agent-context"]')?.innerText`) ?? ''));
  ok('W2 Back goes to W1 and Continue waits for a script (§7.3)', await b.evaluate(`document.querySelector('[data-testid="wizard-back"]')?.getAttribute('href') === '/onboarding/template/' && ${testid('wizard-continue')}?.disabled === true`));
  ok('W2 says generation is free', Boolean(await waitFor(`${testid('generate-free')}?.textContent.includes('No credits used')`, 5000)));
  // §8 W2 #3: Mon–Fri 9–5 by default, weekend closed.
  const hours = await b.evaluate(`(() => { const sw = [...document.querySelectorAll('[role="switch"]')].slice(0, 7).map(s => s.getAttribute('aria-checked')); const times = [...document.querySelectorAll('input[type="time"]')].map(i => i.value); return { sw, times }; })()`);
  ok('W2 hours default to Mon–Fri 9–5', hours && hours.sw.join(',') === 'true,true,true,true,true,false,false' && hours.times.every((v, i) => v === (i % 2 ? '17:00' : '09:00')) && hours.times.length === 10, JSON.stringify(hours));
  // §8 W2 #8: the template's own presets are ticked; a third is ticked here and must survive a reload.
  ok('W2 never-do presets come ticked from the template', await b.evaluate(`${testid('never-do-no_prices')}?.getAttribute('aria-checked') === 'true' && ${testid('never-do-no_time_promises')}?.getAttribute('aria-checked') === 'true' && ${testid('never-do-no_medical_advice')}?.getAttribute('aria-checked') === 'false'`));
  await click('[data-testid="never-do-no_medical_advice"]');
  ok('W2 FAQ routing explains the trial plan (into the script)', Boolean(await waitFor(`document.body.innerText.includes('straight into the script')`, 5000)));
  await setInput('#about_business', 'We are a family dental practice in Toronto with three dentists. We see adults and children for check-ups, cleanings, fillings and emergencies.');
  await setInput('#goal', 'Book the caller into the next free slot, or take a message with their name and number if the request needs a person.');
  await setInput('#address', '120 King St W, Toronto, ON');
  await setInput('#services_notes', 'Cleanings take 45 minutes. Emergencies are seen the same day.');
  await setInput('#pricing', 'Check-up and cleaning from $150.');
  await sleep(2500);
  const saved = await waitFor(`document.body.innerText.includes('Saved')`, 8000);
  ok('W2 autosaves 1.5 s after typing', Boolean(saved));
  await b.shot(`${S}/shot-w2.png`, true);
  await b.goto(`${BASE}/onboarding/brief/`, 3000); await waitFor(`document.querySelector('#about_business')?.value.length > 0`, 10000);
  ok('W2 restores saved values on return', (await b.evaluate(`document.querySelector('#address')?.value`)) === '120 King St W, Toronto, ON');
  ok('W2 restores the services free text and the ticked preset', await b.evaluate(`document.querySelector('#services_notes')?.value.startsWith('Cleanings take') && ${testid('never-do-no_medical_advice')}?.getAttribute('aria-checked') === 'true'`));
  // The template's own personality (receptionist: 50 / 60 / 50), on three 0–100 sliders.
  ok('W2 personality sliders carry the template defaults', (await b.evaluate(`[...document.querySelectorAll('[role="slider"]')].slice(0, 3).map(s => s.getAttribute('aria-valuemin') + '/' + s.getAttribute('aria-valuenow') + '/' + s.getAttribute('aria-valuemax')).join(' ')`)) === '0/50/100 0/60/100 0/50/100');

  // 7. Generate
  const genEnabled = await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Generate my agent') && !b.disabled)`, 5000);
  ok('Generate enabled once fields 1–2 valid', Boolean(genEnabled));
  await clickText('Generate my agent');
  const started = await waitFor(`document.body.innerText.includes('Writing your agent')`, 10000);
  ok('generation progress shown', Boolean(started));
  const stages = await b.evaluate(`[...document.querySelectorAll('[data-testid="generation-stages"] li')].map(li => li.textContent.replace(/[0-9]+$/, '').trim())`);
  ok('generation shows the spec’s three stages', Array.isArray(stages) && stages.join('|') === 'Reading your brief|Writing the conversation|Setting up analysis', JSON.stringify(stages));
  await sleep(1500); await b.shot(`${S}/shot-w2-generating.png`);
  const dup = await b.evaluate(`[...document.querySelectorAll('button')].filter(b => b.textContent.includes('Generate my agent')).length`);
  ok('Generate button hidden while running (no duplicate)', dup === 0);
  const done = await waitFor(`document.body.innerText.includes('Your agent is ready')`, 120000, 1000);
  ok('generation completes (SSE/polling)', Boolean(done));
  ok('brief card comes from the generated agent', Boolean(await waitFor(`document.body.innerText.includes('From your generated agent')`, 15000)));
  await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('Choose a voice') && !b.disabled)`, 15000);
  await b.shot(`${S}/shot-w2-generated.png`, true);
  // §8 W2 "Regenerate … confirm dialog": Cancel leaves the script alone.
  await click('[data-testid="regenerate"]');
  ok('Regenerate asks first', Boolean(await waitFor(`document.querySelector('[role="dialog"]')?.textContent.includes('Rewrite the conversation?')`, 5000)));
  await b.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Cancel')?.click()`); await sleep(500);
  ok('cancelling the dialog starts nothing', await b.evaluate(`document.querySelector('[role="dialog"]') === null && !document.body.innerText.includes('Writing your agent')`));
  await clickText('Choose a voice'); const w3 = await waitFor(`location.pathname === '/onboarding/voice/'`, 10000);
  ok('→ W3', Boolean(w3), await path());

  // 8. W3
  const voices = await waitFor(`document.querySelectorAll('[data-testid="voice-card"]').length`, 15000);
  ok('W3 lists voices', Number(voices) > 0, `voices=${voices}`);
  ok('W3 main language defaults from the workspace country (English)', /English/.test(await b.evaluate(`document.querySelector('#primary-language')?.textContent`) ?? ''));
  ok('W3 Back goes to W2', await b.evaluate(`document.querySelector('[data-testid="wizard-back"]')?.getAttribute('href') === '/onboarding/brief/'`));
  // §8 W3: a draft with no voice gets one picked for its language, with a toast.
  const autoPicked = await waitFor(`document.querySelector('[data-testid="voice-card"] button[aria-pressed="true"]') !== null`, 10000);
  ok('W3 picks a native voice automatically', Boolean(autoPicked));
  ok('W3 says which voice it picked', Boolean(await waitFor(`document.body.innerText.includes('was chosen for')`, 5000)));
  ok('W3 offers an accent filter', await b.evaluate(`${testid('accent-filter')} !== null`));
  await b.evaluate(`document.querySelectorAll('[data-testid="voice-select"]')[1].click()`); await sleep(1500);
  ok('W3 selects a voice (persisted)', await b.evaluate(`document.querySelectorAll('[data-testid="voice-select"][aria-pressed="true"]').length === 1`));
  // §8 W3 sliders: speed 0.8–1.2 (default 1.0), warmth 0–1 (default 0.5), saved and restored.
  ok('W3 speed slider is 0.8–1.2 at 1.0', (await sliderRange('speed-slider')) === '80-120' && (await sliderNow('speed-slider')) === 100);
  ok('W3 expressiveness slider is 0–1 at 0.5', (await sliderRange('temperature-slider')) === '0-100' && (await sliderNow('temperature-slider')) === 50);
  await sliderKey('speed-slider', 'End'); await sleep(100);
  ok('W3 speed stops at 1.2', (await sliderNow('speed-slider')) === 120 && (await b.evaluate(`${testid('speed-value')}?.textContent`)) === '1.20×');
  await sliderKey('speed-slider', 'Home'); await sleep(100);
  ok('W3 speed stops at 0.8', (await sliderNow('speed-slider')) === 80);
  await sliderKey('speed-slider', 'ArrowRight', 6); await sliderKey('temperature-slider', 'ArrowRight', 4); await sleep(100);
  ok('W3 sliders move in steps', (await sliderNow('speed-slider')) === 110 && (await sliderNow('temperature-slider')) === 70);
  await b.shot(`${S}/shot-w3.png`, true);
  await b.goto(`${BASE}/onboarding/voice/`, 3000); await waitFor(`document.querySelectorAll('[data-testid="voice-card"]').length`, 15000);
  ok('W3 voice restored after reload', await b.evaluate(`document.querySelector('[data-testid="voice-card"] button[aria-pressed="true"]') !== null`));
  ok('W3 sliders restored after reload', (await sliderNow('speed-slider')) === 110 && (await sliderNow('temperature-slider')) === 70);
  await b.evaluate(`[...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Hear this voice'))?.click()`); await sleep(1500);
  ok('W3 sample plays', await b.evaluate(`[...document.querySelectorAll('button')].some(b => b.getAttribute('aria-label')?.startsWith('Hear this voice') && b.getAttribute('aria-pressed') === 'true')`));
  // "Save and exit" from W3 keeps the voice and lands on the dashboard; the step stays open.
  await click('[data-testid="save-exit"]'); ok('W3 Save and exit opens the dashboard', Boolean(await waitFor(`location.pathname === '/app/'`, 15000)), await path());
  await b.goto(`${BASE}/onboarding/voice/`, 3000); await waitFor(`document.querySelectorAll('[data-testid="voice-card"]').length`, 15000);
  ok('W3 reopens with the voice kept', await b.evaluate(`document.querySelector('[data-testid="voice-card"] button[aria-pressed="true"]') !== null`));
  // Knowledge is after payment (ADR 0024): W3 goes straight to the test call.
  await clickText('Continue'); const w5first = await waitFor(`location.pathname === '/onboarding/test/'`, 10000);
  ok('W3 → W5 (knowledge comes after payment)', Boolean(w5first), await path());

  // 9. Guards after W3: no skipping ahead; the dismissed dashboard opens with "Continue setup"; the live page waits for go-live
  await b.goto(`${BASE}/onboarding/phone/`, 2500);
  ok('cannot skip ahead to W6', (await path()) !== '/onboarding/phone/', await path());
  await b.goto(`${BASE}/app/`, 3000);
  ok('dashboard opens after Save and exit, with the set-up banner', (await path()) === '/app/' && Boolean(await waitFor(`document.body.innerText.includes('Continue setup')`, 10000)), await path());
  await b.goto(`${BASE}/onboarding/live/`, 3000);
  ok('live page refuses a workspace that is not live', (await path()) !== '/onboarding/live/', await path());
  await b.goto(`${BASE}/onboarding/knowledge/`, 3000);
  ok('knowledge page waits for go-live', (await path()) === '/onboarding/test/', await path());
  await b.goto(`${BASE}/onboarding/brief/`, 3000);
  ok('can revisit W2', (await path()) === '/onboarding/brief/', await path());
  ok('W2 revisit shows Regenerate', Boolean(await waitFor(`document.body.innerText.includes('Regenerate')`, 10000)));
  // The generated script is editable on W2 itself: the panel's button opens the D3 editor under the brief.
  await b.evaluate(`document.querySelector('[data-testid="edit-script"]')?.click()`);
  const scriptShown = await waitFor(`(() => { const ta = document.querySelector('#prompt-body'); return ta && ta.offsetParent !== null && ta.value.length > 50; })()`, 10000);
  ok('W2 "Edit the script" opens the script editor with the generated prompt', Boolean(scriptShown));

  // 10. Back to W5 (knowledge is not a pre-payment step any more)
  await b.goto(`${BASE}/onboarding/test/`, 3000);
  ok('wizard header shows the balance', /\d+ credits/.test(await bodyText()));

  // 11. W5 — a real browser test call; Chrome's fake microphone answers the permission prompt
  await waitFor(`document.body.innerText.includes('Talk to your agent')`, 10000);
  await clickText('Start test call');
  const onCall = await waitFor(`document.body.innerText.includes('Hang up')`, 30000, 500);
  ok('W5 test call connects (mic + minted token)', Boolean(onCall), onCall ? '' : (await bodyText()).slice(0, 300));
  const agentLine = await waitFor(`[...document.querySelectorAll('[aria-label="Live transcript"] li')].some(li => li.textContent.startsWith('Agent'))`, 30000, 500);
  ok('W5 live transcript shows the agent speaking', Boolean(agentLine));
  const timer = `document.querySelector('dl dd')?.textContent`;
  const t1 = await b.evaluate(timer); await sleep(3000); const t2 = await b.evaluate(timer);
  ok('W5 timer runs', Boolean(t1) && t1 !== t2, `${t1} → ${t2}`);
  ok('W5 credits used shown during the call', (await bodyText()).includes('≈'));
  await sleep(4000);
  await b.shot(`${S}/shot-w5-call.png`, true);
  await clickText('Hang up');
  ok('W5 call ends cleanly', Boolean(await waitFor(`document.body.innerText.includes('Call ended')`, 15000)));
  ok('W5 after-call card appears', Boolean(await waitFor(`document.body.innerText.includes('After the call')`, 10000)));
  ok('W5 after-call shows the charge from call_ended', Boolean(await waitFor(`/Credits charged\\s*\\d/.test(document.body.innerText)`, 90000, 1000)));
  ok('W5 after-call summary from call_analyzed', Boolean(await waitFor(`document.body.innerText.includes('Summary')`, 120000, 1000)));
  await b.shot(`${S}/shot-w5-after.png`, true);

  // 12. W5 Improve — plain-language feedback → a new draft version
  const versionBefore = Number((await bodyText()).match(/draft version (\d+)/)?.[1] ?? 0);
  await setInput('#w5-feedback', "Always ask for the caller's phone number before you end the call.");
  await clickText('Update my agent');
  ok('W5 feedback shows progress', Boolean(await waitFor(`document.body.innerText.includes('Updating your agent')`, 5000, 100)));
  const improved = await waitFor(`/Version \\d+ is ready/.test(document.body.innerText) || document.body.innerText.includes('Nothing changed')`, 120000, 1000);
  ok('W5 feedback completes', Boolean(improved));
  const versionAfter = Number((await bodyText()).match(/draft version (\d+)/)?.[1] ?? 0);
  ok('W5 the new draft version is shown', versionAfter > versionBefore, `v${versionBefore} → v${versionAfter}`);
  await b.shot(`${S}/shot-w5-improved.png`, true);
  // Spec W5 soft gate (QA-082): Continue waits for "I'm happy with how my agent sounds".
  const gated = await b.evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Continue'))?.disabled === true`);
  ok('W5 Continue waits for the happiness checkbox', gated === true);
  await b.evaluate(`document.querySelector('#w5-happy')?.click()`); await sleep(200);
  await clickText('Continue'); const w6 = await waitFor(`location.pathname === '/onboarding/phone/'`, 10000);
  ok('→ W6', Boolean(w6), await path());

  // 13. W6 — options A/B/C, the forwarding guide, transfer targets, persistence
  await waitFor(`document.querySelectorAll('[role="radio"]').length >= 3`, 10000);
  ok('W6 offers options A, B and C', await b.evaluate(`['new','forward','sip'].every(v => document.querySelector('[role="radio"][value="' + v + '"]'))`));
  ok('W6 option C is locked on a trial plan', await b.evaluate(`document.querySelector('[role="radio"][value="sip"]').disabled === true`));
  await b.evaluate(`document.querySelector('[role="radio"][value="forward"]').click()`);
  ok('W6 option B shows the carrier forwarding guide', Boolean(await waitFor(`document.body.innerText.includes('To turn forwarding on') && document.body.innerText.includes('*72')`, 10000)));
  await b.shot(`${S}/shot-w6-forward.png`, true);
  await b.evaluate(`document.querySelector('[role="radio"][value="new"]').click()`); await sleep(300);
  await clickText('Add a person'); await sleep(200);
  await setInput('[id^="tt-label-"]', 'Front desk'); await setInput('[id^="tt-number-"]', '12');
  await clickText('Continue'); await sleep(500);
  ok('W6 validates a transfer target', (await bodyText()).includes('Enter the number with its country code') && (await path()) === '/onboarding/phone/');
  await setInput('[id^="tt-number-"]', '+1 (416) 555-0199');
  await clickText('Continue'); const w7 = await waitFor(`location.pathname === '/onboarding/activate/'`, 10000);
  ok('W6 saves the plan → W7', Boolean(w7), await path());
  await b.goto(`${BASE}/onboarding/phone/`, 3000); await waitFor(`document.querySelector('[id^="tt-label-"]')`, 10000);
  ok('W6 plan and transfer target persist', await b.evaluate(`document.querySelector('[id^="tt-label-"]')?.value === 'Front desk' && document.querySelector('[id^="tt-number-"]')?.value === '+14165550199' && document.querySelector('[role="radio"][value="new"]')?.getAttribute('aria-checked') === 'true'`));

  // 14. W7 — packs from /pricing, Checkout created by the API, redirect to Stripe, cancel return
  await b.goto(`${BASE}/onboarding/activate/`, 3000);
  const packs = await waitFor(`document.querySelectorAll('[role="radio"]').length`, 10000);
  ok('W7 lists the packs from /pricing', Number(packs) >= 1 && /\$\d/.test(await bodyText()), `packs=${packs}`);
  await b.shot(`${S}/shot-w7.png`, true);
  await clickText('Pay ');
  const stripe = await waitFor(`location.host === 'checkout.stripe.com'`, 20000, 500);
  ok('W7 redirects to Stripe Checkout', Boolean(stripe), await b.url());
  await sleep(2000); await b.shot(`${S}/shot-w7-stripe.png`);
  await b.goto(`${BASE}/onboarding/activate/?checkout=cancelled`, 3500);
  ok('W7 cancelled return explains nothing was charged', Boolean(await waitFor(`document.body.innerText.includes('Checkout cancelled')`, 10000)));
  await b.goto(`${BASE}/onboarding/activate/?session_id=cs_test_unpaid`, 3500);
  ok('W7 return without a paid purchase waits for the backend (no fake success)', Boolean(await waitFor(`document.body.innerText.includes('Confirming your payment')`, 10000)) && !(await bodyText()).includes('is live'));
  await b.shot(`${S}/shot-w7-confirming.png`);

  // 11. Switcher + second workspace + sign out
  await b.goto(`${BASE}/setup/workspace/`, 2500); await setInput('#name', 'Second Shop'); await clickText('Create workspace'); await waitFor(`location.pathname === '/onboarding/template/'`, 10000);
  await b.goto(`${BASE}/app/`, 3000);
  ok('new workspace starts onboarding (redirected from /app)', (await path()) === '/onboarding/template/', await path());
  await b.evaluate(`localStorage.removeItem('portal:workspace')`); await b.goto(`${BASE}/`, 3000);
  ok('two workspaces, none chosen → switcher page', (await path()) === '/select-workspace/', await path());
  await b.shot(`${S}/shot-a7.png`);
  // The first workspace was dismissed on W1 ("Save and exit"), so it opens on the dashboard with the resume band (ADR 0039).
  await clickText('Bright Smile Dental'); await waitFor(`location.pathname === '/app/'`, 10000);
  ok('switcher selects the dismissed workspace → dashboard with Continue setup', (await path()) === '/app/' && Boolean(await waitFor(`document.body.innerText.includes('Continue setup')`, 10000)), await path());
  await b.goto(`${BASE}/mfa/`, 2500);
  ok('A5 page shows MFA status', (await bodyText()).includes('Two-factor'));
  await b.goto(`${BASE}/forgot-password/`, 2000); await setInput('#email', 'd8-owner@example.test'); await clickText('Send reset link'); await sleep(1500);
  ok('A6 forgot password sends and confirms', (await bodyText()).includes('Check your inbox'));
} catch (e) { ok('script error', false, String(e)); }
console.log('--- console errors ---'); console.log(b.logs.filter(l => !l.includes('favicon')).slice(0, 15).join('\n') || '(none)');
writeFileSync(`${S}/e2e-results.txt`, results.join('\n'));
b.close(); process.exit(results.some(r => r.startsWith('FAIL')) ? 1 : 0);
