import { launch } from '../../../../frontend/web/scripts/cdp.mjs';
const OUT = new URL('.', import.meta.url).pathname;
const b = await launch({ args: ['--no-sandbox'] });
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (expr, ms = 20000) => { for (let i = 0; i < ms / 250; i++) { if (await b.evaluate(expr)) return true; await wait(250); } return false; };
try {
  await b.goto('http://localhost:3001/login/', 3000);
  await until(`!![...document.querySelectorAll('button')].find(x => !x.disabled && /sign in|continue|log in/i.test(x.textContent))`);
  console.log('login buttons:', await b.evaluate(`[...document.querySelectorAll('button')].map(x => x.textContent.trim() + (x.disabled ? ' (disabled)' : '')).join(' | ')`));
  await b.evaluate(`[...document.querySelectorAll('button')].find(x => !x.disabled && /sign in|continue|log in/i.test(x.textContent)).click()`);
  ok('signed in through the local staff issuer', await until(`location.host === 'localhost:3001' && !location.pathname.startsWith('/login') && !location.search.includes('code=')`, 30000), await b.url());
  await b.goto('http://localhost:3001/pricing/?tab=costs', 2000);
  ok('costs tab renders', await until(`document.body.innerText.includes('Voice platform cost inputs')`), await b.url());
  ok('seeded values shown', await until(`[...document.querySelectorAll('input')].some(i => i.value === 'gpt-4.1-mini') && [...document.querySelectorAll('input')].some(i => i.value === '5.5')`));
  const rows = await b.evaluate(`[...document.querySelectorAll('fieldset legend')].map(l => l.textContent)`);
  ok('four rate tables + monthly', rows.length === 5, JSON.stringify(rows));
  ok('every input has an accessible name', await b.evaluate(`[...document.querySelectorAll('input')].every(i => i.getAttribute('aria-label') || (i.id && document.querySelector('label[for="' + i.id + '"]')))`));
  ok('no em dash in the form copy', await b.evaluate(`!document.querySelector('main').innerText.includes('—')`));
  await b.shot(`${OUT}/costs-desktop.png`, true);

  // Add a row, leave the key empty with a value, save: validation names it, nothing saved.
  const before = await b.evaluate(`document.querySelectorAll('input[aria-label^="In-call model: Model id"]').length`);
  await b.evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Add model id').click()`);
  ok('Add row adds a row', await until(`document.querySelectorAll('input[aria-label^="In-call model: Model id"]').length === ${before + 1}`));
  // Remove it again
  await b.evaluate(`[...document.querySelectorAll('button[aria-label^="Remove row ${before + 1} from In-call model"]')][0].click()`);
  ok('Remove deletes the row', await until(`document.querySelectorAll('input[aria-label^="In-call model: Model id"]').length === ${before}`));
  // Duplicate key → refused client-side
  await b.evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Add country').click()`);
  await wait(300);
  const setVal = (sel, v) => b.evaluate(`(() => { const el = [...document.querySelectorAll('${sel}')].at(-1); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, '${v}'); el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await setVal('input[aria-label^="Telephony on a bought number: Country"]', 'US');
  await setVal('input[aria-label^="Telephony on a bought number: ¢ / min"]', '2');
  await b.evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Save cost inputs').click()`);
  ok('duplicate key refused with a message', await until(`document.body.innerText.includes('Each key can appear once.')`));
  // Fix: make it a new country, save for real
  const taken = await b.evaluate(`[...document.querySelectorAll('input[aria-label^="Telephony on a bought number: Country"]')].map(i => i.value)`);
  const fresh = ['GB', 'DE', 'FR', 'AU', 'NZ', 'IE'].find((c) => !taken.includes(c));
  await setVal('input[aria-label^="Telephony on a bought number: Country"]', fresh);
  await b.evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Save cost inputs').click()`);
  ok(`save succeeds (toast), new row ${fresh}`, await until(`document.body.innerText.includes('Cost inputs saved')`));
  // Clean up: remove every test country row and save again.
  await wait(1500);
  for (const c of ['GB', 'DE', 'FR', 'AU', 'NZ', 'IE']) {
    await b.evaluate(`(() => { const btn = document.querySelector('button[aria-label="Remove ${c} from Telephony on a bought number"]'); if (btn) btn.click(); })()`);
    await wait(150);
  }
  await b.evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Save cost inputs').click()`);
  await wait(2000);
  const left = await (await fetch('http://localhost:4000/health')).status;
  ok('remove + save restores the list', left === 200 && await b.evaluate(`![...document.querySelectorAll('input[aria-label^="Telephony on a bought number: Country"]')].some(i => ['GB','DE','FR','AU','NZ','IE'].includes(i.value))`));
  const saved = await (await fetch('http://localhost:4000/health')).status;
  ok('API still healthy', saved === 200);

  // Preview needs a draft: save the current config as one on the Draft tab.
  await b.goto('http://localhost:3001/pricing/?tab=draft', 2500);
  await until(`!![...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Save draft' && !x.disabled)`);
  await b.evaluate(`[...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Save draft').click()`);
  await wait(2000);
  await b.goto('http://localhost:3001/pricing/?tab=preview', 2500);
  ok('preview has a Pack column', await until(`[...document.querySelectorAll('th')].some(th => th.textContent.trim() === 'Pack')`));
  const marginRows = await b.evaluate(`(() => { const t = [...document.querySelectorAll('table')].find(t => [...t.querySelectorAll('th')].some(th => th.textContent.trim() === 'Pack')); return t ? [...t.querySelectorAll('tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ')) : []; })()`);
  ok('one row per pack and tier', marginRows.length >= 8, marginRows.join(' | '));
  ok('no em dash on the preview', await b.evaluate(`!document.body.innerText.includes('\u2014')`));
  await b.shot(`${OUT}/preview-desktop.png`, true);

  // Keyboard: Tab reaches the Add button with a visible focus ring
  await b.goto('http://localhost:3001/pricing/?tab=costs', 2500);
  await until(`document.body.innerText.includes('Voice platform cost inputs')`);
  let reached = false, ring = '';
  for (let i = 0; i < 80 && !reached; i++) {
    await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    if (await b.evaluate(`document.activeElement.textContent.trim() === 'Add model id'`)) {
      await wait(400); // the ring is a box-shadow with a transition
      ring = await b.evaluate(`(() => { const a = document.activeElement; return a.matches(':focus-visible') + ' ' + getComputedStyle(a).boxShadow; })()`);
      reached = true;
    }
  }
  ok('keyboard reaches "Add model id" with a visible focus ring', reached && ring.startsWith('true') && /rgba?\((?!0, 0, 0, 0\))[^)]*\) 0px 0px 0px [1-9]/.test(ring), ring);

  // Phone width
  await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await b.goto('http://localhost:3001/pricing/?tab=costs', 2500);
  await until(`document.body.innerText.includes('Voice platform cost inputs')`);
  const widths = await b.evaluate(`({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth })`);
  ok('no horizontal scroll at 390 px', widths.scroll <= widths.client, JSON.stringify(widths));
  await b.shot(`${OUT}/costs-390.png`, true);
  ok('voice keys sorted and shown whole at 390 px', await b.evaluate(`(() => { const ins = [...document.querySelectorAll('input[aria-label^="Voice: Provider"]')]; const keys = ins.map(i => i.value); const sorted = [...keys].sort((a, b) => a.localeCompare(b)); return JSON.stringify(keys) === JSON.stringify(sorted) && ins.every(i => i.scrollWidth <= i.clientWidth + 1); })()`), String(await b.evaluate(`[...document.querySelectorAll('input[aria-label^="Voice: Provider"]')].map(i => i.value + ':' + i.scrollWidth + '/' + i.clientWidth).join(' ')`)));
  ok('no console errors', b.logs.filter((l) => !/favicon|DevTools|Download the React/i.test(l)).length === 0, b.logs.join(' || ').slice(0, 600));
} finally { b.close(); }
process.exit(results.every((r) => r.pass) ? 0 : 1);
