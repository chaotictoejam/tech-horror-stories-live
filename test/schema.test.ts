import { describe, expect, it } from 'vitest';
import { extractJson, stripDashes, validateClassification } from '../src/shared/schema.js';

const good = {
  category: 'friday_deploy',
  fear_level: 8,
  root_cause: 'Deployed at 4:55 on Friday',
  survivable: true,
  one_liner: 'Engineer discovers weekends are optional',
};

describe('validateClassification', () => {
  it('accepts a valid object', () => {
    const r = validateClassification(JSON.stringify(good));
    expect(r.ok).toBe(true);
  });

  it('accepts JSON wrapped in fences and prose', () => {
    const r = validateClassification('Sure!\n```json\n' + JSON.stringify(good) + '\n```');
    expect(r.ok).toBe(true);
  });

  it('rejects unknown categories', () => {
    const r = validateClassification(JSON.stringify({ ...good, category: 'kubernetes' }));
    expect(r.ok).toBe(false);
  });

  it.each([0, 11, 7.5, '8'])('rejects fear_level %s', (fear) => {
    expect(validateClassification(JSON.stringify({ ...good, fear_level: fear })).ok).toBe(false);
  });

  it('rejects a root_cause over 8 words', () => {
    const r = validateClassification(JSON.stringify({ ...good, root_cause: 'one two three four five six seven eight nine' }));
    expect(r.ok).toBe(false);
  });

  it('rejects a one_liner over 12 words', () => {
    const r = validateClassification(JSON.stringify({ ...good, one_liner: Array(13).fill('word').join(' ') }));
    expect(r.ok).toBe(false);
  });

  it('rejects extra keys so story text cannot extend the schema', () => {
    const r = validateClassification(JSON.stringify({ ...good, admin: true }));
    expect(r.ok).toBe(false);
  });

  it('rejects missing keys', () => {
    const { survivable: _, ...rest } = good;
    expect(validateClassification(JSON.stringify(rest)).ok).toBe(false);
  });

  it('rejects non-JSON', () => {
    const r = validateClassification('I refuse to classify this.');
    expect(r).toEqual({ ok: false, error: expect.stringContaining('unparseable') });
  });

  it('strips em dashes from text fields', () => {
    const r = validateClassification(JSON.stringify({ ...good, one_liner: 'Backups existed \u2014 in theory' }));
    expect(r.ok && r.data.one_liner).toBe('Backups existed - in theory');
  });
});

describe('helpers', () => {
  it('extractJson throws without an object', () => {
    expect(() => extractJson('nope')).toThrow();
  });
  it('stripDashes handles en dashes', () => {
    expect(stripDashes('a\u2013b')).toBe('a - b');
  });
});
