import { describe, expect, it } from 'vitest';
import { cssShadow, xml } from './dom-vector-export.js';

describe('portable board vector serialization', () => {
  it('escapes authored text and attribute delimiters without interpreting markup', () => {
    expect(xml('<script onload="alert(1)">&\'network\'</script>')).toBe(
      '&lt;script onload=&quot;alert(1)&quot;&gt;&amp;&apos;network&apos;&lt;/script&gt;',
    );
  });
  it('removes XML-invalid control characters while retaining newlines and tabs', () => {
    expect(xml('a' + String.fromCharCode(0, 8, 11, 31) + '\n\tb')).toBe(
      'a\n\tb',
    );
  });
  it('reads the live computed outer shadow instead of duplicating its theme values', () => {
    expect(cssShadow('rgba(0, 0, 0, 0.2) 0px 8px 22px 0px')).toEqual({
      color: 'rgba(0, 0, 0, 0.2)',
      x: 0,
      y: 8,
      blur: 22,
      spread: 0,
    });
    expect(cssShadow('rgb(12, 24, 32) -3px 4px 8px')).toEqual({
      color: 'rgb(12, 24, 32)',
      x: -3,
      y: 4,
      blur: 8,
      spread: 0,
    });
    expect(cssShadow('none')).toBeNull();
    expect(cssShadow('inset rgb(0, 0, 0) 0px 2px 4px')).toBeNull();
  });
  it('preserves Unicode network names and addresses', () => {
    expect(xml('管理 — 2001:db8::1 → gateway')).toBe(
      '管理 — 2001:db8::1 → gateway',
    );
  });
});
