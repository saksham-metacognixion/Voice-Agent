/**
 * ADR 0036 in the browser: the screens and redirects of the §6.2 / §6.3 sign-in and money
 * rules, against the export, the API it was built for and the stand-in issuer — no Auth0,
 * no Stripe, nothing sent. Screenshots land in frontend/web/.e2e/.
 *
 *   1. A1 Terms: first screen after sign-in, unticked, Continue disabled until ticked, then on.
 *   2. §6.2 MFA: the shell banner for an owner of a workspace with auto top-up on; "Verify now"
 *      → A5 → a step-up sign-in → back, banner gone, a change accepted.
 *   3. A7: the switcher lists each workspace's own balance.
 *   4. §6.4: a viewer opening a write route after go-live lands on /app with the toast.
 *   5. §6.2 15-minute token: past the API's limit the SPA re-mints and stays signed in.
 *   6. A8: /login with an invite in `next` shows the invited address.
 *   7. A3: US and Canada selectable, others listed as coming soon and disabled.
 *   8. A2: the destination address and the resend control (the stand-in has no provider, so the
 *      honest answer is the "cannot send" message, never a fake "sent").
 *
 * Needs: the issuer (`LOCAL_ISSUER_USER_FILE` set, so this script can switch identity), the
 * export at PORTAL_URL built against API_URL and the issuer, the API with
 * AUTH_CUSTOMER_MAX_TOKEN_AGE_S=20 (so step 5 takes seconds), and SEED = the JSON
 * `backend/api/scripts/e2e-d20-seed.ts` printed.
 *
 *   SEED="$(…e2e-d20-seed.ts)" LOCAL_ISSUER_USER_FILE=/tmp/u.json node scripts/e2e-auth-d20.mjs
 */
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const S = fileURLToPath(new URL('../.e2e', import.meta.url));
mkdirSync(S, { recursive: true });
const BASE = (process.env.PORTAL_URL ?? 'http://localhost:3005').replace(/\/+$/, '');
const API = (process.env.API_URL ?? 'http://localhost:4001').replace(/\/+$/, '');
const USER_FILE = process.env.LOCAL_ISSUER_USER_FILE;
const TOKEN_AGE_S = Number(process.env.TOKEN_AGE_S ?? 20);
const seed = JSON.parse(process.env.SEED ?? '{}');
if (!USER_FILE || !seed.owner) throw new Error('Set LOCAL_ISSUER_USER_FILE and SEED (see the header).');

const results = [];
const ok = (name, cond, extra = '') => {
  results.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + String(extra).slice(0, 300) : ''}`);
  console.log(results.at(-1));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const as = (p) => writeFileSync(USER_FILE, JSON.stringify({ sub: p.sub, email: p.email, name: p.name, email_verified: p.email_verified !== false, ...(typeof p.mfa_enrolled === 'boolean' ? { mfa_enrolled: p.mfa_enrolled } : {}) }));

const b = await launch({ port: 9336, args: ['--lang=en-US'] });
async function waitFor(expr, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await b.evaluate(expr).catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  return null;
}
const path = async () => {
  const u = new URL(await b.url());
  return u.pathname + u.search;
};
const text = () => b.evaluate('document.body.innerText');
const clickText = (t, tag = 'button, a') =>
  b.evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(tag)})].find(e => e.textContent.trim().includes(${JSON.stringify(t)})); if (!el) return 'missing'; el.click(); return 'ok'; })()`);
const setWorkspace = (id) => b.evaluate(`localStorage.setItem('portal:workspace', ${JSON.stringify(id)}); 'ok'`);
const apiCall = (method, route, body, workspace) =>
  b.evaluate(`(async () => {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('@@auth0spajs@@') && !k.includes('@@user@@'));
    let token = null; for (const k of keys) { try { token = JSON.parse(localStorage.getItem(k)).body.access_token; } catch {} }
    const res = await fetch(${JSON.stringify(API)} + ${JSON.stringify(route)}, { method: ${JSON.stringify(method)}, headers: { Authorization: 'Bearer ' + token, ${workspace ? `'X-Workspace-Id': ${JSON.stringify(workspace)},` : ''} 'Content-Type': 'application/json' }, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  })()`);
async function signOut() {
  await b.evaluate('localStorage.clear(); sessionStorage.clear(); "ok"');
}
async function signIn(person) {
  as(person);
  await signOut();
  await b.goto(`${BASE}/login/`, 2500);
  await clickText('Sign in', 'button');
  await waitFor(`!location.pathname.startsWith('/login')`, 15000);
  await sleep(1500);
}

try {
  // 1. A1 Terms -------------------------------------------------------------------------
  await signIn(seed.owner);
  await waitFor(`location.pathname.startsWith('/terms')`, 10000);
  ok('terms: first screen after sign-in', (await path()).startsWith('/terms/'), await path());
  const disabled = await b.evaluate(`[...document.querySelectorAll('button')].find(e => e.textContent.trim() === 'Continue')?.disabled === true`);
  const unticked = await b.evaluate(`document.querySelector('#terms-agree')?.getAttribute('data-state') === 'unchecked'`);
  ok('terms: box starts unticked and Continue is disabled', disabled && unticked);
  await b.shot(`${S}/d20-terms.png`);
  await b.evaluate(`document.querySelector('#terms-agree').click(); 'ok'`);
  await sleep(300);
  await clickText('Continue', 'button');
  await waitFor(`!location.pathname.startsWith('/terms')`, 10000);
  ok('terms: accepted → leaves the screen', !(await path()).startsWith('/terms/'), await path());
  const me = await apiCall('GET', '/me');
  ok('terms: recorded with the current version', me.status === 200 && me.json?.terms?.required === false && Boolean(me.json?.terms?.accepted_at), JSON.stringify(me.json?.terms));

  // 2. §6.2 MFA banner and step-up --------------------------------------------------------
  await setWorkspace(seed.topupWs);
  await b.goto(`${BASE}/app/`, 3500);
  await waitFor(`document.body.innerText.includes('Two-factor verification needed')`, 10000);
  const banner = await text();
  ok('mfa: banner for an owner while auto top-up is on', banner.includes('Two-factor verification needed') && banner.includes('Auto top-up is on'));
  await b.shot(`${S}/d20-mfa-banner.png`);
  const refused = await apiCall('PATCH', '/workspace', { name: `D20 Bakery renamed ${seed.run}` }, seed.topupWs);
  ok('mfa: a change without the factor is refused by the API', refused.status === 403 && refused.json?.code === 'MFA_REQUIRED', JSON.stringify(refused));
  await clickText('Verify now', 'a');
  await waitFor(`location.pathname.startsWith('/mfa')`, 8000);
  ok('mfa: "Verify now" opens A5 with the way back', (await path()).startsWith('/mfa/?next='), await path());
  const mfaButton = (await text()).includes('Verify with two-factor now') ? 'Verify with two-factor now' : 'Set up two-factor';
  await clickText(mfaButton, 'button');
  await waitFor(`location.pathname === '/app/'`, 15000);
  await sleep(2500);
  ok('mfa: back where it started after the step-up', (await path()).startsWith('/app/'), await path());
  ok('mfa: banner gone once the session passed a factor', !(await text()).includes('Two-factor verification needed'));
  const allowed = await apiCall('PATCH', '/workspace', { name: `D20 Bakery renamed ${seed.run}` }, seed.topupWs);
  ok('mfa: the same change is accepted now', allowed.status === 200, JSON.stringify(allowed.json?.mfa));

  // 2b. D6 Team: last active and two-factor columns ------------------------------------------
  await b.goto(`${BASE}/app/settings/?tab=team`, 3500);
  await waitFor(`document.body.innerText.includes('Last active')`, 10000);
  const team = await text();
  ok('team: "Last active" and "Two-factor" columns', team.includes('Last active') && team.includes('Two-factor'), team.replace(/\s+/g, ' ').slice(0, 300));
  const ownerRow = await b.evaluate(`[...document.querySelectorAll('tr')].map(r => r.innerText).find(t => t.includes(${JSON.stringify(seed.owner.email)})) ?? ''`);
  ok('team: the owner shows as active, with two-factor on', !ownerRow.includes('Not yet') && /\bOn\b/.test(ownerRow), ownerRow.replace(/\s+/g, ' '));
  await b.shot(`${S}/d20-team.png`);

  // 2c. D6 Security: sign-in methods and turning two-factor off with re-auth ---------------------
  await signIn({ ...seed.owner, mfa_enrolled: true });
  await setWorkspace(seed.topupWs);
  await b.goto(`${BASE}/app/settings/?tab=security`, 3500);
  await waitFor(`document.body.innerText.includes('Ways you sign in')`, 10000);
  ok('security: the sign-in methods card says plainly it cannot list them here', (await text()).includes('cannot be listed in this environment'));
  ok('security: "Turn off" is offered while two-factor is on', (await clickText('Turn off', 'button')) === 'ok');
  await waitFor(`document.querySelector('[role="dialog"]')?.innerText.includes('Turn off two-step verification?')`, 5000);
  await b.shot(`${S}/d20-mfa-off-dialog.png`);
  await b.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent.trim() === 'Turn off two-step verification')?.click(); 'ok'`);
  const reopened = await waitFor(`location.pathname.startsWith('/app/settings/') && !location.search.includes('confirm=') && document.querySelector('[role="dialog"]')?.innerText.includes('Turn off two-step verification?')`, 20000);
  ok('security: without a fresh challenge it asks for one and comes back with the dialog open', Boolean(reopened), await path());
  await sleep(1000);
  await b.evaluate(`[...document.querySelectorAll('[role="dialog"] button')].find(e => e.textContent.trim() === 'Turn off two-step verification')?.click(); 'ok'`);
  const still = await waitFor(`document.querySelector('[role="dialog"]')?.innerText.includes('stays on while you are an owner or admin')`, 8000);
  ok('security: an owner of a workspace with auto top-up on cannot turn it off', Boolean(still), await b.evaluate(`document.querySelector('[role="dialog"]')?.innerText ?? '(no dialog) ' + location.href`));
  await b.shot(`${S}/d20-mfa-off-refused.png`);
  await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'ok'`);
  await sleep(500);
  ok('security: Escape closes the dialog', !(await b.evaluate(`Boolean(document.querySelector('[role="dialog"]'))`)));

  // 3. A7 switcher balances -----------------------------------------------------------------
  await b.goto(`${BASE}/select-workspace/`, 3000);
  await waitFor(`document.body.innerText.includes('D20 Clinic')`, 8000);
  const switcher = await text();
  ok('switcher: each workspace with its own balance', switcher.includes('50') && /1,234\.5/.test(switcher), switcher.replace(/\s+/g, ' ').slice(0, 300));
  await b.shot(`${S}/d20-switcher.png`);

  // 4. §6.4 viewer on a write route -----------------------------------------------------------
  await setWorkspace(seed.viewerWs);
  await b.goto(`${BASE}/onboarding/knowledge/`, 1000);
  const toast = await waitFor(`document.body.innerText.includes('view-only access') && location.pathname === '/app/'`, 10000);
  ok('viewer: a write route sends them to /app with the view-only toast', Boolean(toast), await path());
  await b.shot(`${S}/d20-viewer-toast.png`);
  const viewerWrite = await apiCall('PATCH', '/workspace', { name: 'nope' }, seed.viewerWs);
  ok('viewer: the API refuses the write itself', viewerWrite.status === 403 && viewerWrite.json?.code === 'FORBIDDEN_ROLE');

  // 5. 15-minute token (shortened to TOKEN_AGE_S on this API) ------------------------------------
  await setWorkspace(seed.topupWs);
  await b.goto(`${BASE}/app/`, 2500);
  await sleep((TOKEN_AGE_S + 8) * 1000);
  await b.goto(`${BASE}/app/calls/`, 4000);
  await sleep(2000);
  ok('token: past the API limit the SPA re-mints and stays signed in', (await path()).startsWith('/app/calls/'), await path());

  // 6. A8 invite pre-fill ----------------------------------------------------------------------
  await signOut();
  await b.goto(`${BASE}/login/?next=${encodeURIComponent(`/invite/?token=${seed.invite.token}`)}`, 3000);
  await waitFor(`document.body.innerText.includes('Invited as')`, 8000);
  ok('invite: sign-in shows the invited address', (await text()).includes(`Invited as ${seed.invite.email}`));
  await b.shot(`${S}/d20-invite-hint.png`);

  // 7. A3 launch countries ---------------------------------------------------------------------
  await signIn(seed.newcomer);
  await waitFor(`location.pathname.startsWith('/setup/workspace')`, 10000);
  // Radix Select opens from the keyboard as it does for a screen-reader user.
  await b.evaluate(`(() => { const el = document.querySelector('#country'); el?.focus(); el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); return 'ok'; })()`);
  await waitFor(`document.querySelectorAll('[role="option"]').length > 0`, 5000);
  const options = await b.evaluate(`[...document.querySelectorAll('[role="option"]')].map(o => ({ t: o.textContent.trim(), d: o.hasAttribute('data-disabled') }))`);
  const ca = options?.find((o) => o.t === 'Canada');
  const us = options?.find((o) => o.t === 'United States');
  const gb = options?.find((o) => o.t.startsWith('United Kingdom'));
  ok('countries: US and Canada selectable', Boolean(ca && !ca.d && us && !us.d), JSON.stringify(options?.slice(0, 4)));
  ok('countries: others coming soon and disabled', Boolean(gb && gb.d && gb.t.includes('coming soon')), JSON.stringify(gb));
  await b.shot(`${S}/d20-countries.png`);

  // 8. A2 verify email ---------------------------------------------------------------------------
  await signIn({ ...seed.unverified, email_verified: false });
  await waitFor(`location.pathname.startsWith('/verify-email')`, 10000);
  const verify = await text();
  ok('verify: the destination address is shown', verify.includes(seed.unverified.email));
  ok('verify: a resend control is offered', verify.includes('Resend email'));
  await clickText('Resend email', 'button');
  await waitFor(`document.querySelectorAll('[role="alert"], [role="status"]').length > 0`, 8000);
  const after = await text();
  ok('verify: no provider here is said plainly, never a fake "sent"', !after.includes('Sent. Check your inbox') && /cannot|could not/i.test(after), after.replace(/\s+/g, ' ').slice(0, 200));
  await b.goto(`${BASE}/app/`, 3000);
  ok('verify: the app stays closed to an unverified address', (await path()).startsWith('/verify-email/'), await path());
  await b.shot(`${S}/d20-verify.png`);
} catch (error) {
  ok('script ran to the end', false, error instanceof Error ? error.stack : String(error));
} finally {
  const errors = b.logs.filter((l) => !/favicon|ERR_ABORTED|401|403|503|status of 4|status of 5/.test(l));
  ok('no page exceptions', !errors.some((l) => l.startsWith('exception')), errors.slice(0, 5).join(' | '));
  writeFileSync(`${S}/d20-results.txt`, results.join('\n') + '\n');
  b.close();
  const failed = results.filter((r) => r.startsWith('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
