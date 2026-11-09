import { z } from 'zod';
import {
  annotationPropertiesSchema,
  boardCableSchema,
  boardDocumentSchema,
  boardPortSchema,
  emptyBoardDocument,
  minimumBoardDeviceSize,
  type BoardDocument,
  type BoardElement,
  type BoardPort,
} from './board.js';

const id = z.string().trim().min(1).max(100);
const text = z.string().max(10000);
const name = z.string().max(240);
const color = z.union([z.literal(''), z.string().regex(/^#[0-9a-fA-F]{6}$/)]);
const geometry = {
  x: z.number().finite().min(-100000).max(100000).optional(),
  y: z.number().finite().min(-100000).max(100000).optional(),
  width: z.number().finite().min(160).max(20000).optional(),
  height: z.number().finite().min(120).max(20000).optional(),
  color: color.optional(),
  group: name.optional(),
};
export const proposalPortSchema = boardPortSchema
  .omit({ deviceId: true })
  .partial()
  .extend({ id, name: name.optional() })
  .strict();
export const proposalDeviceSchema = z
  .object({
    id,
    name,
    ...geometry,
    ports: z.array(proposalPortSchema).max(512).default([]),
    portsPerRow: z.number().int().min(1).max(277).default(8),
    manufacturer: text.optional(),
    model: text.optional(),
    managementAddress: text.optional(),
    deviceType: text.optional(),
    notes: text.optional(),
    documentation: boardPortSchema.shape.customFields.optional(),
  })
  .strict();
export const proposalNetworkEntrySchema = z
  .object({
    networkEntryId: id,
    networkEntryVersion: z.literal(2).optional(),
    vlanId: z.union([name, z.number().finite()]).optional(),
    vlanName: name.optional(),
    name: name.optional(),
    subnet: text.optional(),
    cidr: text.optional(),
    gateway: text.optional(),
    dhcpServer: z.boolean().nullable().optional(),
    dhcpStatus: text.optional(),
    dhcpStart: text.optional(),
    dhcpEnd: text.optional(),
    dns: text.optional(),
    addresses: text.optional(),
    pvid: text.optional(),
    customFields: boardPortSchema.shape.customFields.optional(),
    documentation: boardPortSchema.shape.customFields.optional(),
    notes: text.optional(),
    color: color.optional(),
  })
  .strict();
export const proposalNetworkSchema = z
  .object({
    id,
    name: name.optional(),
    ...geometry,
    entries: z.array(proposalNetworkEntrySchema).max(4096).default([]),
    displayFields: z
      .array(
        z.enum([
          'vlanId',
          'vlanName',
          'subnet',
          'gateway',
          'dhcpServer',
          'dhcpStart',
          'dhcpEnd',
          'dns',
          'notes',
          'addresses',
          'pvid',
          'customFields',
        ]),
      )
      .max(13)
      .optional(),
  })
  .strict();
export const proposalConnectionSchema = boardCableSchema
  .partial()
  .extend({ id, sourcePortId: id, targetPortId: id })
  .strict();
export const proposalAnnotationSchema = z
  .object({
    id,
    type: z.enum(['text', 'arrow', 'rectangle', 'highlight']),
    name: name.optional(),
    text: text.optional(),
    ...geometry,
    width: z.number().finite().min(16).max(20000).optional(),
    height: z.number().finite().min(16).max(20000).optional(),
    properties: annotationPropertiesSchema.strict().optional(),
  })
  .strict();
export const boardProposalSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    devices: z.array(proposalDeviceSchema).max(256).default([]),
    networks: z.array(proposalNetworkSchema).max(256).default([]),
    annotations: z.array(proposalAnnotationSchema).max(256).default([]),
    connections: z.array(proposalConnectionSchema).max(2048).default([]),
    unresolvedConnections: z.array(text).max(2048).default([]),
  })
  .strict();
export type BoardProposal = z.input<typeof boardProposalSchema>;
export interface BoardProposalValidation {
  valid: boolean;
  errors: { path: string; message: string }[];
  warnings: string[];
  unresolvedConnections: string[];
  summary: {
    devices: number;
    networks: number;
    ports: number;
    cables: number;
    annotations: number;
    unresolvedConnections: number;
  };
  name?: string;
  document?: BoardDocument;
}
const overlaps = (a: BoardElement, b: BoardElement) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;
const conventionalAddress = (value: string) =>
  /^(?:\d{1,3}\.){3}\d{1,3}(?:\/(?:[0-9]|[12][0-9]|3[0-2]))?$/.test(value) &&
  value
    .split('/')[0]!
    .split('.')
    .every((o) => Number(o) <= 255);
/** Integer arithmetic avoids signed 32-bit mask errors at /0 and high IPv4 addresses. */
function ipv4Number(value: string | undefined): number | undefined {
  if (!value || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return undefined;
  const parts = value.split('.').map(Number);
  if (parts.some((part) => part > 255)) return undefined;
  return parts.reduce((address, part) => address * 256 + part, 0);
}
export function networkWarnings(
  entry: z.infer<typeof proposalNetworkEntrySchema>,
): string[] {
  const warnings: string[] = [];
  const subnet = entry.subnet || entry.cidr;
  const match = subnet?.match(/^(.+)\/(\d{1,2})$/);
  const address = match ? ipv4Number(match[1]) : undefined;
  const prefix = match ? Number(match[2]) : undefined;
  const block =
    prefix !== undefined && prefix <= 32 ? 2 ** (32 - prefix) : undefined;
  const start =
    address !== undefined && block !== undefined
      ? Math.floor(address / block) * block
      : undefined;
  const end =
    start !== undefined && block !== undefined ? start + block - 1 : undefined;
  if (start !== undefined && address !== start)
    warnings.push(
      'subnet contains host bits; its CIDR network begins at a different address.',
    );
  const poolStart = ipv4Number(entry.dhcpStart);
  const poolEnd = ipv4Number(entry.dhcpEnd);
  if (poolStart !== undefined && poolEnd !== undefined && poolStart > poolEnd)
    warnings.push('DHCP range is reversed.');
  for (const [field, value] of [
    ['gateway', entry.gateway],
    ['DHCP start', entry.dhcpStart],
    ['DHCP end', entry.dhcpEnd],
  ] as const) {
    const number = ipv4Number(value);
    if (value && number === undefined && conventionalAddress(value))
      warnings.push(
        `${field} should be a bare IPv4 address for range comparisons.`,
      );
    if (number === undefined || start === undefined || end === undefined)
      continue;
    if (number < start || number > end)
      warnings.push(`${field} is outside the documented subnet.`);
    else if (prefix! < 31 && (number === start || number === end))
      warnings.push(`${field} is the subnet network or broadcast address.`);
  }
  const gateway = ipv4Number(entry.gateway);
  if (
    gateway !== undefined &&
    poolStart !== undefined &&
    poolEnd !== undefined &&
    gateway >= poolStart &&
    gateway <= poolEnd
  )
    warnings.push('DHCP range includes the documented gateway.');
  return warnings.map(
    (warning) => `Network entry ${entry.networkEntryId}: ${warning}`,
  );
}
/** Pure preview conversion: IDs and authored facts are supplied by the caller. */
export function validateBoardProposal(input: unknown): BoardProposalValidation {
  const result: BoardProposalValidation = {
    valid: false,
    errors: [],
    warnings: [],
    unresolvedConnections: [],
    summary: {
      devices: 0,
      networks: 0,
      ports: 0,
      cables: 0,
      annotations: 0,
      unresolvedConnections: 0,
    },
  };
  // Bound traversal before recursive custom-field schemas run, including direct
  // library callers that do not pass through the HTTP JSON body guard.
  const pending: { value: unknown; depth: number }[] = [
    { value: input, depth: 0 },
  ];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++visited > 100000 || current.depth > 24) {
      result.errors.push({
        path: '',
        message: 'Proposal exceeds the supported JSON size or nesting depth',
      });
      return result;
    }
    if (current.value && typeof current.value === 'object') {
      const children = Object.values(current.value);
      if (children.length + pending.length + visited > 100000) {
        result.errors.push({
          path: '',
          message: 'Proposal exceeds the supported JSON size or nesting depth',
        });
        return result;
      }
      for (const value of children)
        pending.push({ value, depth: current.depth + 1 });
    }
  }
  const parsed = boardProposalSchema.safeParse(input);
  if (!parsed.success) {
    result.errors = parsed.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    return result;
  }
  const proposal = parsed.data;
  result.name = proposal.name;
  result.unresolvedConnections = [...proposal.unresolvedConnections];
  result.summary = {
    devices: proposal.devices.length,
    networks: proposal.networks.reduce(
      (count, network) => count + network.entries.length,
      0,
    ),
    ports: proposal.devices.reduce((n, d) => n + d.ports.length, 0),
    cables: proposal.connections.length,
    annotations:
      proposal.annotations.length +
      (proposal.unresolvedConnections.length ? 1 : 0),
    unresolvedConnections: proposal.unresolvedConnections.length,
  };
  const document = emptyBoardDocument();
  const warnVlan = (value: string, context: string) => {
    if (
      value &&
      (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 4094)
    )
      result.warnings.push(`${context}: VLAN is freeform or outside 1–4094.`);
  };
  const placements: {
    element: BoardElement;
    x?: number;
    y?: number;
    group: string;
    index: number;
  }[] = [];
  function element(
    item: {
      id: string;
      name?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      color?: string;
      group?: string;
    },
    type: BoardElement['type'],
    properties: BoardElement['properties'],
    width: number,
    height: number,
  ) {
    const e: BoardElement = {
      id: item.id,
      type,
      name: item.name ?? '',
      x: item.x ?? 0,
      y: item.y ?? 0,
      width: item.width ?? width,
      height: item.height ?? height,
      z: placements.length,
      color: item.color ?? '',
      properties,
    };
    placements.push({
      element: e,
      x: item.x,
      y: item.y,
      group: item.group ?? '',
      index: placements.length,
    });
    document.elements.push(e);
    return e;
  }
  for (const device of proposal.devices) {
    const properties: BoardElement['properties'] = {};
    for (const key of [
      'manufacturer',
      'model',
      'managementAddress',
      'deviceType',
      'notes',
      'documentation',
    ] as const)
      if (device[key] !== undefined) properties[key] = device[key];
    const e = element(device, 'device', properties, 160, 120);
    const faceCounts = { front: 0, rear: 0 };
    for (const port of device.ports) {
      if (port.kind === undefined)
        result.warnings.push(
          `Port ${port.id}: connector kind was not supplied; stored as Other.`,
        );
      const face = port.face ?? 'front';
      const index = faceCounts[face]++;
      document.ports.push({
        name: '',
        kind: 'other',
        color: '',
        role: '',
        speed: '',
        linkState: 'unknown',
        nativeVlan: '',
        taggedVlans: [],
        pvid: '',
        address: '',
        externalDestination: '',
        notes: '',
        customFields: {},
        ...port,
        deviceId: device.id,
        face,
        row: port.row ?? Math.floor(index / device.portsPerRow),
        column: port.column ?? index % device.portsPerRow,
      } satisfies BoardPort);
    }
    for (const port of document.ports.filter(
      (port) => port.deviceId === device.id,
    )) {
      for (const value of [port.nativeVlan, port.pvid, ...port.taggedVlans])
        warnVlan(value, `Port ${port.id}`);
      if (port.address && !conventionalAddress(port.address))
        result.warnings.push(
          `Port ${port.id}: address is freeform or unconventional.`,
        );
    }
    const minimum = minimumBoardDeviceSize(e, document.ports);
    e.width = device.width ?? minimum.width;
    e.height = device.height ?? minimum.height;
    if (
      device.managementAddress &&
      !conventionalAddress(device.managementAddress)
    )
      result.warnings.push(
        `Device ${device.id}: management address is freeform or unconventional.`,
      );
  }
  const entryIds = new Set<string>();
  for (const network of proposal.networks) {
    for (const entry of network.entries) {
      if (entryIds.has(entry.networkEntryId))
        result.errors.push({
          path: `networks.${network.id}.entries`,
          message: 'Duplicate network entry ID',
        });
      entryIds.add(entry.networkEntryId);
      result.warnings.push(...networkWarnings(entry));
      if (
        entry.vlanId !== undefined &&
        entry.vlanId !== '' &&
        (!/^\d+$/.test(String(entry.vlanId)) ||
          Number(entry.vlanId) < 1 ||
          Number(entry.vlanId) > 4094)
      )
        result.warnings.push(
          `Network entry ${entry.networkEntryId}: VLAN is freeform or outside 1–4094.`,
        );
      for (const key of [
        'subnet',
        'cidr',
        'gateway',
        'dhcpStart',
        'dhcpEnd',
      ] as const)
        if (entry[key] && !conventionalAddress(entry[key]))
          result.warnings.push(
            `Network entry ${entry.networkEntryId}: ${key} is freeform or unconventional.`,
          );
    }
    element(
      network,
      'network',
      {
        entries: network.entries.map((e) => ({ ...e, networkEntryVersion: 2 })),
        ...(network.displayFields
          ? { displayFields: network.displayFields }
          : {}),
      },
      480,
      Math.min(20000, Math.max(160, 100 + network.entries.length * 64)),
    );
  }
  for (const annotation of proposal.annotations)
    element(
      annotation,
      annotation.type,
      {
        ...annotation.properties,
        ...(annotation.text !== undefined ? { text: annotation.text } : {}),
      },
      320,
      160,
    );
  if (proposal.unresolvedConnections.length) {
    const text = [
      'Unresolved connections',
      ...proposal.unresolvedConnections.map((item) => `• ${item}`),
    ].join('\n');
    if (text.length > 10000)
      result.errors.push({
        path: 'unresolvedConnections',
        message:
          'Unresolved connections exceed the 10000-character editable annotation limit; shorten the supplied notes',
      });
    else {
      const reserved = new Set([
        ...proposal.devices.map((item) => item.id),
        ...proposal.devices.flatMap((item) =>
          item.ports.map((port) => port.id),
        ),
        ...proposal.networks.map((item) => item.id),
        ...proposal.networks.flatMap((item) =>
          item.entries.map((entry) => entry.networkEntryId),
        ),
        ...proposal.annotations.map((item) => item.id),
        ...proposal.connections.map((item) => item.id),
      ]);
      let id = 'unresolved-connections';
      let suffix = 1;
      while (reserved.has(id)) id = `unresolved-connections-${suffix++}`;
      element(
        { id, name: 'Unresolved connections' },
        'text',
        { text },
        480,
        Math.min(
          20000,
          Math.max(160, 80 + proposal.unresolvedConnections.length * 36),
        ),
      );
    }
  }
  document.cables = proposal.connections.map((c) => ({
    name: '',
    cableType: '',
    sourceConnector: '',
    targetConnector: '',
    color: '',
    length: '',
    notes: '',
    ...c,
  }));
  // Reserve authored positions first; automatic placement never displaces them.
  const placed = placements
    .filter((p) => p.x !== undefined && p.y !== undefined)
    .map((p) => p.element);
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++)
      if (overlaps(placed[i]!, placed[j]!))
        result.warnings.push(
          `Explicit elements ${placed[i]!.id} and ${placed[j]!.id} overlap.`,
        );
  const automatic = placements
    .filter((p) => p.x === undefined || p.y === undefined)
    .sort((a, b) => a.group.localeCompare(b.group, 'en') || a.index - b.index);
  // Match row width to the generated equipment footprint. Small inventories
  // should not fill a fixed, very wide row just because more space is available.
  const rowWidth = Math.min(
    2400,
    Math.max(
      640,
      Math.sqrt(
        automatic.reduce(
          (area, { element: e }) => area + (e.width + 80) * (e.height + 80),
          0,
        ) * 2,
      ),
    ),
  );
  let cursorX = 0,
    cursorY = 0,
    rowHeight = 0;
  for (const p of automatic) {
    const e = p.element;
    if (cursorX && cursorX + e.width > rowWidth) {
      cursorX = 0;
      cursorY += rowHeight + 80;
      rowHeight = 0;
    }
    e.x = p.x ?? cursorX;
    e.y = p.y ?? cursorY;
    while (placed.some((other) => overlaps(e, other))) {
      const conflicts = placed.filter((other) => overlaps(e, other));
      if (p.y === undefined)
        e.y =
          Math.max(...conflicts.map((other) => other.y + other.height)) + 80;
      else if (p.x === undefined)
        e.x = Math.max(...conflicts.map((other) => other.x + other.width)) + 80;
    }
    placed.push(e);
    cursorX = e.x + e.width + 80;
    cursorY = Math.max(cursorY, e.y);
    rowHeight = Math.max(rowHeight, e.height);
  }
  const canonical = boardDocumentSchema.safeParse(document);
  if (!canonical.success)
    result.errors.push(
      ...canonical.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      })),
    );
  if (result.errors.length === 0 && canonical.success) {
    result.valid = true;
    result.document = canonical.data;
  }
  return result;
}
/** Synthetic public examples only; shared by API/MCP tests without local data. */
export function syntheticBoardProposal(): z.infer<typeof boardProposalSchema> {
  const vlans = ['10', '20', '30'];
  const proposal = boardProposalSchema.parse({
    name: 'Synthetic lab',
    devices: [
      {
        id: 'router',
        name: 'Router',
        managementAddress: '192.0.2.1',
        ports: [
          {
            id: 'router-lan',
            name: 'LAN trunk',
            role: 'trunk',
            nativeVlan: '10',
            taggedVlans: ['20', '30'],
          },
          { id: 'router-wan', name: 'WAN', role: 'routed/WAN' },
        ],
      },
      ...['switch', 'switch-secondary'].map((id, index) => ({
        id,
        name: `Switch ${index + 1}`,
        managementAddress: `192.0.2.${index + 2}`,
        ports: [
          {
            id: `${id}-uplink`,
            name: 'Uplink trunk',
            role: 'trunk',
            nativeVlan: '10',
            taggedVlans: ['20', '30'],
          },
          ...(index === 0
            ? [
                {
                  id: 'switch-peer',
                  name: 'Switch trunk',
                  role: 'trunk',
                  nativeVlan: '10',
                  taggedVlans: ['20', '30'],
                },
              ]
            : []),
          ...vlans.map((vlan, i) => ({
            id: `${id}-access-${i + 1}`,
            name: `Access ${i + 1}`,
            role: 'access',
            nativeVlan: vlan,
          })),
        ],
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `endpoint-${index + 1}`,
        name: `Endpoint ${index + 1}`,
        managementAddress: `192.0.2.${index + 10}`,
        ports: [
          {
            id: `endpoint-${index + 1}-lan`,
            name: 'LAN',
            role: 'access',
            nativeVlan: vlans[index % 3],
          },
        ],
      })),
    ],
    networks: [
      {
        id: 'networks',
        name: 'Networks',
        entries: vlans.map((vlan, index) => ({
          networkEntryId: `vlan-${vlan}`,
          vlanId: vlan,
          vlanName: ['Management', 'Clients', 'Services'][index],
          subnet: ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24'][index],
        })),
      },
    ],
    connections: [
      {
        id: 'uplink',
        sourcePortId: 'router-lan',
        targetPortId: 'switch-uplink',
      },
      {
        id: 'switch-link',
        sourcePortId: 'switch-peer',
        targetPortId: 'switch-secondary-uplink',
      },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `endpoint-link-${index + 1}`,
        sourcePortId: `${index < 3 ? 'switch' : 'switch-secondary'}-access-${(index % 3) + 1}`,
        targetPortId: `endpoint-${index + 1}-lan`,
      })),
    ],
    annotations: [
      {
        id: 'note',
        type: 'text',
        text: 'Synthetic documentation example. All addresses use documentation ranges.',
      },
    ],
    unresolvedConnections: ['Router WAN destination is undocumented.'],
  });
  for (const device of proposal.devices)
    for (const port of device.ports) port.kind = 'rj45';
  return proposal;
}
