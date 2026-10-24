/**
 * Tests for file-operation utilities: format/language detection and line counting.
 */

import { describe, it, expect } from 'vitest';
import { countContentLines } from '../file-operations.js';

describe('countContentLines', () => {
  it('counts lines with no trailing newline', () => {
    expect(countContentLines('a\nb\nc')).toBe(3);
  });

  it('does not count a trailing newline as an extra line', () => {
    expect(countContentLines('a\nb\nc\n')).toBe(3);
  });

  it('returns 0 for empty content', () => {
    expect(countContentLines('')).toBe(0);
  });

  it('counts a single line with no newline as 1', () => {
    expect(countContentLines('a')).toBe(1);
  });

  it('counts content that is only a newline as 1 (one blank line)', () => {
    expect(countContentLines('\n')).toBe(1);
  });

  it('counts a blank line in the middle', () => {
    expect(countContentLines('a\n\nb')).toBe(3);
  });

  it('treats a CRLF-terminated file the same as an LF-terminated one', () => {
    expect(countContentLines('a\r\nb\r\nc\r\n')).toBe(3);
    expect(countContentLines('a\r\nb\r\nc')).toBe(3);
  });
});
