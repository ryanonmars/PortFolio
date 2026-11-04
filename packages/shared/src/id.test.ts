import { afterEach, expect, it, vi } from 'vitest';
import { randomId } from './id.js';

afterEach(() => vi.unstubAllGlobals());

it('generates distinct v4 IDs with native browser crypto', () => {
  const ids = Array.from({ length: 1000 }, () => randomId());
  expect(new Set(ids).size).toBe(1000);
  for (const id of ids)
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
});

it.each([
  [0x00, '00000000-0000-4000-8000-000000000000'],
  [0xff, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
  [0x55, '55555555-5555-4555-9555-555555555555'],
  [0xaa, 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'],
])(
  'sets UUID version and variant while retaining random bytes %i on HTTP',
  (byte, expected) => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(byte),
    });
    expect(randomId()).toBe(expected);
  },
);
