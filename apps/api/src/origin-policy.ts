import { isIP } from 'node:net';
import { publicTlds } from './public-tlds.js';

interface Authority {
  hostname: string;
  authority: string;
  port?: number;
}
export interface OriginPolicyOptions {
  publicOrigin?: string;
  localOrigin?: string;
  allowedOrigins?: readonly string[];
  trustedHosts?: readonly string[];
}

function authority(value: string | undefined): Authority | null {
  if (!value || value.length > 320) return null;
  const match = /^(\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(
    value,
  );
  if (!match) return null;
  const raw = match[1]!.toLowerCase();
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  try {
    const url = new URL(`http://${value}`);
    const hostname = url.hostname;
    if (raw.startsWith('[')) {
      if (isIP(raw.slice(1, -1)) !== 6) return null;
    } else {
      // WHATWG URLs accept legacy numeric IP spellings; HTTP Host does not.
      if (isIP(hostname) === 4 && (isIP(raw) !== 4 || raw !== hostname))
        return null;
      const name = raw.replace(/\.$/, '');
      if (
        name.length > 253 ||
        !name
          .split('.')
          .every((label) =>
            /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
          )
      )
        return null;
    }
    return {
      hostname,
      authority: `${hostname}${port === undefined ? '' : `:${port}`}`,
      port,
    };
  } catch {
    return null;
  }
}
const nameOf = (host: Authority) => host.hostname.replace(/\.$/, '');
const keyOf = (host: Authority) =>
  `${nameOf(host)}${host.port === undefined ? '' : `:${host.port}`}`;
function privateIPv4(value: string): boolean {
  const [a, b] = value.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b! >= 64 && b! <= 127)
  );
}
function privateIPv6(value: string): boolean {
  const [left, right] = value.split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const words =
    right === undefined
      ? start.map((word) => parseInt(word, 16))
      : [
          ...start,
          ...Array<string>(8 - start.length - end.length).fill('0'),
          ...end,
        ].map((word) => parseInt(word, 16));
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1)
    return true;
  if ((words[0]! & 0xfe00) === 0xfc00 || (words[0]! & 0xffc0) === 0xfe80)
    return true;
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return privateIPv4(
      `${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`,
    );
  }
  return false;
}
function automaticHost(host: Authority): boolean {
  const name = nameOf(host);
  if (name.startsWith('[')) return privateIPv6(name.slice(1, -1));
  if (isIP(name) === 4) return privateIPv4(name);
  if (name === 'home.arpa' || name.endsWith('.home.arpa')) return true;
  const suffix = name.split('.').at(-1)!;
  // Public DNS owners can rebind their names onto private addresses. Never
  // resolve a name to decide trust; non-delegated LAN namespaces work offline.
  return !publicTlds.has(suffix) && !['onion', 'alt'].includes(suffix);
}

/** Incoming same-origin checks plus a separate, offline Host trust boundary. */
export function createOriginPolicy(options: OriginPolicyOptions = {}) {
  const origins = new Set<string>();
  const schemes = new Map<string, 'http' | 'https'>();
  const trusted = options.trustedHosts?.map((value) => {
    const host = authority(value);
    if (!host)
      throw new Error(
        'TRUSTED_HOSTS must contain exact hostnames or IP addresses, optionally with a port',
      );
    return host;
  });
  if (trusted?.length === 0) throw new Error('TRUSTED_HOSTS must not be empty');
  const trustedHost = (host: Authority, scheme: 'http' | 'https') =>
    trusted?.some(
      (item) =>
        nameOf(item) === nameOf(host) &&
        (item.port === undefined ||
          item.port === (host.port ?? (scheme === 'https' ? 443 : 80))),
    );

  function add(value: string, label: string, alias = true) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${label} must contain exact HTTP(S) origins`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value)
      throw new Error(
        `${label} must contain exact HTTP(S) origins without paths or trailing slashes`,
      );
    const parsed = authority(url.host);
    if (!parsed) throw new Error(`${label} contains an invalid host`);
    if (
      label === 'LOCAL_ORIGIN' &&
      (url.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '[::1]'].includes(nameOf(parsed)))
    )
      throw new Error('LOCAL_ORIGIN must be an HTTP loopback origin');
    const scheme = url.protocol === 'https:' ? 'https' : 'http';
    if (trusted && !trustedHost(parsed, scheme))
      throw new Error(`TRUSTED_HOSTS excludes a configured ${label} host`);
    origins.add(url.origin);
    const keys = [keyOf(parsed)];
    if (parsed.port === undefined)
      keys.push(`${nameOf(parsed)}:${scheme === 'https' ? 443 : 80}`);
    for (const key of keys) {
      const previous = schemes.get(key);
      if (previous && previous !== scheme)
        throw new Error(
          `${label} must not mix HTTP and HTTPS on the same authority`,
        );
      schemes.set(key, scheme);
    }
    if (
      alias &&
      scheme === 'http' &&
      ['localhost', '127.0.0.1'].includes(url.hostname)
    ) {
      url.hostname = url.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      // Strict deployments opt into each hostname independently.
      if (!trusted || trustedHost(authority(url.host)!, scheme))
        add(url.origin, label, false);
    }
  }
  if (options.publicOrigin) add(options.publicOrigin, 'PUBLIC_ORIGIN');
  for (const value of options.allowedOrigins ?? [])
    add(value, 'ALLOWED_ORIGINS');
  if (options.localOrigin) add(options.localOrigin, 'LOCAL_ORIGIN');

  return {
    originFor(value: string | undefined, tls = false): string | null {
      const parsed = authority(value);
      if (!parsed) return null;
      const scheme = tls ? 'https' : (schemes.get(keyOf(parsed)) ?? 'http');
      if (trusted && !trustedHost(parsed, scheme)) return null;
      const origin = new URL(`${scheme}://${parsed.authority}`).origin;
      if (!trusted && !automaticHost(parsed) && !origins.has(origin))
        return null;
      return origin;
    },
  };
}
