import { describe, expect, it } from 'vitest';
import { brief, briefPatch } from './agents';
import {
  GUIDED_ANSWER_MAX_CHARS,
  GUIDED_BRIEF_FIELDS,
  GUIDED_QUESTIONS,
  GUIDED_QUESTION_FIELDS,
  answeredQuestions,
  applyBriefAnswers,
  briefFromAnswersRequest,
  emptyBriefFields,
  modelBriefPatch,
  repairModelBrief,
} from './brief-answers';

const ALL = [...GUIDED_QUESTIONS];

describe('guided questions (ADR 0047)', () => {
  it('asks the eight topics in a fixed order', () => {
    expect(GUIDED_QUESTIONS).toEqual(['business', 'role', 'hours', 'services', 'pricing', 'restrictions', 'handoff', 'extra']);
  });

  it('maps every question to brief fields that exist, and no field to two questions', () => {
    const briefFields = Object.keys(brief.shape);
    for (const id of GUIDED_QUESTIONS) {
      expect(GUIDED_QUESTION_FIELDS[id].length).toBeGreaterThan(0);
      for (const field of GUIDED_QUESTION_FIELDS[id]) expect(briefFields).toContain(field);
    }
    expect(new Set(GUIDED_BRIEF_FIELDS).size).toBe(GUIDED_BRIEF_FIELDS.length);
  });

  it('leaves the fields no question asks about out of reach', () => {
    for (const field of ['personality', 'ai_disclosure', 'documents']) expect(GUIDED_BRIEF_FIELDS).not.toContain(field);
  });

  it('reads the address from the business answer, the agent name from the role answer and FAQs from the last one', () => {
    expect(GUIDED_QUESTION_FIELDS.business).toEqual(['about_business', 'address']);
    expect(GUIDED_QUESTION_FIELDS.role).toEqual(['goal', 'agent_name']);
    expect(GUIDED_QUESTION_FIELDS.extra).toEqual(['anything_else', 'faqs']);
  });
});

describe('answeredQuestions and the request', () => {
  it('counts only answers with text, in asking order', () => {
    expect(answeredQuestions({ pricing: 'From $80', business: ' A bakery ', hours: '   ', role: '' })).toEqual(['business', 'pricing']);
  });

  it('accepts one answer and refuses none, blank ones, an unknown question and an over-long answer', () => {
    expect(briefFromAnswersRequest.safeParse({ answers: { business: 'A bakery in Laval.' } }).success).toBe(true);
    expect(briefFromAnswersRequest.safeParse({ answers: {} }).success).toBe(false);
    expect(briefFromAnswersRequest.safeParse({ answers: { business: '  ', role: '' } }).success).toBe(false);
    expect(briefFromAnswersRequest.safeParse({ answers: { favourite_colour: 'blue' } }).success).toBe(false);
    expect(briefFromAnswersRequest.safeParse({ answers: { business: 'x'.repeat(GUIDED_ANSWER_MAX_CHARS + 1) } }).success).toBe(false);
  });
});

describe('repairModelBrief: what a model returned, made safe', () => {
  it('keeps only the fields of answered questions', () => {
    const raw = { about_business: 'A bakery.', goal: 'Take orders.', pricing: 'From $4.', agent_name: 'Sam', ai_disclosure: 'always' };
    expect(repairModelBrief(raw, { answered: ['business'] })).toEqual({ about_business: 'A bakery.' });
  });

  it('never returns an empty value, so a patch cannot clear a field', () => {
    const raw = { about_business: '   ', goal: null, services: [], never_do_presets: [], handoff_rules: [], business_hours: { days: {} }, pricing: '' };
    expect(repairModelBrief(raw, { answered: ALL })).toEqual({});
  });

  it('answers {} for anything that is not an object', () => {
    for (const raw of [null, undefined, 'text', 42, ['about_business']]) expect(repairModelBrief(raw, { answered: ALL })).toEqual({});
  });

  it('trims text and cuts it to the field limit', () => {
    const out = repairModelBrief({ about_business: `  ${'a'.repeat(1_200)}  `, pricing: 'p'.repeat(600) }, { answered: ALL });
    expect((out.about_business as string).length).toBe(1_000);
    expect((out.pricing as string).length).toBe(500);
  });

  it('cleans the services list: trimmed, no blanks, no repeats, 60 characters, 30 items', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Service ${i}`);
    const out = repairModelBrief({ services: [' Cleanings ', 'cleanings', '', 7, 'x'.repeat(80), ...many] }, { answered: ['services'] });
    const services = out.services as string[];
    expect(services.slice(0, 2)).toEqual(['Cleanings', 'x'.repeat(60)]);
    expect(services).toHaveLength(30);
  });

  it('keeps known never-do presets only', () => {
    const out = repairModelBrief({ never_do_presets: ['no_prices', 'no_prices', 'no_refunds'] }, { answered: ['restrictions'] });
    expect(out.never_do_presets).toEqual(['no_prices']);
  });

  it('keeps valid opening times, drops bad ones, and settles an overlap on the first opening', () => {
    const raw = {
      business_hours: {
        timezone: 'Mars/Olympus',
        days: {
          mon: [{ open: '09:00', close: '17:00' }],
          tue: [{ open: '9am', close: '5pm' }],
          wed: [{ open: '09:00', close: '13:00' }, { open: '12:00', close: '18:00' }],
          someday: [{ open: '09:00', close: '17:00' }],
        },
      },
    };
    expect(repairModelBrief(raw, { answered: ['hours'] }).business_hours).toEqual({
      days: { mon: [{ open: '09:00', close: '17:00' }], wed: [{ open: '09:00', close: '13:00' }] },
    });
  });

  it('reads hours given as a list of days, in any order, into the week', () => {
    const raw = {
      business_hours: [
        { day: 'sat', open: '09:00', close: '21:00' },
        { day: 'sun', open: '09:00', close: '21:00' },
        { day: 'mon', open: '09:00', close: '12:00' },
        { day: 'mon', open: '13:00', close: '21:00' },
        { day: 'funday', open: '09:00', close: '21:00' },
        { day: 'tue', open: '25:00', close: '21:00' },
        'wednesday',
      ],
    };
    expect(repairModelBrief(raw, { answered: ['hours'] }).business_hours).toEqual({
      days: {
        mon: [{ open: '09:00', close: '12:00' }, { open: '13:00', close: '21:00' }],
        sat: [{ open: '09:00', close: '21:00' }],
        sun: [{ open: '09:00', close: '21:00' }],
      },
    });
    expect(repairModelBrief({ business_hours: [] }, { answered: ['hours'] })).toEqual({});
    expect(repairModelBrief({ business_hours: 'nine to five' }, { answered: ['hours'] })).toEqual({});
  });

  it('turns a transfer with no dialable number into "take a message"', () => {
    const raw = { handoff_rules: [{ condition: 'The caller asks for the owner', action: 'transfer', transfer_number: 'the front desk' }] };
    expect(repairModelBrief(raw, { answered: ['handoff'], country: 'CA' }).handoff_rules).toEqual([{ condition: 'The caller asks for the owner', action: 'take_message' }]);
  });

  it('reads a number said with its country code, or as a national number of the workspace country', () => {
    const rule = (transfer_number: string) => ({ handoff_rules: [{ condition: 'An emergency', action: 'transfer', transfer_number }] });
    const number = (raw: unknown, country?: string) => (repairModelBrief(raw, { answered: ['handoff'], country }).handoff_rules as Array<{ transfer_number?: string }>)[0]?.transfer_number;
    expect(number(rule('+1 (416) 555-0134'))).toBe('+14165550134');
    expect(number(rule('416 555 0134'), 'CA')).toBe('+14165550134');
    expect(number(rule('416 555 0134'))).toBeUndefined();
    // A wrong number that carries a plus is not re-read as national.
    expect(number(rule('+4165550134'), 'CA')).toBeUndefined();
  });

  it('keeps a read-a-message rule only with its words, and at most five rules with a condition', () => {
    const raw = {
      handoff_rules: [
        { condition: 'Closed', action: 'read_message', message: ' We are closed. ' },
        { condition: 'Closed again', action: 'read_message' },
        { condition: '', action: 'take_message' },
        { action: 'take_message' },
        { condition: 'Odd action', action: 'escalate' },
        ...Array.from({ length: 6 }, (_, i) => ({ condition: `Case ${i}`, action: 'take_message' })),
      ],
    };
    const rules = repairModelBrief(raw, { answered: ['handoff'] }).handoff_rules as Array<Record<string, unknown>>;
    expect(rules).toHaveLength(5);
    expect(rules[0]).toEqual({ condition: 'Closed', action: 'read_message', message: 'We are closed.' });
    expect(rules[1]).toEqual({ condition: 'Closed again', action: 'take_message' });
    expect(rules[2]).toEqual({ condition: 'Odd action', action: 'take_message' });
  });
});

describe('modelBriefPatch: the gate is the existing briefPatch', () => {
  it('returns a value briefPatch accepts', () => {
    const gate = modelBriefPatch({ answered: ALL, country: 'US' });
    const parsed = gate.parse({
      about_business: 'We are a dental practice in Austin.',
      goal: 'Book check-ups and take messages.',
      business_hours: { days: { mon: [{ open: '08:00', close: '16:00' }] } },
      services: ['Check-ups'],
      never_do_presets: ['no_medical_advice'],
      handoff_rules: [{ condition: 'An emergency', action: 'transfer', transfer_number: '512 555 0199' }],
    });
    expect(briefPatch.safeParse(parsed).success).toBe(true);
    expect(parsed.handoff_rules?.[0]?.transfer_number).toBe('+15125550199');
    expect(parsed.business_hours?.closed_dates).toEqual([]);
  });

  it('refuses an answer that is not an object', () => {
    const gate = modelBriefPatch({ answered: ALL });
    expect(gate.safeParse('about_business: a bakery').success).toBe(false);
    expect(gate.safeParse(null).success).toBe(false);
    expect(gate.safeParse([{ about_business: 'A bakery' }]).success).toBe(false);
  });

  it('leaves an unanswered list absent rather than defaulted to empty', () => {
    const parsed = modelBriefPatch({ answered: ['business'] }).parse({ about_business: 'A bakery.' });
    expect(Object.keys(parsed)).toEqual(['about_business']);
  });
});

describe('applyBriefAnswers: the patch laid over the brief on the screen', () => {
  const current = brief.parse({
    about_business: 'We are a family dental practice in Toronto.',
    goal: 'Book appointments.',
    agent_name: 'Sophie',
    address: '12 King St W',
    services: ['Check-ups', 'Fillings'],
    never_do_presets: ['no_prices'],
    handoff_rules: [{ condition: 'An emergency', action: 'transfer', transfer_number: '+14165550101' }],
    business_hours: { timezone: 'America/Toronto', days: { mon: [{ open: '09:00', close: '17:00' }] }, closed_dates: ['2026-12-25'] },
    faqs: [{ question: 'Do you take walk-ins?', answer: 'Yes, before noon.' }],
    documents: [{ name: 'Prices', content_type: 'text/plain', text: 'Cleaning $150' }],
  });

  it('changes nothing for an empty patch', () => {
    expect(applyBriefAnswers(current, {})).toEqual({ brief: current, changed: [], added: { faqs: [], services: [], handoff_rules: [] } });
  });

  it('replaces answered text and leaves every other field as it was', () => {
    const { brief: next, changed } = applyBriefAnswers(current, { goal: 'Book appointments and answer price questions.', pricing: 'Cleanings from $150.' });
    expect(changed).toEqual(['goal', 'pricing']);
    expect(next.goal).toBe('Book appointments and answer price questions.');
    expect(next.pricing).toBe('Cleanings from $150.');
    for (const field of ['about_business', 'agent_name', 'address', 'services', 'handoff_rules', 'business_hours', 'faqs', 'documents', 'ai_disclosure'] as const) {
      expect(next[field]).toEqual(current[field]);
    }
  });

  it('ignores null, blank text and empty lists in a patch', () => {
    const { brief: next, changed } = applyBriefAnswers(current, { about_business: null, goal: '   ', services: [], handoff_rules: [], never_do_presets: [] });
    expect(changed).toEqual([]);
    expect(next).toEqual(current);
  });

  it('adds to the lists instead of replacing them, without repeats', () => {
    const { brief: next } = applyBriefAnswers(current, {
      services: ['fillings', 'Whitening'],
      never_do_presets: ['no_prices', 'no_time_promises'],
      handoff_rules: [
        { condition: 'an emergency', action: 'take_message' },
        { condition: 'The caller asks for billing', action: 'take_message' },
      ],
    });
    expect(next.services).toEqual(['Check-ups', 'Fillings', 'Whitening']);
    expect(next.never_do_presets).toEqual(['no_prices', 'no_time_promises']);
    expect(next.handoff_rules).toEqual([
      { condition: 'An emergency', action: 'transfer', transfer_number: '+14165550101' },
      { condition: 'The caller asks for billing', action: 'take_message' },
    ]);
  });

  it('never grows a list past its limit', () => {
    const full = brief.parse({ ...current, handoff_rules: Array.from({ length: 5 }, (_, i) => ({ condition: `Case ${i}`, action: 'take_message' })) });
    const { brief: next, changed } = applyBriefAnswers(full, { handoff_rules: [{ condition: 'One more', action: 'take_message' }] });
    expect(next.handoff_rules).toHaveLength(5);
    expect(changed).toEqual([]);
  });

  it('sets the days the answer named, keeps the others, the time zone and the closed dates', () => {
    const { brief: next, changed } = applyBriefAnswers(current, { business_hours: { days: { sat: [{ open: '10:00', close: '14:00' }], mon: [{ open: '08:00', close: '16:00' }] }, closed_dates: [] } });
    expect(changed).toEqual(['business_hours']);
    expect(next.business_hours).toEqual({ timezone: 'America/Toronto', days: { mon: [{ open: '08:00', close: '16:00' }], sat: [{ open: '10:00', close: '14:00' }] }, closed_dates: ['2026-12-25'] });
    expect(Object.keys(next.business_hours!.days)).toEqual(['mon', 'sat']);

    const partial = applyBriefAnswers(current, { business_hours: { days: { sat: [{ open: '10:00', close: '14:00' }] }, closed_dates: [] } });
    expect(partial.brief.business_hours!.days).toEqual({ mon: [{ open: '09:00', close: '17:00' }], sat: [{ open: '10:00', close: '14:00' }] });
  });

  it('reports the list items it added', () => {
    const { added } = applyBriefAnswers(current, {
      services: ['fillings', 'Whitening'],
      faqs: [{ question: 'Do you take walk-ins?', answer: 'Sometimes.' }, { question: 'Is there parking?', answer: 'Yes, behind the building.' }],
      handoff_rules: [{ condition: 'The caller asks for billing', action: 'take_message' }],
    });
    expect(added).toEqual({
      services: ['Whitening'],
      faqs: [{ question: 'Is there parking?', answer: 'Yes, behind the building.' }],
      handoff_rules: [{ condition: 'The caller asks for billing', action: 'take_message' }],
    });
  });

  it('sending the answers again replaces what the last apply added, reworded or not', () => {
    const first = applyBriefAnswers(current, {
      services: ['Whitening'],
      faqs: [{ question: 'Is there parking?', answer: 'Yes, behind the building.' }],
      handoff_rules: [{ condition: 'The caller says it is an emergency', action: 'take_message' }],
    });
    const second = applyBriefAnswers(
      first.brief,
      {
        services: ['Teeth whitening'],
        faqs: [{ question: 'Can I park there?', answer: 'Yes, behind the building.' }],
        handoff_rules: [{ condition: 'The caller has an emergency', action: 'take_message' }],
      },
      first.added,
    );
    expect(second.brief.services).toEqual(['Check-ups', 'Fillings', 'Teeth whitening']);
    expect(second.brief.faqs).toEqual([...current.faqs, { question: 'Can I park there?', answer: 'Yes, behind the building.' }]);
    expect(second.brief.handoff_rules).toEqual([...current.handoff_rules, { condition: 'The caller has an emergency', action: 'take_message' }]);
  });

  it('keeps an added item the customer has edited since', () => {
    const first = applyBriefAnswers(current, { handoff_rules: [{ condition: 'The caller asks for billing', action: 'take_message' }] });
    const edited = { ...first.brief, handoff_rules: [first.brief.handoff_rules[0]!, { condition: 'The caller asks for billing', action: 'transfer' as const, transfer_number: '+14165550199' }] };
    const second = applyBriefAnswers(edited, { handoff_rules: [{ condition: 'A billing question', action: 'take_message' }] }, first.added);
    expect(second.brief.handoff_rules).toHaveLength(3);
    expect(second.brief.handoff_rules[1]).toEqual(edited.handoff_rules[1]);
  });

  it('keeps a row the customer is still typing in the form', () => {
    const typing = { ...current, handoff_rules: [...current.handoff_rules, { condition: '', action: 'transfer' }] } as unknown as typeof current;
    const { brief: next } = applyBriefAnswers(typing, { handoff_rules: [{ condition: 'The caller asks for billing', action: 'take_message' }], pricing: 'From $150.' });
    expect(next.handoff_rules).toHaveLength(3);
    expect(next.handoff_rules[1]).toEqual({ condition: '', action: 'transfer' });
    expect(next.pricing).toBe('From $150.');
  });

  it('fills an empty brief', () => {
    const { brief: next, changed } = applyBriefAnswers(brief.parse({}), { about_business: 'A bakery in Laval.', services: ['Bread'], business_hours: { days: { mon: [{ open: '07:00', close: '15:00' }] }, closed_dates: [] } });
    expect(changed).toEqual(['about_business', 'business_hours', 'services']);
    expect(next.business_hours).toEqual({ days: { mon: [{ open: '07:00', close: '15:00' }] }, closed_dates: [] });
  });
});

describe('address, agent name and FAQs from the answers', () => {
  const raw = {
    address: '  12 King Street West, Toronto  ',
    agent_name: ' Maya ',
    faqs: [
      { question: 'Do you take walk-ins?', answer: 'Yes, before noon.' },
      { question: 'do you take walk-ins?', answer: 'Repeated.' },
      { question: 'Is there parking?', answer: '' },
      { question: '', answer: 'An answer with no question.' },
      'not a pair',
    ],
  };

  it('keeps each one only when its question was answered', () => {
    expect(repairModelBrief(raw, { answered: ['hours'] })).toEqual({});
    expect(repairModelBrief(raw, { answered: ['business'] })).toEqual({ address: '12 King Street West, Toronto' });
    expect(repairModelBrief(raw, { answered: ['role'] })).toEqual({ agent_name: 'Maya' });
    expect(repairModelBrief(raw, { answered: ['extra'] })).toEqual({ faqs: [{ question: 'Do you take walk-ins?', answer: 'Yes, before noon.' }] });
  });

  it('drops an agent name that is too short or too long instead of cutting it', () => {
    for (const agent_name of ['M', '', '   ', 'x'.repeat(31), 42, null]) expect(repairModelBrief({ agent_name }, { answered: ['role'] })).toEqual({});
    expect(repairModelBrief({ agent_name: 'x'.repeat(30) }, { answered: ['role'] })).toEqual({ agent_name: 'x'.repeat(30) });
  });

  it('cuts an address and an FAQ to their limits and stops at twenty pairs', () => {
    const out = repairModelBrief(
      { address: 'a'.repeat(250), faqs: Array.from({ length: 25 }, (_, i) => ({ question: `Question ${i}? ${'q'.repeat(400)}`, answer: 'a'.repeat(1_200) })) },
      { answered: ['business', 'extra'] },
    );
    expect((out.address as string).length).toBe(200);
    const faqs = out.faqs as Array<{ question: string; answer: string }>;
    expect(faqs).toHaveLength(20);
    expect(faqs[0]!.question.length).toBe(300);
    expect(faqs[0]!.answer.length).toBe(1_000);
  });

  it('passes the brief gate', () => {
    const parsed = modelBriefPatch({ answered: ALL }).parse(raw);
    expect(briefPatch.parse(parsed)).toEqual(parsed);
    expect(parsed.agent_name).toBe('Maya');
  });

  it('replaces the address and the name, and adds FAQs without repeating a question', () => {
    const current = brief.parse({ address: 'Old address', agent_name: 'Sam', faqs: [{ question: 'Do you take walk-ins?', answer: 'Yes.' }] });
    const { brief: next, changed } = applyBriefAnswers(current, {
      address: '12 King Street West',
      agent_name: 'Maya',
      faqs: [
        { question: 'do you take walk-ins?', answer: 'Different.' },
        { question: 'Is there parking?', answer: 'Behind the building.' },
      ],
    });
    expect(changed).toEqual(['address', 'agent_name', 'faqs']);
    expect(next.address).toBe('12 King Street West');
    expect(next.agent_name).toBe('Maya');
    expect(next.faqs).toEqual([
      { question: 'Do you take walk-ins?', answer: 'Yes.' },
      { question: 'Is there parking?', answer: 'Behind the building.' },
    ]);
  });

  it('keeps an FAQ row still being typed and never passes twenty', () => {
    const typing = { ...brief.parse({}), faqs: [{ question: '', answer: '' }] } as ReturnType<typeof brief.parse>;
    expect(applyBriefAnswers(typing, { faqs: [{ question: 'Is there parking?', answer: 'Yes.' }] }).brief.faqs).toEqual([
      { question: '', answer: '' },
      { question: 'Is there parking?', answer: 'Yes.' },
    ]);
    const full = brief.parse({ faqs: Array.from({ length: 20 }, (_, i) => ({ question: `Q${i}`, answer: 'A' })) });
    const { brief: next, changed } = applyBriefAnswers(full, { faqs: [{ question: 'One more?', answer: 'No room.' }] });
    expect(next.faqs).toHaveLength(20);
    expect(changed).toEqual([]);
  });
});

describe('emptyBriefFields', () => {
  it('names every field of an untouched brief, in form order', () => {
    expect(emptyBriefFields(brief.parse({}))).toEqual(['about_business', 'goal', 'agent_name', 'business_hours', 'address', 'services', 'pricing', 'faqs', 'anything_else', 'never_do', 'handoff_rules']);
  });

  it('names nothing for a full brief', () => {
    const full = brief.parse({
      about_business: 'A dental clinic in Toronto.',
      goal: 'Book appointments for callers.',
      agent_name: 'Maya',
      business_hours: { days: { mon: [{ open: '09:00', close: '17:00' }] }, closed_dates: [] },
      address: '12 King Street West',
      services: ['Check-ups'],
      pricing: 'From $150.',
      faqs: [{ question: 'Parking?', answer: 'Yes.' }],
      anything_else: 'Closed on holidays.',
      never_do: 'Never diagnose.',
      handoff_rules: [{ condition: 'An emergency', action: 'take_message' }],
    });
    expect(emptyBriefFields(full)).toEqual([]);
  });

  it('counts a field as filled by either half it is shown with', () => {
    expect(emptyBriefFields(brief.parse({ services_notes: 'We also do house calls.' }))).not.toContain('services');
    expect(emptyBriefFields(brief.parse({ never_do_presets: ['no_prices'] }))).not.toContain('never_do');
  });

  it('does not count blank text, a week with no openings or a row still being typed', () => {
    const blank = { ...brief.parse({}), address: '   ', business_hours: { days: { mon: [] }, closed_dates: [] }, faqs: [{ question: '', answer: '' }], handoff_rules: [{ condition: ' ', action: 'take_message' }] } as unknown as ReturnType<typeof brief.parse>;
    expect(emptyBriefFields(blank)).toEqual(expect.arrayContaining(['address', 'business_hours', 'faqs', 'handoff_rules']));
  });
});
