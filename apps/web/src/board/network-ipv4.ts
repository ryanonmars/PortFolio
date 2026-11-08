import type { JsonValue } from '../../../../packages/shared/src/board.js';

export interface IPv4Subnet {
  network: string;
  broadcast: string;
  first: string;
  last: string;
  firstAddress: number;
  lastAddress: number;
  usable: number;
  canonicalCidr: string;
}

function addressNumber(value: string): number | null {
  const parts = value.trim().split('.');
  if (parts.length !== 4) return null;
  let address = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255) return null;
    address = address * 256 + Number(part);
  }
  return address;
}

function addressText(address: number): string {
  return [24, 16, 8, 0]
    .map((shift) => Math.floor(address / 2 ** shift) % 256)
    .join('.');
}

/** Derived documentation only; authored strings are never rewritten. */
export function ipv4Subnet(cidr: string): IPv4Subnet | null {
  const parts = cidr.trim().split('/');
  if (parts.length !== 2 || !/^(0|[1-9]\d?)$/.test(parts[1]!)) return null;
  const prefix = Number(parts[1]);
  const address = addressNumber(parts[0]!);
  if (address === null || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const network = Math.floor(address / size) * size;
  const broadcast = network + size - 1;
  const firstAddress = network + (prefix <= 30 ? 1 : 0);
  const lastAddress = broadcast - (prefix <= 30 ? 1 : 0);
  return {
    network: addressText(network),
    broadcast: addressText(broadcast),
    first: addressText(firstAddress),
    last: addressText(lastAddress),
    firstAddress,
    lastAddress,
    usable: lastAddress - firstAddress + 1,
    canonicalCidr: `${addressText(network)}/${prefix}`,
  };
}

export function ipv4Pool(space: IPv4Subnet, start: string, end: string) {
  const first = addressNumber(start);
  const last = addressNumber(end);
  if (
    first === null ||
    last === null ||
    first > last ||
    first < space.firstAddress ||
    last > space.lastAddress
  )
    return null;
  const count = last - first + 1;
  return {
    start: addressText(first),
    end: addressText(last),
    count,
    offsetPercent: ((first - space.firstAddress) / space.usable) * 100,
    widthPercent: (count / space.usable) * 100,
  };
}

export function networkLayoutTotals(entries: Record<string, JsonValue>[]): {
  vlans: number;
  subnets: number;
  usable: number | null;
} {
  const vlans = new Set<string>();
  const subnets = new Map<string, IPv4Subnet>();
  for (const entry of entries) {
    const vlan = entry.vlanId ?? entry.vlan_id;
    if (typeof vlan === 'string' || typeof vlan === 'number') {
      const key = String(vlan).trim();
      if (key) vlans.add(key);
    }
    const cidr = Object.hasOwn(entry, 'subnet') ? entry.subnet : entry.cidr;
    const subnet = typeof cidr === 'string' ? ipv4Subnet(cidr) : null;
    if (subnet) subnets.set(subnet.canonicalCidr, subnet);
  }
  const intervals = [...subnets.values()].sort(
    (a, b) => a.firstAddress - b.firstAddress,
  );
  let usable = 0;
  let first = 0;
  let last = -1;
  for (const subnet of intervals) {
    if (subnet.firstAddress <= last + 1) {
      last = Math.max(last, subnet.lastAddress);
    } else {
      usable += last - first + 1;
      first = subnet.firstAddress;
      last = subnet.lastAddress;
    }
  }
  usable += last - first + 1;
  return {
    vlans: vlans.size,
    subnets: subnets.size,
    usable: subnets.size ? usable : null,
  };
}
