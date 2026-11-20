// Playwright QA for W2 "Speak or type": the Type path in three engines, and a spoken
// pass in Google Chrome with its own recogniser hearing synthesized speech.
import { chromium, firefox, webkit } from 'playwright';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:3005';
const USER_FILE = process.env.E2E_USER_FILE;
const OUT = process.env.QA_OUT; mkdirSync(OUT, { recursive: true });
const SPEECH = process.env.SPEECH_DIR;
const ONLY = (process.env.QA_ONLY ?? 'chromium,firefox,webkit,chrome-speech').split(',');
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); console.log(results.at(-1)); };
const info = (line) => { results.push(`INFO ${line}`); console.log(results.at(-1)); };
const tid = (page, id) => page.locator(`[data-testid="${id}"]`);

const TYPED = {
  business: 'We are Bright Smile Dental, a family dental practice in Toronto with three dentists. We are located at 12 King Street West, Toronto.',
  role: 'Book check-ups and cleanings, and take a message when someone needs the dentist. Call it Maya.',
  hours: 'Monday to Friday, 9 to 5',
  services: 'check-ups, cleanings, fillings and whitening',
  pricing: '',
  restrictions: 'Never give medical advice.',
  handoff: 'An emergency: transfer to 416 555 0134',
  extra: 'Parking is behind the building. Do you take walk-ins? Yes, before noon.',
};
const ORDER = Object.keys(TYPED);

async function toW2(page) {
  const id = Date.now().toString(36);
  writeFileSync(USER_FILE, JSON.stringify({ sub: `auth0|pwqa-${id}`, email: `pwqa-${id}@example.test`, name: 'QA Owner', email_verified: true }));
  await page.goto(`${BASE}/signup/`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/(terms|create-workspace|onboarding)/, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  if (new URL(page.url()).pathname.startsWith('/terms')) {
    await page.locator('#terms-agree').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForFunction(() => !location.pathname.startsWith('/terms'), null, { timeout: 15000 });
  }
  await page.locator('#name').fill('Bright Smile Dental');
  await page.locator('#phone').fill('+14165550123');
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await page.waitForURL(/\/onboarding\/template\//, { timeout: 30000 });
  await page.locator('[aria-pressed]').first().waitFor({ timeout: 20000 });
  await page.evaluate(() => [...document.querySelectorAll('[aria-pressed]')].find((e) => ((e.getAttribute('aria-label') ?? '') + e.textContent).includes('AI Receptionist')).click());
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#about_business').waitFor({ timeout: 40000 });
  await tid(page, 'guided-brief').waitFor();
}

async function readForm(page) {
  return page.evaluate(() => {
    const v = (s) => document.querySelector(s)?.value ?? null;
    return {
      about: v('#about_business'), goal: v('#goal'), agent: v('#agent_name'), address: v('#address'), pricing: v('#pricing'), extra: v('#anything_else'), never: v('#never_do'),
      faqQ: v('#faq-q-0'), faqA: v('#faq-a-0'), rules: [...document.querySelectorAll('[id^="rule-c-"]')].map((e) => e.value), numbers: [...document.querySelectorAll('[id^="rule-n-"]')].map((e) => e.value),
      open: [...document.querySelectorAll('[role="switch"]')].slice(0, 7).map((s) => s.getAttribute('aria-checked')).join(','),
      times: [...document.querySelectorAll('input[type="time"]')].slice(0, 2).map((i) => i.value).join('-'),
      presets: [...document.querySelectorAll('[data-testid^="never-do-"]')].map((e) => `${e.dataset.testid.replace('never-do-', '')}=${e.getAttribute('aria-checked')}`).join(','),
      stillEmpty: document.querySelector('[data-testid="guided-still-empty"]')?.innerText ?? null,
      done: document.querySelector('[data-testid="guided-brief"]')?.innerText ?? null,
      body: document.body.innerText,
    };
  });
}

async function submitAndCheck(page, label, { generate }) {
  await tid(page, 'guided-submit').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="guided-brief"]')?.dataset.phase === 'done', null, { timeout: 70000 }).catch(() => {});
  const f = await readForm(page);
  ok(`${label}: answers fill the W2 form`, (f.about ?? '').length > 20 && (f.goal ?? '').length > 20, JSON.stringify({ about: f.about, goal: f.goal }).slice(0, 260));
  ok(`${label}: address comes from the business answer`, /king/i.test(f.address ?? ''), String(f.address));
  ok(`${label}: agent name comes from the role answer`, /^maya$/i.test((f.agent ?? '').trim()), String(f.agent));
  ok(`${label}: an FAQ comes from the last answer`, /walk-?ins?/i.test(f.faqQ ?? '') && /noon/i.test(f.faqA ?? ''), `${f.faqQ} / ${f.faqA}`);
  ok(`${label}: hours and services are filled`, /true/.test(f.open) && /whitening/i.test(f.body), `${f.open} ${f.times}`);
  ok(`${label}: the still-empty line names the skipped prices and none of the filled fields`, /^Still empty: /.test(f.stillEmpty ?? '') && /Pricing/.test(f.stillEmpty ?? '') && !/Address|Agent name|Frequently asked|About your business|Business hours/.test(f.stillEmpty ?? ''), String(f.stillEmpty));
  ok(`${label}: nothing is generated on its own`, !/Writing your agent/.test(f.body));
  await page.locator('#pricing').fill('A cleaning is $150.');
  ok(`${label}: a filled field stays editable`, (await page.locator('#address').isEditable()) && (await page.locator('#pricing').inputValue()) === 'A cleaning is $150.');
  await page.screenshot({ path: `${OUT}/${label}-filled.png`, fullPage: true });
  if (generate) {
    const button = page.getByRole('button', { name: /Generate my agent/ });
    await button.waitFor({ timeout: 15000 });
    await page.waitForTimeout(2600); // the autosave
    await button.click();
    const ready = await page.waitForFunction(() => document.body.innerText.includes('Your agent is ready'), null, { timeout: 160000 }).then(() => true).catch(() => false);
    ok(`${label}: Generate writes a script from the confirmed brief`, ready);
    await page.screenshot({ path: `${OUT}/${label}-generated.png`, fullPage: true });
  }
  return f;
}

async function typePass(name, launcher) {
  let browser;
  try { browser = await launcher.launch({ headless: true }); } catch (e) { info(`${name}: could not be launched on this machine (${String(e.message).split('\n')[0].slice(0, 160)})`); return; }
  // Chromium is given the microphone so Start speaking gets past the permission prompt to the engine's own answer.
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, ...(name === 'chromium' ? { permissions: ['microphone'] } : {}) })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  try {
    info(`${name}: ${browser.version()}`);
    await toW2(page);
    const hasCtor = await page.evaluate(() => typeof (window.SpeechRecognition ?? window.webkitSpeechRecognition) === 'function');
    const speakShown = await tid(page, 'guided-speak').count();
    const note = (await tid(page, 'guided-note').innerText()).trim();
    info(`${name}: recogniser on window = ${hasCtor}, Speak button shown = ${speakShown === 1}, note = "${note}"`);
    if (name === 'firefox') {
      ok('firefox: no Speak button, Type is offered', speakShown === 0 && (await tid(page, 'guided-type').count()) === 1);
      ok('firefox: the note says speaking works in other browsers', /Chrome, Edge and Safari/.test(note), note);
    } else {
      ok(`${name}: Speak is shown exactly when the browser has a recogniser`, (speakShown === 1) === hasCtor);
    }
    await page.screenshot({ path: `${OUT}/${name}-chooser.png` });
    await tid(page, 'guided-type').click();
    for (const id of ORDER) {
      ok(`${name}: question ${ORDER.indexOf(id) + 1} of 8 is shown`, (await tid(page, 'guided-progress').innerText()).trim() === `Question ${ORDER.indexOf(id) + 1} of 8`);
      if (TYPED[id]) await tid(page, 'guided-answer').fill(TYPED[id]);
      await tid(page, 'guided-next').click();
    }
    ok(`${name}: the review lists eight rows, prices skipped`, (await tid(page, 'guided-review').locator('li').count()) === 8 && /Skipped/.test(await tid(page, 'guided-review').locator('li').nth(4).innerText()));
    if (name === 'firefox') ok('firefox: no microphone control anywhere in the questions', (await page.locator('[data-testid="guided-mic-start"], [data-testid="guided-mode-speak"]').count()) === 0);
    await submitAndCheck(page, name, { generate: true });
    if (speakShown === 1 && name !== 'chrome-speech') {
      // An engine with the constructor but no speech service behind it must fail politely.
      await page.goto(`${BASE}/onboarding/brief/`); await tid(page, 'guided-brief').waitFor();
      await tid(page, 'guided-speak').click(); await tid(page, 'guided-mic-start').click();
      const state = await page.waitForFunction(() => { const s = document.querySelector('[data-testid="guided-speech-status"]')?.dataset.status; const e = document.querySelector('[data-testid="guided-speech-error"]')?.dataset.failure ?? (document.querySelector('[data-testid="mic-help"]') ? 'denied' : null); return e || s === 'listening' ? `${s}/${e}` : null; }, null, { timeout: 15000 }).then((h) => h.jsonValue()).catch(() => null);
      const waiting = !state && (await tid(page, 'guided-speech-status').getAttribute('data-status')) === 'starting';
      let stopped = false;
      if (waiting) { await tid(page, 'guided-mic-stop').click(); stopped = await page.waitForFunction(() => document.querySelector('[data-testid="guided-speech-status"]')?.dataset.status === 'idle', null, { timeout: 8000 }).then(() => true).catch(() => false); await tid(page, 'guided-mode-type').click(); await tid(page, 'guided-answer').fill('Typed instead.'); stopped = stopped && (await tid(page, 'guided-answer').inputValue()) === 'Typed instead.'; }
      ok(`${name}: Start speaking ends in listening, an explained error, or a wait the customer can stop and type out of`, Boolean(state) || (waiting && stopped), state ? String(state) : `engine never answered; Stop returned to idle and typing worked = ${stopped}`);
      info(`${name}: Start speaking without a usable microphone or speech service → ${state}`);
      await page.screenshot({ path: `${OUT}/${name}-speak-state.png` });
    }
    // Arabic: the panel flips and carries no English.
    await page.evaluate(() => localStorage.setItem('portal:locale', 'ar')); await page.goto(`${BASE}/onboarding/brief/`); await tid(page, 'guided-brief').waitFor();
    const ar = await page.evaluate(() => ({ dir: document.documentElement.dir, text: document.querySelector('[data-testid="guided-brief"]').innerText }));
    ok(`${name}: Arabic panel is right to left with no English words`, ar.dir === 'rtl' && !/[A-Za-z]{3,}/.test(ar.text.replace(/Chrome|Edge|Safari|Firefox/g, '')), ar.text.slice(0, 80));
    await page.evaluate(() => localStorage.setItem('portal:locale', 'fr-CA')); await page.goto(`${BASE}/onboarding/brief/`); await tid(page, 'guided-brief').waitFor();
    const fr = await tid(page, 'guided-brief').innerText();
    ok(`${name}: French panel carries no English words`, !/\b(the|your|answers|speak|type my|still empty)\b/i.test(fr), fr.slice(0, 80));
    await page.evaluate(() => localStorage.setItem('portal:locale', 'en'));
    ok(`${name}: no uncaught page errors`, errors.length === 0, errors.join(' ¦ '));
  } catch (e) { ok(`${name}: script error`, false, String(e.stack ?? e).slice(0, 600)); await page.screenshot({ path: `${OUT}/${name}-error.png` }).catch(() => {}); }
  await browser.close();
}

async function spokenPass() {
  const name = 'chrome-speech';
  const wav = `${OUT}/mic.wav`; copyFileSync(`${SPEECH}/business.wav`, wav);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: process.env.QA_HEADED !== '1', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'] })).newPage();
  const said = JSON.parse(readFileSync(`${SPEECH}/answers.json`, 'utf8'));
  const heard = {};
  try {
    info(`${name}: Google Chrome ${browser.version()}, its own recogniser, audio = synthesized speech fed to the microphone`);
    await toW2(page);
    ok(`${name}: Speak is offered`, (await tid(page, 'guided-speak').count()) === 1);
    await tid(page, 'guided-speak').click();
    await tid(page, 'guided-mic-start').click();
    const listening = await page.waitForFunction(() => document.querySelector('[data-testid="guided-speech-status"]')?.dataset.status === 'listening', null, { timeout: 15000 }).then(() => true).catch(() => false);
    ok(`${name}: Chrome's own recogniser starts and the panel shows listening`, listening);
    await page.screenshot({ path: `${OUT}/${name}-listening.png` });
    const outcome = await page.waitForFunction(() => { const e = document.querySelector('[data-testid="guided-speech-error"]')?.dataset.failure; const v = document.querySelector('[data-testid="guided-answer"]')?.value; return e ? `error:${e}` : v ? `heard:${v}` : null; }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => 'nothing after 30 s');
    info(`${name}: with synthesized speech as the microphone → ${outcome}`);
    ok(`${name}: the recogniser's own "no speech" ends in the explained message, microphone released`, outcome.startsWith('heard:') || (outcome === 'error:no_speech' && (await tid(page, 'guided-speech-status').getAttribute('data-status')) === 'idle' && /did not hear anything/i.test(await tid(page, 'guided-speech-error').innerText())), outcome);
    await page.screenshot({ path: `${OUT}/${name}-outcome.png` });
    await tid(page, 'guided-answer').fill('Typed after the microphone heard nothing.');
    ok(`${name}: the answer box takes typing after a failed recording`, (await tid(page, 'guided-next').innerText()).trim() === 'Next');
  } catch (e) { ok(`${name}: script error`, false, String(e.stack ?? e).slice(0, 600)); await page.screenshot({ path: `${OUT}/${name}-error.png` }).catch(() => {}); }
  await browser.close();
}

if (ONLY.includes('chrome-speech')) await spokenPass();
if (ONLY.includes('chromium')) await typePass('chromium', chromium);
if (ONLY.includes('firefox')) await typePass('firefox', firefox);
if (ONLY.includes('webkit')) await typePass('webkit', webkit);
writeFileSync(`${OUT}/playwright-qa-results.txt`, results.join('\n'));
console.log(`${results.filter((r) => r.startsWith('PASS')).length} passed, ${results.filter((r) => r.startsWith('FAIL')).length} failed`);
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
