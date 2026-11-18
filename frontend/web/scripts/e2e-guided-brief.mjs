/**
 * W2 "Speak or type" (ADR 0047) in a real browser: the chooser, the Type path, the Speak
 * path, both landing in the same W2 form, the autosave, Undo, a real Generate, the
 * Firefox fallback, and the three locales at desktop and phone width.
 *
 * The browser's speech recogniser is replaced by a stand-in the script drives, so every
 * recording state (listening, interim words, denied, no microphone, no speech, network)
 * is reached on demand; the page code is the shipped one. Firefox is simulated in Chrome:
 * its user agent and no recogniser on `window`.
 *
 * Needs the same stack as `e2e:wizard` (portal export, API + worker, local issuer). With
 * the API on `GENERATION_PROVIDER=scripted`, set GUIDED_SCRIPTED=1 to assert the exact
 * fields the answers become; without it the fields are checked for presence only.
 */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const S = fileURLToPath(new URL('../.e2e', import.meta.url)); mkdirSync(S, { recursive: true });
const BASE = (process.env.PORTAL_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const SCRIPTED = process.env.GUIDED_SCRIPTED === '1';
if (process.env.E2E_USER_FILE) { const id = Date.now().toString(36); writeFileSync(process.env.E2E_USER_FILE, JSON.stringify({ sub: `auth0|e2e-${id}`, email: `e2e-${id}@example.test`, name: 'E2E Owner', email_verified: true })); }

const b = await launch({ port: 9333, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); console.log(results.at(-1)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 15000, every = 200) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await b.evaluate(expr).catch(() => null); if (v) return v; await sleep(every); } return null; }
const path = async () => new URL(await b.url()).pathname;
const tid = (id) => `document.querySelector('[data-testid="${id}"]')`;
const click = (id) => b.evaluate(`(() => { const el = ${tid(id)}; if (!el || el.disabled) return 'missing'; el.click(); return 'ok'; })()`);
const clickText = (text, tag = 'button') => b.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(tag)})].find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
const setInput = (selector, value) => b.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing'; const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
const val = (selector) => b.evaluate(`document.querySelector(${JSON.stringify(selector)})?.value ?? null`);
const text = (id) => b.evaluate(`${tid(id)}?.innerText ?? null`);
const phase = () => b.evaluate(`${tid('guided-brief')}?.dataset.phase ?? null`);
const answer = (value) => setInput('[data-testid="guided-answer"]', value);
const next = async () => { await click('guided-next'); await sleep(150); };
const question = () => text('guided-question');
const openW2 = async () => { await b.goto(`${BASE}/onboarding/brief/`, 2500); await waitFor(`Boolean(document.querySelector('#about_business') && ${tid('guided-brief')})`, 15000); };

// The stand-in recogniser. `window.__speech.outcome` decides what the next start() does.
const FAKE_SPEECH = `(() => {
  const state = { made: [], outcome: 'listen' };
  class FakeRecognition {
    constructor() { state.made.push(this); this.log = []; }
    start() { this.log.push('start'); const o = state.outcome; setTimeout(() => {
      if (o === 'listen') return this.onstart && this.onstart();
      this.onerror && this.onerror({ error: o }); this.onend && this.onend();
    }, 40); }
    stop() { this.log.push('stop'); setTimeout(() => this.onend && this.onend(), 40); }
    abort() { this.log.push('abort'); }
  }
  window.__speech = state;
  window.__say = (transcript, isFinal = true) => { const r = state.made.at(-1); r.onresult && r.onresult({ resultIndex: 0, results: [{ isFinal, 0: { transcript } }] }); };
  window.SpeechRecognition = FakeRecognition; window.webkitSpeechRecognition = FakeRecognition;
})();`;
const NO_SPEECH_API = `(() => { try { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; } catch {} Object.defineProperty(window, 'SpeechRecognition', { value: undefined, configurable: true }); Object.defineProperty(window, 'webkitSpeechRecognition', { value: undefined, configurable: true }); })();`;
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0';
const speechLog = () => b.evaluate(`(window.__speech?.made ?? []).map(r => r.log.join('>')).join(' | ')`);
const speechStatus = () => b.evaluate(`${tid('guided-speech-status')}?.dataset.status ?? null`);
const say = (words, final = true) => b.evaluate(`window.__say(${JSON.stringify(words)}, ${final})`);

const ANSWERS = {
  business: 'We are Bright Smile Dental, a family dental practice in Toronto with three dentists. We are located at 12 King Street West, Toronto.',
  role: 'Book check-ups and cleanings, and take a message when someone needs the dentist. Call it Maya.',
  hours: 'Open every day 8:30am to 6pm',
  services: 'check-ups, cleanings and whitening',
  restrictions: 'Never quote a price that is not on the list.',
  handoff: 'An emergency: transfer to 416 555 0134',
  extra: 'Parking is behind the building. Do you take walk-ins? Yes, before noon.',
};
const EXTRA_NOTE = 'Parking is behind the building.';
const ORDER = ['business', 'role', 'hours', 'services', 'pricing', 'restrictions', 'handoff', 'extra'];

try {
  const fake = await b.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_SPEECH });

  // Sign up, workspace, W1: the shortest way to a W2 with a fresh agent.
  await b.goto(`${BASE}/signup/`, 2500); await clickText('Create account'); await sleep(4000);
  if ((await path()).startsWith('/terms/')) { await b.evaluate(`document.querySelector('#terms-agree')?.click(); 'ok'`); await sleep(300); await clickText('Continue'); await waitFor(`!location.pathname.startsWith('/terms')`, 10000); await sleep(1500); }
  await setInput('#name', 'Bright Smile Dental'); await setInput('#phone', '+14165550123');
  await clickText('Create workspace'); await waitFor(`location.pathname === '/onboarding/template/'`, 15000);
  await waitFor(`document.querySelectorAll('[aria-pressed]').length`, 10000);
  await b.evaluate(`[...document.querySelectorAll('[aria-pressed]')].find(e => ((e.getAttribute('aria-label') ?? '') + e.textContent).includes('AI Receptionist')).click()`); await sleep(300);
  await clickText('Continue'); ok('reached W2 with a new agent', Boolean(await waitFor(`location.pathname === '/onboarding/brief/' && Boolean(document.querySelector('#about_business'))`, 30000)), await path());

  // 1. The chooser.
  await waitFor(`Boolean(${tid('guided-brief')})`, 10000);
  ok('chooser sits at the top of W2, above the form', await b.evaluate(`${tid('guided-brief')}.compareDocumentPosition(document.querySelector('#about_business')) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false`));
  ok('chooser offers Speak and Type', await b.evaluate(`${tid('guided-speak')}?.innerText.trim() === 'Speak my answers' && ${tid('guided-type')}?.innerText.trim() === 'Type my answers'`));
  ok('chooser says when the microphone is asked for', /asks to use your microphone when you start speaking/.test(await text('guided-note') ?? ''));
  ok('no microphone or recogniser is touched before the customer starts', (await b.evaluate(`window.__speech.made.length`)) === 0);
  await b.shot(`${S}/guided-01-chooser.png`);

  // 2. Type: one question at a time, back and forth without losing answers, skipping allowed.
  await click('guided-type'); await sleep(200);
  ok('Type opens question 1 of 8', (await text('guided-progress')) === 'Question 1 of 8' && /What is your business called/.test(await question() ?? ''), await text('guided-progress'));
  ok('the answer box takes the focus and is named by the question', await b.evaluate(`document.activeElement === ${tid('guided-answer')} && ${tid('guided-answer')}.getAttribute('aria-labelledby').includes('guided-question')`));
  ok('an empty answer can be skipped', (await text('guided-next'))?.trim() === 'Skip this question');
  await answer(ANSWERS.business);
  ok('a typed answer turns Skip into Next', (await text('guided-next'))?.trim() === 'Next');
  await next(); ok('Next moves to question 2', (await text('guided-progress')) === 'Question 2 of 8' && /What should your agent do on a call/.test(await question() ?? ''));
  await answer(ANSWERS.role);
  await click('guided-back'); await sleep(150);
  ok('Back shows question 1 with its answer intact', (await text('guided-progress')) === 'Question 1 of 8' && (await val('[data-testid="guided-answer"]')) === ANSWERS.business);
  await next(); ok('forward again, question 2 kept its answer', (await val('[data-testid="guided-answer"]')) === ANSWERS.role);
  const seen = [];
  for (let i = 1; i < ORDER.length; i += 1) {
    seen.push(await question());
    const value = ANSWERS[ORDER[i]];
    if (value) await answer(value);
    await next();
  }
  ok('asked the eight topics in order, one at a time', seen.length === 7 && /agent do/.test(seen[0]) && /When are you open/.test(seen[1]) && /What do you offer/.test(seen[2]) && /prices/.test(seen[3]) && /never say, promise or do/.test(seen[4]) && /pass a caller to a person/.test(seen[5]) && /anything else/.test(seen[6]), JSON.stringify(seen));
  ok('after question 8 comes the review', (await phase()) === 'review');
  const rows = await b.evaluate(`[...${tid('guided-review')}.querySelectorAll('li')].map(li => li.innerText.replace(/\\n+/g, ' | '))`);
  ok('review lists all eight questions, the skipped one marked', rows.length === 8 && /Prices \| Skipped/.test(rows[4]) && rows[0].includes('Bright Smile Dental'), JSON.stringify(rows[4]));
  await b.shot(`${S}/guided-02-review.png`);
  await b.evaluate(`${tid('guided-review')}.querySelectorAll('li button')[3].click()`); await sleep(200);
  ok('Edit opens that question with its answer', /What do you offer/.test(await question() ?? '') && (await val('[data-testid="guided-answer"]')) === ANSWERS.services);
  await answer('check-ups, cleanings, fillings and whitening'); await next();
  ok('an edited answer returns to the review, changed', (await phase()) === 'review' && (await b.evaluate(`${tid('guided-review')}.querySelectorAll('li')[3].innerText`)).includes('fillings'));

  // Answers survive a reload.
  await openW2();
  ok('answers in progress survive a reload', /Your earlier answers are saved/.test(await text('guided-brief') ?? ''));
  await click('guided-type'); await sleep(200);
  ok('resuming opens the first unanswered question', (await text('guided-progress')) === 'Question 5 of 8', await text('guided-progress'));
  for (let i = 4; i < ORDER.length; i += 1) await next();

  // 3. A failed request keeps the answers and offers a retry.
  await b.send('Network.setBlockedURLs', { urls: ['*/brief/from-answers*'] });
  await click('guided-submit');
  ok('a failed request is explained and the answers stay', Boolean(await waitFor(`Boolean(${tid('guided-error')})`, 10000)) && (await phase()) === 'review' && (await text('guided-submit'))?.trim() === 'Try again', `${await phase()} / ${await text('guided-submit')} / ${await text('guided-error')}`);
  await b.send('Network.setBlockedURLs', { urls: [] });

  // 4. Both the form and the autosave take the result.
  const before = { presets: await b.evaluate(`${tid('never-do-no_time_promises')}?.getAttribute('aria-checked')`), rule0: await val('#rule-c-0') };
  await click('guided-submit');
  ok('the answers fill the W2 form', Boolean(await waitFor(`${tid('guided-brief')}?.dataset.phase === 'done'`, 60000)));
  const filled = { address: await val('#address'), agent: await val('#agent_name'), faqQ: await val('#faq-q-0'), faqA: await val('#faq-a-0'), stillEmpty: await text('guided-still-empty'), about: await val('#about_business'), goal: await val('#goal'), never: await val('#never_do'), extra: await val('#anything_else'), rule1: await val('#rule-c-1'), number1: await val('#rule-n-1'), times: await b.evaluate(`[...document.querySelectorAll('input[type="time"]')].map(i => i.value).join(',')`), open: await b.evaluate(`[...document.querySelectorAll('[role="switch"]')].slice(0, 7).map(s => s.getAttribute('aria-checked')).join(',')`), body: await b.evaluate(`document.querySelector('form').innerText`) };
  if (SCRIPTED) {
    ok('typed answers land in their own fields', filled.about === ANSWERS.business && filled.goal === ANSWERS.role && filled.never === ANSWERS.restrictions && filled.extra === EXTRA_NOTE, JSON.stringify(filled).slice(0, 300));
    ok('hours become the weekly schedule', filled.open === 'true,true,true,true,true,true,true' && filled.times.startsWith('08:30,18:00'), `${filled.open} ${filled.times}`);
    ok('services become chips', ['check-ups', 'cleanings', 'fillings', 'whitening'].every((s) => filled.body.includes(s)));
    ok('a hand-off with a spoken-style number becomes a transfer rule in E.164', filled.rule1 === ANSWERS.handoff && filled.number1 === '+14165550134', `${filled.rule1} ${filled.number1}`);
  } else {
    ok('answers land in the W2 fields', filled.about.length > 20 && filled.goal.length > 20 && filled.extra.length > 5 && /true/.test(filled.open), JSON.stringify(filled).slice(0, 300));
    ok('a hand-off number is stored in E.164', /^\+1416555013\d$/.test(filled.number1 ?? ''), String(filled.number1));
  }
  if (SCRIPTED) {
    ok('the address said in the business answer fills Address', filled.address === '12 King Street West, Toronto', String(filled.address));
    ok('the name said in the role answer fills Agent name', filled.agent === 'Maya', String(filled.agent));
    ok('a question and its answer become an FAQ', filled.faqQ === 'Do you take walk-ins?' && filled.faqA === 'Yes, before noon.', `${filled.faqQ} / ${filled.faqA}`);
  } else {
    ok('address, agent name and an FAQ are filled from the answers', /King/.test(filled.address ?? '') && /Maya/.test(filled.agent ?? '') && /walk-ins/i.test(filled.faqQ ?? '') && /noon/i.test(filled.faqA ?? ''), JSON.stringify([filled.address, filled.agent, filled.faqQ, filled.faqA]));
  }
  ok('the result names the fields still empty: the skipped prices, not the filled ones', /^Still empty: /.test(filled.stillEmpty ?? '') && /Pricing/.test(filled.stillEmpty ?? '') && !/Address|Agent name|Frequently asked|About your business/.test(filled.stillEmpty ?? ''), String(filled.stillEmpty));
  ok('fields no question asked about are untouched', (await b.evaluate(`${tid('never-do-no_time_promises')}?.getAttribute('aria-checked')`)) === before.presets && (await val('#rule-c-0')) === before.rule0, JSON.stringify(before));
  ok('the result names the fields that changed and nothing is generated', /We updated: .*About your business/.test(await text('guided-brief') ?? '') && !(await b.evaluate(`document.body.innerText.includes('Writing your agent')`)));
  ok('the result takes the focus', await b.evaluate(`document.activeElement?.id === 'guided-title'`));
  await b.shot(`${S}/guided-03-filled.png`, true);
  ok('the existing autosave stores it', Boolean(await waitFor(`document.body.innerText.includes('Saved')`, 10000)));
  await setInput('#goal', `${filled.goal} Offer the next free slot first.`); await sleep(2600);
  await openW2();
  ok('the filled brief, and a hand edit to it, are there after a reload', (await val('#about_business')) === filled.about && (await val('#goal')).endsWith('Offer the next free slot first.') && (await val('#rule-n-1')) === filled.number1);

  // 5. Undo puts the form back.
  const goalBefore = await val('#goal');
  await click('guided-type'); await sleep(200);
  for (let i = 0; i < ORDER.length; i += 1) { if (ORDER[i] === 'role') await answer('Only take messages.'); else await answer(''); await next(); }
  await click('guided-submit'); await waitFor(`${tid('guided-brief')}?.dataset.phase === 'done'`, 60000);
  const goalAfter = await val('#goal');
  await click('guided-undo'); await sleep(400);
  ok('Undo restores what the form held', goalAfter !== goalBefore && (await val('#goal')) === goalBefore && (await phase()) === 'closed', `${goalAfter} → ${await val('#goal')}`);
  await sleep(2600);

  // 6. Speak: the same questions, the recogniser only on Start, every state shown.
  await openW2(); await click('guided-speak'); await sleep(200);
  ok('Speak opens the same questions', (await b.evaluate(`${tid('guided-brief')}?.dataset.mode`)) === 'speak' && /Question \d of 8/.test(await text('guided-progress') ?? ''), await text('guided-progress'));
  ok('choosing Speak does not open the microphone', (await b.evaluate(`window.__speech.made.length`)) === 0 && (await speechStatus()) === 'idle');
  for (let i = 0; i < 4; i += 1) { if ((await text('guided-progress')) === 'Question 5 of 8') break; await next(); }
  ok('Speak is on the prices question (skipped before)', (await text('guided-progress')) === 'Question 5 of 8' && /prices/.test(await question() ?? ''), await text('guided-progress'));
  await click('guided-mic-start');
  ok('Start asks the browser and shows listening', Boolean(await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'listening'`, 5000)) && /Listening/.test(await text('guided-speech-status') ?? ''));
  ok('the question stays on screen while recording', /prices/.test(await question() ?? ''));
  ok('Next and Back wait while the microphone is on', await b.evaluate(`${tid('guided-next')}.disabled && ${tid('guided-back')}.disabled && ${tid('guided-answer')}.readOnly`));
  await say('a cleaning is', false); await sleep(150);
  ok('words in flight are shown as they are recognised', (await text('guided-interim')) === 'a cleaning is');
  await say('a cleaning is one hundred and fifty dollars'); await sleep(150);
  ok('a recognised phrase becomes text in the answer', (await val('[data-testid="guided-answer"]')) === 'A cleaning is one hundred and fifty dollars');
  await b.shot(`${S}/guided-04-listening.png`);
  await click('guided-mic-stop');
  ok('Stop ends the recording and releases the microphone', Boolean(await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'idle'`, 5000)) && (await speechLog()).endsWith('start>stop'), await speechLog());
  await answer('A cleaning is $150.');
  ok('recognised text can be corrected by hand', (await val('[data-testid="guided-answer"]')) === 'A cleaning is $150.' && (await text('guided-next'))?.trim() === 'Next');
  await click('guided-mic-start'); await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'listening'`, 5000);
  await say('whitening is three hundred'); await sleep(150); await click('guided-mic-stop'); await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'idle'`, 5000);
  ok('speaking again adds to the corrected text', (await val('[data-testid="guided-answer"]')) === 'A cleaning is $150. Whitening is three hundred');
  await click('guided-mic-again'); await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'listening'`, 5000);
  ok('Record again listens and keeps the answer until something is heard', (await val('[data-testid="guided-answer"]')) === 'A cleaning is $150. Whitening is three hundred');
  await say('cleanings are 150 dollars and whitening is 300'); await sleep(150);
  ok('the first phrase heard replaces the answer', (await val('[data-testid="guided-answer"]')) === 'Cleanings are 150 dollars and whitening is 300');

  // Leaving while recording never leaves the microphone on.
  await click('guided-mode-type'); await sleep(200);
  ok('switching to Type stops the microphone and keeps the words', (await speechLog()).endsWith('start>abort') && (await val('[data-testid="guided-answer"]')) === 'Cleanings are 150 dollars and whitening is 300' && (await b.evaluate(`${tid('guided-brief')}?.dataset.mode`)) === 'type', await speechLog());
  await click('guided-mode-speak'); await sleep(200); await click('guided-mic-start'); await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'listening'`, 5000);
  await b.evaluate(`document.querySelector('[aria-label="Close the questions"]').click()`); await sleep(200);
  ok('closing the questions stops the microphone', (await speechLog()).endsWith('start>abort') && (await phase()) === 'closed', await speechLog());
  await click('guided-speak'); await sleep(200); await click('guided-mic-start'); await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'listening'`, 5000);
  await b.evaluate(`document.querySelector('[data-testid="wizard-back"]').click()`); await waitFor(`location.pathname === '/onboarding/template/'`, 10000);
  ok('leaving the page stops the microphone', (await speechLog()).endsWith('start>abort'), await speechLog());

  // 7. Recording errors.
  await openW2(); await click('guided-speak'); await sleep(200);
  const fail = async (outcome) => { await b.evaluate(`window.__speech.outcome = ${JSON.stringify(outcome)}`); await click('guided-mic-start'); await sleep(400); };
  await fail('not-allowed');
  ok('a denied microphone shows the steps for this browser and a way to type', Boolean(await waitFor(`Boolean(${tid('mic-help')})`, 5000)) && /Microphone blocked/.test(await text('guided-brief') ?? '') && /Type this answer/.test(await text('guided-brief') ?? '') && (await speechStatus()) === 'idle', `${await speechStatus()} / ${(await text('guided-brief') ?? '').slice(0, 400)}`);
  await b.shot(`${S}/guided-05-denied.png`);
  for (const [outcome, failure, title] of [['audio-capture', 'no_microphone', 'No microphone found'], ['no-speech', 'no_speech', 'We did not hear anything'], ['network', 'network', 'could not be turned into text'], ['service-not-allowed', 'unavailable', 'not available in this browser']]) {
    await fail(outcome);
    ok(`"${outcome}" is explained (${failure})`, (await b.evaluate(`${tid('guided-speech-error')}?.dataset.failure`)) === failure && (await text('guided-speech-error')).includes(title) && (await speechStatus()) === 'idle', await text('guided-speech-error'));
  }
  await b.evaluate(`window.__speech.outcome = 'listen'`);
  await click('guided-mic-start');
  ok('a new try clears the error and listens', Boolean(await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'listening'`, 5000)) && !(await b.evaluate(`Boolean(${tid('guided-speech-error')})`)));
  await click('guided-mic-stop'); await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'idle'`, 5000);
  await clickText('Type this answer'); await sleep(100);

  // 8. Spoken answers reach the same review and the same form.
  await b.evaluate(`document.querySelector('[aria-label="Close the questions"]')?.click()`); await sleep(200);
  await click('guided-speak'); await sleep(200);
  for (let i = 0; i < 8 && (await phase()) === 'asking'; i += 1) await next();
  ok('Speak ends at the same review as Type', (await phase()) === 'review' && (await b.evaluate(`${tid('guided-review')}.querySelectorAll('li').length`)) === 8 && (await b.evaluate(`${tid('guided-review')}.querySelectorAll('li')[4].innerText`)).includes('whitening is 300'));
  await click('guided-submit'); await waitFor(`${tid('guided-brief')}?.dataset.phase === 'done'`, 60000);
  const pricing = await val('#pricing');
  ok('a spoken answer fills its field in the same form', SCRIPTED ? pricing === 'Cleanings are 150 dollars and whitening is 300' : /150/.test(pricing ?? '') && /300/.test(pricing ?? ''), String(pricing));
  await waitFor(`document.body.innerText.includes('Saved')`, 10000); await sleep(500);

  // 9. Generate is the existing one, and only when the customer asks.
  ok('Generate is still the customer’s button', Boolean(await waitFor(`[...document.querySelectorAll('button')].some(x => x.textContent.includes('Generate my agent') && !x.disabled)`, 10000)));
  await clickText('Generate my agent');
  ok('Generate runs from the confirmed brief', Boolean(await waitFor(`document.body.innerText.includes('Writing your agent')`, 15000)));
  ok('the questions are locked while a script is written', await b.evaluate(`${tid('guided-undo')}?.disabled === true || ${tid('guided-type')}?.disabled === true`));
  ok('generation completes', Boolean(await waitFor(`document.body.innerText.includes('Your agent is ready')`, 150000, 1000)));
  ok('Continue opens once the script exists', Boolean(await waitFor(`Boolean(${tid('wizard-continue')}) && !${tid('wizard-continue')}.disabled`, 20000)));

  // 10. Firefox: Type only, no Speak control anywhere.
  await b.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: fake.identifier });
  const none = await b.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_SPEECH_API });
  await b.send('Emulation.setUserAgentOverride', { userAgent: FIREFOX_UA });
  await openW2();
  ok('Firefox: no Speak button, Type is the one action', await b.evaluate(`!${tid('guided-speak')} && ${tid('guided-type')}?.innerText.trim() === 'Type my answers' && navigator.userAgent.includes('Firefox')`));
  ok('Firefox: the note says where speaking works', /works in Chrome, Edge and Safari/.test(await text('guided-note') ?? ''));
  await click('guided-type'); await sleep(200);
  ok('Firefox: the questions open with no Speak switch and no microphone button', await b.evaluate(`${tid('guided-brief')}.dataset.mode === 'type' && !${tid('guided-mode-speak')} && !${tid('guided-mic-start')} && Boolean(${tid('guided-answer')})`));
  await b.shot(`${S}/guided-06-firefox.png`);
  // Firefox with the flagged constructor but no service behind it is still Type only.
  await b.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: none.identifier });
  const flagged = await b.send('Page.addScriptToEvaluateOnNewDocument', { source: FAKE_SPEECH });
  await openW2();
  ok('Firefox with a flagged recogniser is still Type only', await b.evaluate(`!${tid('guided-speak')} && typeof window.SpeechRecognition === 'function'`));
  await b.send('Emulation.setUserAgentOverride', { userAgent: '' });

  // 11. Locales: every phase, desktop and phone width.
  const LATIN_OK = /Chrome|Edge|Safari|Firefox|Bright Smile Dental|Toronto|[0-9]/g;
  for (const [locale, dir, expectTitle] of [['ar', 'rtl', 'هل تفضّل الإجابة عن بضعة أسئلة؟'], ['fr-CA', 'ltr', 'Vous préférez répondre à quelques questions?']]) {
    await b.evaluate(`localStorage.setItem('portal:locale', ${JSON.stringify(locale)})`);
    await b.evaluate(`sessionStorage.clear()`);
    await openW2();
    const html = await b.evaluate(`document.documentElement.lang + ' ' + document.documentElement.dir`);
    ok(`${locale}: page language and direction`, html === `${locale} ${dir}`, html);
    const texts = [await text('guided-brief')];
    ok(`${locale}: chooser is translated`, texts[0].includes(expectTitle), texts[0].slice(0, 80));
    await click('guided-speak'); await sleep(200); texts.push(await text('guided-brief'));
    await click('guided-mic-start'); await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'listening'`, 5000); texts.push(await text('guided-brief'));
    await b.shot(`${S}/guided-07-${locale}-speak.png`);
    await click('guided-mic-stop'); await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'idle'`, 5000);
    for (const outcome of ['not-allowed', 'audio-capture', 'no-speech', 'network', 'service-not-allowed']) { await b.evaluate(`window.__speech.outcome = ${JSON.stringify(outcome)}`); await click('guided-mic-start'); await sleep(350); texts.push(await text('guided-brief')); }
    await b.evaluate(`window.__speech.outcome = 'listen'`);
    await click('guided-mode-type'); await sleep(150); texts.push(await text('guided-brief'));
    const placeholder = await b.evaluate(`${tid('guided-answer')}.placeholder`);
    for (let i = 0; i < 8; i += 1) { texts.push(await text('guided-brief')); if (i === 0) await answer(locale === 'ar' ? 'نحن عيادة أسنان في الرياض ونخدم العائلات.' : 'Nous sommes une boulangerie artisanale à Laval.'); await next(); }
    texts.push(await text('guided-brief'));
    await b.shot(`${S}/guided-08-${locale}-review.png`);
    const leftover = [...new Set((texts.join('\n') + '\n' + placeholder).replace(LATIN_OK, '').match(locale === 'ar' ? /[A-Za-z]{2,}/g : /\b(the|your|and|answer|skip|next|back|speak|listening|check|what|when|again|stop)\b/gi) ?? [])];
    ok(`${locale}: no English left in any phase, error or placeholder`, leftover.length === 0, leftover.join(', '));
    ok(`${locale}: an answer in that language is kept as typed`, (await b.evaluate(`${tid('guided-review')}.querySelectorAll('li')[0].innerText`)).includes(locale === 'ar' ? 'عيادة أسنان' : 'boulangerie'));
    if (locale === 'ar') {
      const geometry = await b.evaluate(`(() => { const box = ${tid('guided-review')}.querySelector('li'); const label = box.querySelector('p').getBoundingClientRect(); const edit = box.querySelector('button').getBoundingClientRect(); return { labelRight: Math.round(label.right), editLeft: Math.round(edit.left), editRight: Math.round(edit.right) }; })()`);
      ok('ar: the review reads right to left (label at the right, Edit at the left)', geometry.editRight <= geometry.labelRight && geometry.editLeft < geometry.labelRight - 100, JSON.stringify(geometry));
      ok('ar: an Arabic answer in the box is right-aligned text', (await b.evaluate(`getComputedStyle(${tid('guided-review')}.querySelectorAll('li p')[1]).direction`)) === 'rtl');
    }
    await click('guided-submit'); await waitFor(`${tid('guided-brief')}?.dataset.phase === 'done' || Boolean(${tid('guided-empty')})`, 60000);
    const doneText = await text('guided-brief');
    ok(`${locale}: the result is translated`, doneText.includes(locale === 'ar' ? 'تم ملء الموجز' : 'Votre fiche est remplie') || doneText.includes(locale === 'ar' ? 'لا شيء يُضاف بعد' : 'Rien à ajouter'), doneText.slice(0, 120));
    // Phone width: nothing wider than the screen, in any phase.
    await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    const overflow = [];
    const measure = async (name) => { const w = await b.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`); if (w > 0) overflow.push(`${name}:${w}`); };
    await openW2(); await measure('closed'); await b.shot(`${S}/guided-09-${locale}-phone-chooser.png`);
    await click('guided-speak'); await sleep(250); await measure('speak'); await b.shot(`${S}/guided-10-${locale}-phone-speak.png`);
    const small = await b.evaluate(`[...${tid('guided-brief')}.querySelectorAll('button')].map(x => Math.round(Math.min(x.getBoundingClientRect().height, x.getBoundingClientRect().width))).filter(h => h < 44)`);
    for (let i = 0; i < 8; i += 1) await next();
    await measure('review'); await b.shot(`${S}/guided-11-${locale}-phone-review.png`);
    ok(`${locale}: no sideways scroll at 390 px in any phase`, overflow.length === 0, overflow.join(' '));
    ok(`${locale}: controls are finger-sized at 390 px`, small.length === 0, JSON.stringify(small));
    await b.send('Emulation.clearDeviceMetricsOverride');
  }
  await b.evaluate(`localStorage.setItem('portal:locale', 'en')`);

  // 12. English at phone width, light and dark.
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await b.evaluate(`sessionStorage.clear()`); await openW2();
  const enOverflow = await b.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`);
  await click('guided-speak'); await sleep(250); await b.shot(`${S}/guided-12-en-phone-speak.png`);
  ok('en: no sideways scroll at 390 px', enOverflow <= 0 && (await b.evaluate(`document.documentElement.scrollWidth - document.documentElement.clientWidth`)) <= 0);
  await b.send('Emulation.clearDeviceMetricsOverride');
  await b.evaluate(`localStorage.setItem('portal-theme', 'dark')`); await openW2(); await click('guided-speak'); await sleep(250);
  ok('dark theme: the panel is on a dark surface with light text', await b.evaluate(`(() => { const lum = (c) => { const [r, g, b] = c.match(/[\\d.]+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }; const el = ${tid('guided-brief')}; return document.documentElement.classList.contains('dark') && lum(getComputedStyle(${tid('guided-question')}).color) > 0.6; })()`));
  await b.shot(`${S}/guided-13-en-dark.png`);
  await b.evaluate(`localStorage.setItem('portal-theme', 'light')`);
  await b.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: flagged.identifier });

  // 13. Chrome's own recogniser, no stand-in. Headless Chrome with a fake microphone hears
  // a test tone, so the outcome is reported, not asserted: listening, or a handled error.
  if (process.env.GUIDED_NATIVE === '1') {
    await b.evaluate(`sessionStorage.clear()`); await openW2(); await click('guided-speak'); await sleep(250);
    const native = await b.evaluate(`typeof window.webkitSpeechRecognition === 'function' && !window.__speech`);
    await click('guided-mic-start');
    const reached = await waitFor(`['listening'].includes(${tid('guided-speech-status')}?.dataset.status) || Boolean(${tid('guided-speech-error')}) || Boolean(${tid('mic-help')})`, 12000);
    const state = await b.evaluate(`JSON.stringify({ status: ${tid('guided-speech-status')}?.dataset.status, failure: ${tid('guided-speech-error')}?.dataset.failure ?? (${tid('mic-help')} ? 'denied' : null) })`);
    console.log(`INFO native Chrome recogniser (${native ? 'present' : 'absent'}): ${state}`);
    ok('native recogniser: Start ends in listening or a handled error, never a dead control', Boolean(reached) && native, state);
    if ((await speechStatus()) !== 'idle') { await click('guided-mic-stop'); ok('native recogniser: Stop returns to idle', Boolean(await waitFor(`${tid('guided-speech-status')}?.dataset.status === 'idle'`, 8000))); }
  }
} catch (e) { ok('script error', false, String(e?.stack ?? e)); }
const errors = b.logs.filter((l) => !l.includes('favicon') && !l.includes('ERR_BLOCKED_BY_CLIENT') && !l.includes('brief/from-answers') && !l.includes("'beforeunload' confirmation"));
ok('no console errors on the way', errors.length === 0, errors.slice(0, 5).join(' ¦ '));
writeFileSync(`${S}/e2e-guided-results.txt`, results.join('\n'));
console.log(`${results.filter((r) => r.startsWith('PASS')).length} passed, ${results.filter((r) => r.startsWith('FAIL')).length} failed`);
b.close(); process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
