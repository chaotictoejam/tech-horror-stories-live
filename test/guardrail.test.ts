import { describe, expect, it } from 'vitest';
import { friendlyPlaceholders } from '../src/shared/guardrail.js';

describe('friendlyPlaceholders', () => {
  it('maps guardrail placeholders to board text', () => {
    expect(friendlyPlaceholders('{NAME} hit {URL} from {IpAddress} with {ApiToken}')).toBe('[name] hit [link] from [ip] with [token]');
  });

  it('collapses a span masked by two detectors', () => {
    expect(friendlyPlaceholders('cache at {IP_ADDRESS}{IpAddress}, db at {IpAddress}')).toBe('cache at [ip], db at [ip]');
  });

  it('keeps separate placeholders that are not adjacent', () => {
    expect(friendlyPlaceholders('{NAME} and {NAME}')).toBe('[name] and [name]');
  });

  it('falls back for unknown placeholders', () => {
    expect(friendlyPlaceholders('{SOMETHING_NEW}')).toBe('[redacted]');
  });
});
