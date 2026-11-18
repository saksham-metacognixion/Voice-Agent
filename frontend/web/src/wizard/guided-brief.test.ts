import { GUIDED_ANSWER_MAX_CHARS, GUIDED_QUESTIONS, briefFromAnswersRequest } from '@portal/schemas';
import { describe, expect, it } from 'vitest';
import { messages } from '../i18n';
import { GUIDED_TOTAL, addTranscript, answersToSend, guidedModes, loadAnswers, resumeIndex, saveAnswers, withAnswer } from './guided-brief';

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('the guided questions on W2 (ADR 0047)', () => {
  it('asks eight questions', () => {
    expect(GUIDED_TOTAL).toBe(8);
  });

  it('has a label, a question and a hint for every question in English, Arabic and Québec French', () => {
    for (const locale of ['en', 'ar', 'fr-CA'] as const) {
      const copy = messages[locale].wizard.w2.guided.questions as Record<string, { label: string; title: string; hint: string }>;
      expect(Object.keys(copy).sort()).toEqual([...GUIDED_QUESTIONS].sort());
      for (const id of GUIDED_QUESTIONS) {
        for (const part of ['label', 'title', 'hint'] as const) expect(copy[id]![part].trim().length, `${locale} ${id}.${part}`).toBeGreaterThan(3);
      }
    }
  });

  it('offers Speak and Type where the browser can listen, Type alone where it cannot', () => {
    expect(guidedModes(true)).toEqual(['speak', 'type']);
    expect(guidedModes(false)).toEqual(['type']);
  });
});

describe('answers while they are given', () => {
  it('changes one answer and keeps the others', () => {
    const answers = withAnswer({ business: 'A bakery.', hours: '9 to 5' }, 'hours', '8 to 6');
    expect(answers).toEqual({ business: 'A bakery.', hours: '8 to 6' });
  });

  it('cuts an answer at the limit instead of refusing it', () => {
    expect(withAnswer({}, 'extra', 'x'.repeat(GUIDED_ANSWER_MAX_CHARS + 50)).extra).toHaveLength(GUIDED_ANSWER_MAX_CHARS);
  });

  it('sends trimmed answers and leaves blank or skipped questions out', () => {
    const sent = answersToSend({ business: '  A bakery in Laval. ', role: '   ', hours: '', pricing: 'From $4' });
    expect(sent).toEqual({ business: 'A bakery in Laval.', pricing: 'From $4' });
    expect(briefFromAnswersRequest.safeParse({ answers: sent }).success).toBe(true);
  });

  it('typed and spoken answers produce the same request', () => {
    const typed = withAnswer({}, 'business', 'We are a bakery in Laval.');
    const spoken = withAnswer({}, 'business', addTranscript(addTranscript('', 'we are a bakery'), 'in Laval.'));
    expect(answersToSend(spoken)).toEqual(answersToSend(typed));
  });

  it('opens on the first unanswered question, or the last when all are answered', () => {
    expect(resumeIndex({})).toBe(0);
    expect(resumeIndex({ business: 'x', role: 'y' })).toBe(2);
    expect(resumeIndex({ business: 'x', hours: 'z' })).toBe(1);
    expect(resumeIndex(Object.fromEntries(GUIDED_QUESTIONS.map((id) => [id, 'x'])))).toBe(7);
  });
});

describe('addTranscript: a recognised phrase joins the answer', () => {
  it('starts the answer with a capital and tidies the spacing', () => {
    expect(addTranscript('', '  we are   open every day ')).toBe('We are open every day');
  });

  it('adds a phrase after a space, lower case mid-sentence and capitalised after a full stop', () => {
    expect(addTranscript('We are open', 'every day')).toBe('We are open every day');
    expect(addTranscript('We are open. ', 'closed on holidays')).toBe('We are open. Closed on holidays');
  });

  it('keeps what the customer typed or corrected before speaking again', () => {
    expect(addTranscript('Mon to Fri, 9 to 5 (edited)', 'saturday ten to two')).toBe('Mon to Fri, 9 to 5 (edited) saturday ten to two');
  });

  it('leaves the answer alone when nothing was heard', () => {
    expect(addTranscript('We are open', '   ')).toBe('We are open');
  });

  it('joins Arabic and accented French as they are', () => {
    expect(addTranscript('نحن عيادة أسنان', 'في الرياض')).toBe('نحن عيادة أسنان في الرياض');
    expect(addTranscript('', 'écoutez, on ouvre à 7 h')).toBe('Écoutez, on ouvre à 7 h');
    expect(addTranscript('هل أنتم مفتوحون؟', 'نعم')).toBe('هل أنتم مفتوحون؟ نعم');
  });

  it('never grows past the answer limit', () => {
    expect(addTranscript('x'.repeat(GUIDED_ANSWER_MAX_CHARS - 3), 'and more words')).toHaveLength(GUIDED_ANSWER_MAX_CHARS);
  });
});

describe('answers survive a reload, per agent', () => {
  it('round-trips through storage and is kept apart per agent', () => {
    const store = memoryStore();
    saveAnswers(store, 'agent-1', { business: 'A bakery.', hours: '' });
    expect(loadAnswers(store, 'agent-1')).toEqual({ business: 'A bakery.', hours: '' });
    expect(loadAnswers(store, 'agent-2')).toEqual({});
  });

  it('forgets the entry once nothing is answered', () => {
    const store = memoryStore();
    saveAnswers(store, 'agent-1', { business: 'A bakery.' });
    saveAnswers(store, 'agent-1', { business: '  ' });
    expect(store.data.size).toBe(0);
  });

  it('reads damaged, foreign or missing storage as no answers', () => {
    expect(loadAnswers(memoryStore({ 'portal:guided-brief:a': '{not json' }), 'a')).toEqual({});
    expect(loadAnswers(memoryStore({ 'portal:guided-brief:a': '{"shoe_size":"42"}' }), 'a')).toEqual({});
    expect(loadAnswers(null, 'a')).toEqual({});
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined };
    expect(loadAnswers(broken, 'a')).toEqual({});
    expect(() => saveAnswers(broken, 'a', { business: 'x' })).not.toThrow();
  });
});
