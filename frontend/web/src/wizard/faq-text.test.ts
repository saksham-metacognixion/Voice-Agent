import { describe, expect, it } from 'vitest';
import { completeFaqs, faqsAsText } from './faq-text';

/* W2 #7: "Growth+: optionally moved to KB" — the pairs as one text source (ADR 0039 §5). */

describe('faqsAsText', () => {
  it('writes each pair as Q/A with a blank line between pairs', () => {
    expect(
      faqsAsText([
        { question: 'Do you take walk-ins?', answer: 'Yes, but appointments come first.' },
        { question: 'Is there parking?', answer: 'Behind the building.' },
      ]),
    ).toBe('Q: Do you take walk-ins?\nA: Yes, but appointments come first.\n\nQ: Is there parking?\nA: Behind the building.');
  });

  it('trims what was typed', () => {
    expect(faqsAsText([{ question: '  Open Sundays? ', answer: ' No. \n' }])).toBe('Q: Open Sundays?\nA: No.');
  });

  it('leaves out a pair still being typed', () => {
    expect(faqsAsText([{ question: 'Half a question', answer: '  ' }, { question: 'Wi-Fi?', answer: 'Yes.' }])).toBe('Q: Wi-Fi?\nA: Yes.');
  });

  it('is empty for no pairs', () => {
    expect(faqsAsText([])).toBe('');
  });
});

describe('completeFaqs', () => {
  it('keeps only pairs with both halves', () => {
    expect(completeFaqs([{ question: 'A?', answer: '' }, { question: '', answer: 'B' }, { question: 'C?', answer: 'D' }])).toEqual([{ question: 'C?', answer: 'D' }]);
  });
});
