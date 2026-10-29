import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createOriginPolicy } from './origin-policy.js';
import { publicTlds } from './public-tlds.js';

describe('incoming LAN origin policy', () => {
  const automatic = () => createOriginPolicy({});

  it('preserves the complete upstream root-zone snapshot without wrapping inside names', () => {
    const upstream =
      '# Version 2026102900, Last Updated Thu Oct 29 07:07:01 2026 UTC\n' +
      [...publicTlds].map((name) => name.toUpperCase()).join('\n') +
      '\n';
    expect(publicTlds.size).toBe(1436);
    expect(createHash('sha256').update(upstream).digest('hex')).toBe(
      '7457ff18c19355e47aa65a49a24210bf2c33bb9bece630471e8f93e7e5802613',
    );
  });

  it('rejects an untrusted hostname under every delegated public TLD', () => {
    const policy = automatic();
    for (const tld of publicTlds)
      expect(policy.originFor(`rebinding.${tld}:3088`), tld).toBeNull();
  });

  it.each([
    'localhost:3088',
    '127.0.0.1:3088',
    '127.255.255.254:8080',
    '10.0.0.1:3088',
    '172.16.0.1:3088',
    '172.31.255.254:3088',
    '192.168.50.10:3088',
    '169.254.1.20:3088',
    '100.64.0.1:3088',
    '100.127.255.254:3088',
    'truenas:3088',
    'dockge.truenas:3088',
    'nas.home.arpa:3088',
    'portfolio.local:3088',
    'portfolio.lan:3088',
    'portfolio.internal:3088',
    'xn--bcher-kva.truenas:3088',
    '[::1]:3088',
    '[fd12:3456::1]:3088',
    '[fe80::1234]:3088',
    '[::ffff:192.168.1.1]:3088',
    '[::ffff:127.0.0.1]:3088',
  ])('accepts direct local access without a predefined URL: %s', (host) => {
    expect(automatic().originFor(host)).toBe(new URL(`http://${host}`).origin);
  });

  it.each([
    '8.8.8.8:3088',
    '0.0.0.0:3088',
    '172.15.255.255:3088',
    '172.32.0.1:3088',
    '100.63.255.255:3088',
    '100.128.0.1:3088',
    '169.253.1.1:3088',
    '192.169.0.1:3088',
    '[2001:4860:4860::8888]:3088',
    '[::]:3088',
    '[ff02::1]:3088',
    '[::ffff:8.8.8.8]:3088',
    'attacker.example.com:3088',
    'attacker.co.uk:3088',
    'attacker.github.io:3088',
    'attacker.zip:3088',
    'attacker.xn--p1ai:3088',
    'attacker.xn--fiqs8s:3088',
    'attacker.COM.:3088',
    'com:3088',
    'device.attacker.ts.net:3088',
    'service.onion:3088',
    'service.alt:3088',
  ])('does not infer trust for public or alternate namespaces: %s', (host) => {
    expect(automatic().originFor(host)).toBeNull();
  });

  it.each([
    undefined,
    '',
    'localhost:0',
    'localhost:65536',
    'localhost:-1',
    'localhost:not-a-port',
    'localhost:3088:1234',
    'localhost,attacker.example.com',
    ' localhost:3088',
    'localhost:3088 ',
    'localhost:3088/path',
    'localhost:3088?query=1',
    'localhost:3088#fragment',
    'attacker.example.com@localhost:3088',
    'localhost\\@attacker.example.com',
    'local%68ost:3088',
    '-nas.local:3088',
    'nas-.local:3088',
    'nas..local:3088',
    'nas_local:3088',
    '*.local:3088',
    `${'a'.repeat(64)}.local:3088`,
    `${'aa.'.repeat(85)}local:3088`,
    '127.1:3088',
    '2130706433:3088',
    '0x7f000001:3088',
    '0177.0.0.1:3088',
    '1.2.3.999:3088',
    '::1:3088',
    '[fe80::1%25en0]:3088',
    '[not-ipv6]:3088',
  ])('rejects malformed or ambiguous authorities: %s', (host) => {
    expect(automatic().originFor(host)).toBeNull();
  });

  it('normalizes case, trailing DNS root dots and default ports consistently', () => {
    const policy = automatic();
    expect(policy.originFor('DOCKGE.TRUENAS:3088')).toBe(
      'http://dockge.truenas:3088',
    );
    expect(policy.originFor('dockge.truenas.:3088')).toBe(
      'http://dockge.truenas.:3088',
    );
    expect(policy.originFor('localhost:80')).toBe('http://localhost');
    expect(policy.originFor('[0:0:0:0:0:0:0:1]:80')).toBe('http://[::1]');
    expect(policy.originFor('dockge.truenas:443', true)).toBe(
      'https://dockge.truenas',
    );
  });

  it('augments automatic LAN routes with exact configured public and proxy origins', () => {
    const policy = createOriginPolicy({
      publicOrigin: 'https://device.tail12345.ts.net',
      allowedOrigins: [
        'https://portfolio.example.com:8443',
        'http://public.example.com:3088',
      ],
    });
    expect(policy.originFor('dockge.truenas:3088')).toBe(
      'http://dockge.truenas:3088',
    );
    expect(policy.originFor('device.tail12345.ts.net')).toBe(
      'https://device.tail12345.ts.net',
    );
    expect(policy.originFor('device.tail12345.ts.net:443')).toBe(
      'https://device.tail12345.ts.net',
    );
    expect(policy.originFor('portfolio.example.com:8443')).toBe(
      'https://portfolio.example.com:8443',
    );
    expect(policy.originFor('public.example.com:3088')).toBe(
      'http://public.example.com:3088',
    );
    expect(policy.originFor('unlisted.tail12345.ts.net')).toBeNull();
    expect(policy.originFor('portfolio.example.com:8080')).toBeNull();
  });

  it('uses actual TLS for local HTTPS without trusting forwarded protocol hints', () => {
    expect(automatic().originFor('nas.local:3443', true)).toBe(
      'https://nas.local:3443',
    );
    expect(automatic().originFor('nas.local:3443', false)).toBe(
      'http://nas.local:3443',
    );
  });

  it('supports optional strict host restrictions without requiring origin registration', () => {
    const policy = createOriginPolicy({
      trustedHosts: [
        'dockge.truenas',
        '127.0.0.1:3088',
        'portfolio.example.com:8080',
      ],
    });
    expect(policy.originFor('dockge.truenas:3088')).toBe(
      'http://dockge.truenas:3088',
    );
    expect(policy.originFor('DOCKGE.TRUENAS.:8080')).toBe(
      'http://dockge.truenas.:8080',
    );
    expect(policy.originFor('127.0.0.1:3088')).toBe('http://127.0.0.1:3088');
    expect(policy.originFor('portfolio.example.com:8080')).toBe(
      'http://portfolio.example.com:8080',
    );
    expect(policy.originFor('127.0.0.1:3090')).toBeNull();
    expect(policy.originFor('localhost:3088')).toBeNull();
    expect(policy.originFor('other.truenas:3088')).toBeNull();
  });

  it.each([
    { trustedHosts: [] },
    { trustedHosts: [''] },
    { trustedHosts: ['*'] },
    { trustedHosts: ['*.truenas'] },
    { trustedHosts: ['https://nas.local'] },
    { trustedHosts: ['nas.local/path'] },
    { trustedHosts: ['nas.local:0'] },
    {
      publicOrigin: 'https://portfolio.example.com',
      trustedHosts: ['nas.local'],
    },
    { allowedOrigins: ['https://portfolio.example.com/path'] },
    { allowedOrigins: ['https://user:password@portfolio.example.com'] },
    {
      allowedOrigins: [
        'https://portfolio.example.com',
        'http://portfolio.example.com',
      ],
    },
    {
      publicOrigin: 'https://portfolio.example.com',
      allowedOrigins: ['http://portfolio.example.com:443'],
    },
  ])(
    'fails closed for invalid or contradictory deployment configuration: %j',
    (options) => {
      expect(() => createOriginPolicy(options)).toThrow();
    },
  );
});
