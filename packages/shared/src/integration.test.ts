import { describe, expect, it } from 'vitest';
import { boardDocumentSchema } from './board.js';
import {
  syntheticBoardProposal,
  validateBoardProposal,
} from './integration.js';

describe('agent board proposals', () => {
  it('produces deterministic canonical documents without inventing authored facts', () => {
    const proposal = syntheticBoardProposal();
    const result = validateBoardProposal(proposal);
    expect(result.valid).toBe(true);
    expect(result.document).toEqual(validateBoardProposal(proposal).document);
    expect(boardDocumentSchema.safeParse(result.document).success).toBe(true);
    expect(
      result.document?.elements[0]?.properties.manufacturer,
    ).toBeUndefined();
    expect(result.summary).toEqual({
      devices: 9,
      networks: 3,
      ports: 17,
      cables: 8,
      annotations: 2,
      unresolvedConnections: 1,
    });
  });
  it('rejects unsupported fields, identities, port kinds and broken graphs', () => {
    for (const input of [
      { name: 'test', extra: true },
      { name: 'test', devices: [{ id: '', name: 'device' }] },
      {
        name: 'test',
        devices: [
          { id: 'd', name: 'device', ports: [{ id: 'p', kind: 'ethernet' }] },
        ],
      },
      {
        name: 'test',
        connections: [
          { id: 'c', sourcePortId: 'missing', targetPortId: 'other' },
        ],
      },
      {
        name: 'test',
        devices: [
          { id: 'd', name: 'one' },
          { id: 'd', name: 'two' },
        ],
      },
    ])
      expect(validateBoardProposal(input).valid).toBe(false);
  });
  it('supports hundreds of ports and lays out nonoverlapping equipment', () => {
    const result = validateBoardProposal({
      name: 'large',
      devices: Array.from({ length: 4 }, (_, d) => ({
        id: `d${d}`,
        name: `Device ${d}`,
        ports: Array.from({ length: 512 }, (_, p) => ({ id: `p${d}-${p}` })),
      })),
    });
    expect(result.valid).toBe(true);
    const elements = result.document!.elements;
    for (let i = 0; i < elements.length; i++)
      for (let j = i + 1; j < elements.length; j++) {
        const a = elements[i]!,
          b = elements[j]!;
        expect(
          a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y,
        ).toBe(true);
      }
  });
  it('preserves explicit positions and warns about overlaps and unconventional authored values', () => {
    const result = validateBoardProposal({
      name: 'authored',
      devices: [
        { id: 'a', name: 'A', x: 0, y: 0, managementAddress: 'not an IP' },
        { id: 'b', name: 'B', x: 0, y: 0 },
      ],
      networks: [
        {
          id: 'n',
          entries: [
            { networkEntryId: 'e', vlanId: '5000', subnet: 'planned later' },
          ],
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(
      result.document!.elements.slice(0, 2).map((e) => [e.x, e.y]),
    ).toEqual([
      [0, 0],
      [0, 0],
    ]);
    expect(result.warnings.some((w) => w.includes('overlap'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('VLAN'))).toBe(true);
  });
  it('rejects duplicate entry IDs and occupied cable endpoints', () => {
    expect(
      validateBoardProposal({
        name: 'n',
        networks: [
          {
            id: 'n',
            entries: [{ networkEntryId: 'e' }, { networkEntryId: 'e' }],
          },
        ],
      }).valid,
    ).toBe(false);
    const proposal = syntheticBoardProposal();
    proposal.connections.push({ ...proposal.connections[0]!, id: 'c2' });
    expect(validateBoardProposal(proposal).valid).toBe(false);
  });
  it('preserves optional entry documentation and clears DHCP without inventing defaults', () => {
    const result = validateBoardProposal({
      name: 'Documentation',
      networks: [
        {
          id: 'n',
          entries: [
            {
              networkEntryId: 'e',
              dhcpServer: null,
              customFields: { owner: 'example team' },
              addresses: 'planned',
              pvid: 'native',
            },
          ],
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.document!.elements[0]!.properties.entries).toEqual([
      {
        networkEntryId: 'e',
        networkEntryVersion: 2,
        dhcpServer: null,
        customFields: { owner: 'example team' },
        addresses: 'planned',
        pvid: 'native',
      },
    ]);
  });
  it('rejects insufficient explicit geometry, excessive ports and duplicate slots', () => {
    for (const device of [
      { id: 'd', name: 'D', width: 160, height: 120, ports: [{ id: 'p' }] },
      {
        id: 'd',
        name: 'D',
        ports: Array.from({ length: 513 }, (_, i) => ({ id: `p${i}` })),
      },
      {
        id: 'd',
        name: 'D',
        ports: [
          { id: 'p1', row: 0, column: 0 },
          { id: 'p2', row: 0, column: 0 },
        ],
      },
    ])
      expect(
        validateBoardProposal({ name: 'Invalid', devices: [device] }).valid,
      ).toBe(false);
  });
  it('places automatic equipment around authored equipment and respects partial coordinates', () => {
    const result = validateBoardProposal({
      name: 'Layout',
      devices: [
        { id: 'fixed', name: 'Fixed', x: 0, y: 0 },
        { id: 'automatic', name: 'Automatic' },
        { id: 'partial', name: 'Partial', y: 0 },
      ],
    });
    expect(result.valid).toBe(true);
    const [fixed, automatic, partial] = result.document!.elements;
    expect(fixed!.x).toBe(0);
    expect(fixed!.y).toBe(0);
    expect(automatic!.y).toBeGreaterThanOrEqual(fixed!.height);
    expect(partial!.y).toBe(0);
    expect(partial!.x).toBeGreaterThanOrEqual(fixed!.width);
  });
  it('rejects deeply nested and cyclic custom fields without recursive failure', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = 'value';
    for (let i = 0; i < 30; i++) deep = { child: deep };
    for (const customFields of [cyclic, deep]) {
      const result = validateBoardProposal({
        name: 'Bounded',
        devices: [
          { id: 'd', name: 'Device', ports: [{ id: 'p', customFields }] },
        ],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('nesting depth');
    }
  });
  it('warns about mathematical network and DHCP inconsistencies without rejecting authored facts', () => {
    const result = validateBoardProposal({
      name: 'Math',
      networks: [
        {
          id: 'n',
          entries: [
            {
              networkEntryId: 'reverse',
              subnet: '192.0.2.1/24',
              dhcpStart: '192.0.2.200',
              dhcpEnd: '192.0.2.10',
              gateway: '198.51.100.1',
            },
            {
              networkEntryId: 'bounds',
              subnet: '255.255.255.0/24',
              dhcpStart: '255.255.255.0',
              dhcpEnd: '255.255.255.255',
              gateway: '255.255.255.1',
            },
            {
              networkEntryId: 'all',
              subnet: '0.0.0.0/0',
              gateway: '255.255.255.254',
            },
            {
              networkEntryId: 'point',
              subnet: '192.0.2.0/31',
              gateway: '192.0.2.0',
            },
          ],
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toContain('range is reversed');
    expect(result.warnings.join(' ')).toContain(
      'outside the documented subnet',
    );
    expect(result.warnings.join(' ')).toContain('contains host bits');
    expect(result.warnings.join(' ')).toContain('network or broadcast');
    expect(result.warnings.join(' ')).toContain(
      'includes the documented gateway',
    );
    expect(
      result.warnings.filter(
        (w) =>
          w.startsWith('Network entry all:') ||
          w.startsWith('Network entry point:'),
      ),
    ).toEqual([]);
  });
  it('preserves unresolved authored connections as readable editable annotations with collision-free identity', () => {
    const proposal = syntheticBoardProposal();
    proposal.annotations.push({
      id: 'unresolved-connections',
      type: 'text',
      text: 'Existing note',
    });
    const result = validateBoardProposal(proposal);
    expect(result.valid).toBe(true);
    expect(result.unresolvedConnections).toEqual(
      proposal.unresolvedConnections,
    );
    const note = result.document!.elements.find(
      (element) => element.id === 'unresolved-connections-1',
    );
    expect(note?.type).toBe('text');
    expect(note?.name).toBe('Unresolved connections');
    expect(note?.properties.text).toContain(proposal.unresolvedConnections[0]);
    expect(result.summary.annotations).toBe(3);
    expect(validateBoardProposal(proposal).document).toEqual(result.document);
  });
  it('rejects unresolved notes that cannot be preserved in an editable annotation', () => {
    const result = validateBoardProposal({
      name: 'Too long',
      unresolvedConnections: ['a'.repeat(10000)],
    });
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((error) => error.path === 'unresolvedConnections'),
    ).toBe(true);
    expect(result.document).toBeUndefined();
  });
  it('keeps omitted connector kinds and authored port facts unknown', () => {
    const result = validateBoardProposal({
      name: 'Unknown',
      devices: [{ id: 'd', name: 'Device', ports: [{ id: 'p' }] }],
    });
    expect(result.valid).toBe(true);
    expect(result.document!.ports[0]).toMatchObject({
      kind: 'other',
      role: '',
      linkState: 'unknown',
      speed: '',
      address: '',
      nativeVlan: '',
    });
    expect(result.warnings).toContain(
      'Port p: connector kind was not supplied; stored as Other.',
    );
    expect(
      syntheticBoardProposal().devices.every((device) =>
        device.ports.every((port) => port.kind === 'rj45'),
      ),
    ).toBe(true);
  });
});
