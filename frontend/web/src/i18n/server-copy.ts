'use client';

import type { ForwardingGuide, LintFinding, TemplateSummary } from '@portal/schemas';
import { useTranslations } from 'next-intl';
import * as React from 'react';
import { humanise } from '../dashboard/analysis';
import { localeDirection, messages } from './index';
import { useLocaleChoice } from './locale-provider';

type Guide = Record<'steps' | 'disable_steps' | 'notes', string[]>;
const DEST = '{destination}';

/**
 * `server` against an English source line that may hold one `{destination}`: the filled-in
 * destination when the server sent exactly that line, else null. Exact, so a code a carrier
 * changed on the server (or a pack line staff edited) is never shown from a stale translation.
 */
export function matchSource(server: string, source: string): { destination: string | null } | null {
  const at = source.indexOf(DEST);
  if (at < 0) return server === source ? { destination: null } : null;
  const head = source.slice(0, at);
  const tail = source.slice(at + DEST.length);
  if (server.length < head.length + tail.length || !server.startsWith(head) || !server.endsWith(tail)) return null;
  return { destination: server.slice(head.length, server.length - tail.length) };
}

/**
 * Text the API sends in English only — a template's name and tagline (the `templates`
 * table), its example copy, industry slugs, lint findings. In English the API's text is
 * shown unchanged; in any other language the catalogue's line for the same id is, and the
 * API's text stays the fallback for an id the catalogue does not know yet (a new template
 * seeded before its copy was translated). Nothing here changes what is stored or sent.
 */
export function useServerCopy() {
  const { locale } = useLocaleChoice();
  const tc = useTranslations('wizard.w1.catalog');
  const tf = useTranslations('dashboard.agents.prompt.findings');
  const tl = useTranslations('dashboard.calls');
  const tv = useTranslations('wizard.w3.accents');
  return React.useMemo(() => {
    const english = locale === 'en';
    const pick = (t: typeof tc | typeof tf, key: string, fallback: string) => (!english && t.has(key) ? t(key) : fallback);
    return {
      /**
       * A free-text sentence from the API (a job's `customer_reason`, an activation's error):
       * there is no id to translate it by, so outside English it gives way to our own line.
       */
      sentence: (text: string | null | undefined): string | null => (english && text ? text : null),
      templateName: (tpl: Pick<TemplateSummary, 'id' | 'name'>) => pick(tc, `names.${tpl.id}`, tpl.name),
      templateTagline: (tpl: Pick<TemplateSummary, 'id' | 'tagline'>) => pick(tc, `taglines.${tpl.id}`, tpl.tagline),
      templateBestFor: (tpl: Pick<TemplateSummary, 'id' | 'best_for'>) => pick(tc, `bestFor.${tpl.id}`, tpl.best_for),
      /** `real_estate` → "العقارات"; English, and a slug the catalogue does not know (free text), show it as it is. */
      industry: (slug: string) => pick(tc, `industries.${slug}`, slug),
      /** A template's example text for an industry; null keeps the API's. */
      example: (industry: string | null | undefined) => (!english && industry && tc.has(`examples.${industry}`) ? tc(`examples.${industry}`) : null),
      /** The server's sentence carries specifics (lengths, the missing message); other languages get the rule's own line. */
      finding: (f: Pick<LintFinding, 'rule' | 'message'>) => pick(tf, f.rule, f.message),
      /** A post-call analysis field (`caller_name`) — the templates' names are in the catalogue, anything else is humanised. */
      analysisField: (name: string) => pick(tl, `fields.${name}`, humanise(name)),
      /** The platform's `disconnection_reason` (`user_hangup`). */
      disconnection: (reason: string) => pick(tl, `disconnect.${reason}`, humanise(reason)),
      /** A voice's accent from the catalogue ("American"); free text, so an unknown one is shown as it is. */
      accent: (accent: string) => pick(tv, accent.trim().toLowerCase().replace(/[^a-z]+/g, '_'), accent),
      /** A pack's `badge` / `description` from the pricing config, while it is still the seeded English line. */
      packText: (text: string): string => {
        if (english) return text;
        const sources = messages.en.wizard.w7.packCopy as Record<string, string>;
        const key = Object.keys(sources).find((k) => sources[k] === text);
        return key ? (messages[locale].wizard.w7.packCopy as Record<string, string>)[key] ?? text : text;
      },
      /** `GET /numbers/forwarding-guide`, line by line, wherever the server's line is still the English source. */
      forwardingGuide: (guide: ForwardingGuide): Guide => {
        if (english) return guide;
        const all = messages.en.wizard.w6.guide.content as Record<string, Guide>;
        const src = all[guide.carrier];
        const dst = (messages[locale].wizard.w6.guide.content as Record<string, Guide>)[guide.carrier];
        const newNumber = { en: messages.en.wizard.w6.guide.yourNewNumber, here: messages[locale].wizard.w6.guide.yourNewNumber };
        const rtl = localeDirection(locale) === 'rtl';
        const line = (field: keyof Guide) => (text: string, i: number) => {
          const source = src?.[field]?.[i];
          const target = dst?.[field]?.[i];
          const m = source && target ? matchSource(text, source) : null;
          if (!m || !target) return text;
          if (m.destination === null) return target;
          const d = m.destination === newNumber.en ? newNumber.here : rtl ? `\u2066${m.destination}\u2069` : m.destination;
          return target.replaceAll(DEST, d);
        };
        return { steps: guide.steps.map(line('steps')), disable_steps: guide.disable_steps.map(line('disable_steps')), notes: guide.notes.map(line('notes')) };
      },
    };
  }, [locale, tc, tf, tl, tv]);
}
