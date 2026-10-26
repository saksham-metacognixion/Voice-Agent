import { isPhoneFieldName, type CapturedPhoneCheck, type CapturedPhoneStatus } from '@portal/schemas';
import { isSupportedCountry, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

/**
 * Captured phone numbers, checked against what the caller actually said (§9.8).
 *
 * The voice agent and the post-call analysis are both language models, and on 26 Oct a
 * caller who said nine digits twice ("eight seven six five four three two one zero")
 * heard ten read back, and ten were captured: `8765432100`. Ten digits is a perfectly
 * valid number in India and in North America, so a format check alone passes the very
 * number that was invented. What catches it is the transcript: a captured number whose
 * digits the caller never said, in that order, was made up somewhere after the caller
 * spoke. The prompt rule (`FIXED_PLATFORM_GUARDRAILS`) is what stops the agent doing it;
 * this is what tells staff when it happened anyway.
 *
 * Nothing here rewrites what the platform stored. It is a read-time verdict, so an older
 * call is checked the same way the next one is, and nothing ever "repairs" a number.
 */

export interface CapturedPhoneInput {
  /** `analysis_json.custom_analysis_data`. */
  captured: unknown;
  /** The caller's own turns, in order (`callerUtterances`). Empty when there is no transcript. */
  callerTurns: readonly string[];
  /** The caller id, when the platform had one: "call me back on this number" is a fine answer. */
  callerId?: string | null;
  /** ISO 3166 regions a number is valid in: the workspace's country, the agent's locales. */
  regions: readonly string[];
}

export function checkCapturedPhones(input: CapturedPhoneInput): CapturedPhoneCheck[] {
  if (!input.captured || typeof input.captured !== 'object' || Array.isArray(input.captured)) return [];
  const regions = supportedRegions(input.regions);
  const runs = input.callerTurns.flatMap(spokenDigitRuns);
  const windows = joinedWindows(runs);
  const heard = phoneLengthRuns(runs);
  const callerForms = input.callerId ? nationalForms(input.callerId, regions) : [];

  const checks: CapturedPhoneCheck[] = [];
  for (const [field, raw] of Object.entries(input.captured as Record<string, unknown>)) {
    if (!isPhoneFieldName(field)) continue;
    const value = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
    const digits = value.replace(/\D/g, '');
    if (!digits) continue;

    const forms = nationalForms(value, regions);
    const said = windows.some((w) => forms.some((f) => w.includes(f)));
    const isCallerId = callerForms.some((c) => forms.includes(c));
    let status: CapturedPhoneStatus = 'ok';
    if (input.callerTurns.length > 0 && !said && !isCallerId) status = 'mismatch';
    else if (!isValidIn(value, regions)) status = 'invalid';

    checks.push({ field, value, status, digits: digits.length, heard: status === 'ok' ? [] : heard });
  }
  return checks;
}

/**
 * The caller's turns from what `call_analyzed` stored: `transcript_object` (`{role,
 * content}` per utterance), else the plain text's `User:` lines.
 */
export function callerUtterances(json: unknown, text: string | null | undefined): string[] {
  if (Array.isArray(json)) {
    const turns = json
      .map((u) => (u && typeof u === 'object' ? (u as { role?: unknown; content?: unknown }) : null))
      .filter((u): u is { role: string; content: string } => u?.role === 'user' && typeof u.content === 'string')
      .map((u) => u.content.trim())
      .filter(Boolean);
    if (turns.length) return turns;
  }
  if (!text?.trim()) return [];
  const turns: string[] = [];
  let inCaller = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(agent|user|assistant|caller|customer)\s*:\s*(.*)$/i.exec(line);
    if (m) {
      const who = m[1]!.toLowerCase();
      inCaller = who === 'user' || who === 'caller' || who === 'customer';
      if (inCaller) turns.push(m[2] ?? '');
    } else if (inCaller && turns.length) {
      turns[turns.length - 1] = `${turns[turns.length - 1]} ${line}`;
    }
  }
  return turns.map((t) => t.trim()).filter(Boolean);
}

const UNITS: Record<string, string> = {
  zero: '0', nought: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};
const TEENS: Record<string, string> = {
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
};
const TENS: Record<string, string> = { twenty: '2', thirty: '3', forty: '4', fifty: '5', sixty: '6', seventy: '7', eighty: '8', ninety: '9' };
/** Said in the middle of a number without ending it. */
const FILLERS = new Set(['uh', 'um', 'umm', 'er', 'erm', 'ah', 'hmm', 'mm']);
const REPEATS: Record<string, number> = { double: 2, triple: 3 };

/**
 * The digit runs in one utterance, as a person dictates them: numerals, digit words,
 * "oh" for zero inside a number, "double five", "eighteen", "twenty one", "twenty-one
 * hundred". Punctuation never ends a run (a transcript writes "Eight seven, six. Five"),
 * any other word does. Nothing is inferred: a run holds exactly the digits said.
 */
export function spokenDigitRuns(utterance: string): string[] {
  const tokens = utterance.toLowerCase().match(/[a-z]+|\d+/g) ?? [];
  const runs: string[] = [];
  let run = '';
  const end = () => {
    if (run) runs.push(run);
    run = '';
  };
  const digitOf = (token: string | undefined): string | null =>
    token === undefined ? null : /^\d$/.test(token) ? token : (UNITS[token] ?? null);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^\d+$/.test(token)) run += token;
    else if (token in UNITS) run += UNITS[token];
    else if ((token === 'oh' || token === 'o') && (run || digitOf(tokens[i + 1]) !== null)) run += '0';
    else if (token in TEENS) run += TEENS[token];
    else if (token in TENS) {
      const unit = UNITS[tokens[i + 1] ?? ''];
      if (unit && unit !== '0') {
        run += TENS[token] + unit;
        i++;
      } else run += `${TENS[token]}0`;
    } else if (token in REPEATS && digitOf(tokens[i + 1]) !== null) {
      run += digitOf(tokens[i + 1])!.repeat(REPEATS[token]!);
      i++;
    } else if (token === 'hundred' && run) run += '00';
    else if (token === 'thousand' && run) run += '000';
    else if (FILLERS.has(token)) continue;
    else end();
  }
  end();
  return runs;
}

/**
 * Every run, and every run joined to the next one or two: a caller who says "nine eight
 * seven, sorry, six five four…" or splits the number over two turns still said it.
 * Kept short so that unrelated numbers in a call ("Friday at 7, party of 4") are not
 * strung together into one the caller never said.
 */
function joinedWindows(runs: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    let joined = '';
    for (let j = i; j < Math.min(runs.length, i + 3); j++) {
      joined += runs[j];
      out.push(joined);
    }
  }
  return out;
}

/** Runs long enough to be a phone number, latest last, at most three. */
function phoneLengthRuns(runs: readonly string[]): string[] {
  const seen = [...new Set(runs.filter((r) => r.length >= 6))];
  return seen.slice(-3);
}

/**
 * The digit strings a caller could have said for this number: as written, and its
 * national number in each region (no country code, no trunk 0) — a caller in India says
 * "98765 43210", the analysis may write "+91 98765 43210". Short forms are not returned,
 * so a stray "2" in the transcript never vouches for a number.
 */
function nationalForms(value: string, regions: readonly CountryCode[]): string[] {
  const forms = new Set<string>();
  const digits = value.replace(/\D/g, '');
  forms.add(digits);
  if (digits.startsWith('0')) forms.add(digits.replace(/^0+/, ''));
  for (const parsed of parsedIn(value, regions)) forms.add(String(parsed.nationalNumber));
  return [...forms].filter((f) => f.length >= 6);
}

function isValidIn(value: string, regions: readonly CountryCode[]): boolean {
  return parsedIn(value, regions).some((p) => p.isValid());
}

function parsedIn(value: string, regions: readonly CountryCode[]) {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  const candidates = [
    ...regions.map((r) => parsePhoneNumberFromString(trimmed, r)),
    trimmed.startsWith('+') || trimmed.startsWith('00') ? parsePhoneNumberFromString(`+${digits.replace(/^00/, '')}`) : undefined,
    // "919876543210" — a country code said without the plus. Only for a number too long
    // to be national, so nine digits never turn into some other country's number.
    !trimmed.startsWith('+') && digits.length >= 11 ? parsePhoneNumberFromString(`+${digits}`) : undefined,
  ];
  return candidates.filter((p): p is NonNullable<typeof p> => Boolean(p));
}

function supportedRegions(regions: readonly string[]): CountryCode[] {
  const out = new Set<CountryCode>();
  for (const r of regions) {
    const code = r.trim().toUpperCase();
    if (isSupportedCountry(code)) out.add(code);
  }
  return [...out];
}
