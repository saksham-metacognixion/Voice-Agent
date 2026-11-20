import crypto from 'k6/crypto';
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * The §13.9 exit check: inbound authorisation p95 < 300 ms.
 *
 *   pnpm --filter @portal/api load:setup        # creates the target workspace
 *   pnpm --filter @portal/api load:inbound      # runs this
 *
 * It signs every request the way Retell does — HMAC-SHA256 over `rawBody + timestamp`
 * keyed with the API key (ADR 0003 §A) — so the run exercises signature verification,
 * the two Redis round trips, the six checks and the write-behind enqueue, exactly as a
 * real call does. Nothing is stubbed and no Retell call is made.
 *
 * Call ids repeat within a small window on purpose, and across VUs rather than per VU: a
 * workspace has a bounded number of live calls, so `active:{ws}` must stay small and under
 * the plan cap. Without that the hash would grow past the cap within seconds and the run
 * would measure the decline path — the cheap one — instead of the allow path it is meant
 * to prove. `LIVE_CALL_IDS` must stay below the workspace's concurrency cap.
 */

const API_URL = __ENV.API_URL || 'http://127.0.0.1:4000';
const TOKEN = __ENV.NUMBER_TOKEN;
const TO_NUMBER = __ENV.TO_NUMBER;
const API_KEY = __ENV.RETELL_API_KEY;
const LIVE_CALL_IDS = Number(__ENV.LIVE_CALL_IDS || 20);

const authorizeLatency = new Trend('inbound_authorize_ms', true);
const allowed = new Counter('inbound_allowed');
const declined = new Counter('inbound_declined');
const failOpen = new Counter('inbound_fail_open');
const answeredOk = new Rate('inbound_answered_2xx');

export const options = {
  scenarios: {
    // Retell's own pool is 20 concurrent calls per workspace (ADR 0003 §10); 40 VUs is
    // comfortably past what one environment can actually ring.
    steady: { executor: 'constant-vus', vus: Number(__ENV.VUS || 40), duration: __ENV.DURATION || '30s' },
  },
  thresholds: {
    // The spec's SLO, asserted rather than eyeballed. k6 exits non-zero if it is missed.
    'http_req_duration{name:inbound}': ['p(95)<300', 'p(99)<500'],
    inbound_authorize_ms: ['p(95)<300'],
    inbound_answered_2xx: ['rate==1.00'],
    // The run must exercise the allow path — the expensive one, with the reservation
    // write and the write-behind enqueue — not spend itself declining on the cap.
    inbound_allowed: ['count>100'],
    // A 4xx/5xx is never an acceptable answer here: Retell retries three times and then
    // answers with the bound agent anyway (ADR 0003 §1).
    http_req_failed: ['rate==0.00'],
  },
};

export function setup() {
  if (!TOKEN || !TO_NUMBER || !API_KEY) {
    throw new Error('NUMBER_TOKEN, TO_NUMBER and RETELL_API_KEY are required. Run `pnpm --filter @portal/api load:setup` first.');
  }
  const health = http.get(`${API_URL}/health`);
  check(health, { 'api is up': (r) => r.status === 200 });
  return { url: `${API_URL}/webhooks/retell/inbound/${TOKEN}` };
}

/** `x-retell-signature: v=<unix ms>,d=<hmac hex>` over `body + timestamp`. */
function sign(body) {
  const timestamp = Date.now();
  const digest = crypto.hmac('sha256', API_KEY, `${body}${timestamp}`, 'hex');
  return `v=${timestamp},d=${digest}`;
}

export default function (data) {
  const callId = `call_load_${(__ITER * 40 + __VU) % LIVE_CALL_IDS}`;
  const body = JSON.stringify({
    event: 'call_inbound',
    event_timestamp: Date.now(),
    call_inbound: {
      call_id: callId,
      agent_id: 'agent_load_test',
      agent_version: 1,
      from_number: `+1937555${String(1000 + (__VU % 9000))}`,
      to_number: TO_NUMBER,
    },
  });

  const started = Date.now();
  const res = http.post(data.url, body, {
    headers: { 'Content-Type': 'application/json', 'x-retell-signature': sign(body) },
    tags: { name: 'inbound' },
  });
  authorizeLatency.add(Date.now() - started);
  answeredOk.add(res.status === 200);

  let answer = {};
  try {
    answer = res.json();
  } catch (error) {
    answer = {};
  }
  const inbound = answer && answer.call_inbound;
  if (inbound && inbound.reject === true) declined.add(1);
  else if (inbound && inbound.override_agent_id) allowed.add(1);
  else failOpen.add(1);

  check(res, {
    'answered 200': (r) => r.status === 200,
    'answered with an authorisation, not an error page': () => Boolean(inbound),
    'was not a fail-open': () => Boolean(inbound),
  });
}
