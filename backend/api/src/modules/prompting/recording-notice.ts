import type { AgentLanguage } from '@portal/schemas';

/**
 * The recording notice (QA-081, spec D6 Data & privacy: "consent line auto-insert").
 *
 * An agent that records its calls says so before its greeting: "Just so you know, this
 * call is recorded. Thank you for calling Maple Dental…". Like the documents block and
 * the Arabic language block it is added **in code at the platform sync** and never
 * stored — not in `prompt_text`, not in `greeting` — so:
 *
 *   - turning recording off in an agent's settings, or the notice off in the workspace's
 *     privacy settings, takes it away at the next sync without touching any version;
 *   - a regenerate, a feedback patch or an Advanced edit can neither drop it nor double it;
 *   - a live agent picks it up at its next sync (publish, a knowledge republish, the next
 *     test call for a draft) without a regenerate.
 *
 * Before the greeting rather than after it, because a greeting ends on a question ("How
 * can I help?") and the caller answers that; a notice after it would be talked over.
 *
 * The default text is per language, looked up by the agent's main locale and then by its
 * base language; a language not listed falls back to English. The business can replace
 * it with its own sentence (`tenants.recording_notice_text`), which is then used as
 * written whatever the agent's language — it is theirs to word.
 */

const NOTICES: Record<string, string> = {
  en: 'Just so you know, this call is recorded.',
  fr: 'Veuillez noter que cet appel est enregistré.',
  es: 'Le informamos que esta llamada está siendo grabada.',
  de: 'Hinweis: Dieser Anruf wird aufgezeichnet.',
  it: 'La informiamo che questa chiamata viene registrata.',
  pt: 'Informamos que esta chamada está a ser gravada.',
  'pt-BR': 'Informamos que esta ligação está sendo gravada.',
  nl: 'Goed om te weten: dit gesprek wordt opgenomen.',
  ar: 'للعلم، هذه المكالمة مسجّلة.',
  hi: 'कृपया ध्यान दें, यह कॉल रिकॉर्ड की जा रही है।',
  ja: 'この通話は録音されています。',
  zh: '请注意，本次通话将被录音。',
  ko: '이 통화는 녹음됩니다.',
  ru: 'Обратите внимание: этот звонок записывается.',
  uk: 'Зверніть увагу: цей дзвінок записується.',
  pl: 'Informujemy, że ta rozmowa jest nagrywana.',
  tr: 'Bu görüşme kayıt altına alınmaktadır.',
  sv: 'Observera att samtalet spelas in.',
  da: 'Bemærk, at opkaldet bliver optaget.',
  no: 'Merk at samtalen blir tatt opp.',
  fi: 'Huomioithan, että puhelu tallennetaan.',
  el: 'Σας ενημερώνουμε ότι η κλήση καταγράφεται.',
  ro: 'Vă informăm că acest apel este înregistrat.',
  cs: 'Upozorňujeme, že tento hovor je nahráván.',
  hu: 'Tájékoztatjuk, hogy a hívást rögzítjük.',
  vi: 'Xin lưu ý, cuộc gọi này đang được ghi âm.',
  id: 'Perlu diketahui, panggilan ini direkam.',
  ms: 'Untuk makluman, panggilan ini dirakam.',
  he: 'לידיעתך, השיחה מוקלטת.',
  th: 'โปรดทราบว่าการโทรนี้มีการบันทึกเสียง',
};

/** Our default notice for an agent locale: the locale, then its base language, then English. */
export function defaultRecordingNotice(locale: AgentLanguage | string): string {
  const base = locale.split('-')[0] ?? 'en';
  return NOTICES[locale] ?? NOTICES[base] ?? NOTICES.en!;
}

export interface RecordingNoticeInput {
  /** The version's `recording_enabled`: nothing recorded, nothing to say. */
  recording: boolean;
  /** `tenants.recording_notice`, the workspace switch. */
  enabled: boolean;
  /** `tenants.recording_notice_text`; null or blank = ours. */
  text: string | null;
  language: AgentLanguage;
}

/** The sentence the agent says before its greeting, or null when it says none. */
export function recordingNotice(input: RecordingNoticeInput): string | null {
  if (!input.recording || !input.enabled) return null;
  const own = input.text?.trim();
  return own ? own : defaultRecordingNotice(input.language);
}

/**
 * The greeting as the caller hears it: the notice, then the greeting. A greeting that
 * already carries the notice (a customer who wrote it in by hand) is left alone, and a
 * version with no greeting gets none — `no_greeting` is a lint error that blocks the
 * publish, and a notice alone would replace the platform's own opening.
 */
export function greetingWithNotice(greeting: string | null, notice: string | null): string | null {
  if (greeting === null || !notice) return greeting;
  if (comparable(greeting).includes(comparable(notice))) return greeting;
  return `${notice} ${greeting}`;
}

function comparable(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/[\s\p{P}]+/gu, ' ')
    .trim();
}
