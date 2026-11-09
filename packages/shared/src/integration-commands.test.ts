import { describe, expect, it } from 'vitest';
import { emptyBoardDocument } from './board.js';
import {
  applyIntegrationCommands,
  integrationCommandSchema,
} from './integration-commands.js';

describe('non-destructive integration commands', () => {
  it('creates editable devices, ports, network entries and stable cable endpoints in a batch', () => {
    const result = applyIntegrationCommands(emptyBoardDocument(), [
      {
        operation: 'create_device',
        device: { id: 'a', name: 'Router', ports: [{ id: 'p-a' }] },
      },
      {
        operation: 'create_device',
        device: { id: 'b', name: 'Switch', ports: [{ id: 'p-b' }] },
      },
      {
        operation: 'connect_ports',
        connection: { id: 'c', sourcePortId: 'p-a', targetPortId: 'p-b' },
      },
      {
        operation: 'create_network',
        network: { id: 'n', entries: [{ networkEntryId: 'v1', vlanId: '20' }] },
      },
      {
        operation: 'update_network',
        elementId: 'n',
        entryId: 'v1',
        patch: { vlanName: 'Lab' },
      },
    ]);
    expect(result.cables[0]).toMatchObject({
      sourcePortId: 'p-a',
      targetPortId: 'p-b',
    });
    expect(result.elements[0]!.x).not.toBe(result.elements[1]!.x);
    expect(result.elements[2]!.properties.entries).toMatchObject([
      { networkEntryId: 'v1', vlanName: 'Lab' },
    ]);
  });
  it('patches authored fields without dropping documentation, geometry or unknown metadata', () => {
    const first = applyIntegrationCommands(emptyBoardDocument(), [
      { operation: 'create_device', device: { id: 'a', name: 'Old' } },
    ]);
    first.elements[0]!.properties.documentation = { notes: 'Keep me' };
    first.elements[0]!.properties.extra = 'Unrelated';
    const result = applyIntegrationCommands(first, [
      {
        operation: 'update_device',
        deviceId: 'a',
        patch: { name: 'New', managementAddress: '192.0.2.5' },
      },
    ]);
    expect(result.elements[0]!.properties).toEqual({
      documentation: { notes: 'Keep me' },
      extra: 'Unrelated',
      managementAddress: '192.0.2.5',
    });
    expect(first.elements[0]!.name).toBe('Old');
  });
  it('rejects duplicate IDs, cross-board endpoints, unsupported fields and destructive commands', () => {
    expect(
      integrationCommandSchema.safeParse({ operation: 'delete_board' }).success,
    ).toBe(false);
    expect(
      integrationCommandSchema.safeParse({
        operation: 'update_device',
        deviceId: 'x',
        patch: { id: 'new' },
      }).success,
    ).toBe(false);
    expect(() =>
      applyIntegrationCommands(emptyBoardDocument(), [
        {
          operation: 'connect_ports',
          connection: {
            id: 'c',
            sourcePortId: 'outside',
            targetPortId: 'missing',
          },
        },
      ]),
    ).toThrow();
    expect(() =>
      applyIntegrationCommands(emptyBoardDocument(), [
        { operation: 'create_device', device: { id: 'a', name: 'A' } },
        { operation: 'create_device', device: { id: 'a', name: 'Duplicate' } },
      ]),
    ).toThrow();
  });
  it('preserves dimensions on ordinary edits and validates resize against port capacity', () => {
    const first = applyIntegrationCommands(emptyBoardDocument(), [
      {
        operation: 'create_device',
        device: { id: 'a', name: 'Switch', ports: [{ id: 'p', column: 10 }] },
      },
    ]);
    expect(() =>
      applyIntegrationCommands(first, [
        { operation: 'update_layout', elements: [{ id: 'a', width: 160 }] },
      ]),
    ).toThrow();
    expect(first.elements[0]!.width).toBeGreaterThan(160);
  });
  it('appends ports into free slots and keeps automatic placement clear of existing elements', () => {
    const result = applyIntegrationCommands(emptyBoardDocument(), [
      {
        operation: 'create_device',
        device: { id: 'a', name: 'A', ports: [{ id: 'p' }] },
      },
      { operation: 'create_port', deviceId: 'a', port: { id: 'p2' } },
      { operation: 'create_device', device: { id: 'b', name: 'B', x: 0 } },
    ]);
    expect(result.ports.map((p) => [p.row, p.column])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    const [a, b] = result.elements;
    expect(b!.x).toBe(0);
    expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height);
  });
  it('configures existing ports, adds individual VLANs and annotations and updates layout without losing identity', () => {
    const document = applyIntegrationCommands(emptyBoardDocument(), [
      {
        operation: 'create_device',
        device: {
          id: 'a',
          name: 'Router',
          ports: [{ id: 'wan', kind: 'sfp' }],
        },
      },
      {
        operation: 'update_port',
        deviceId: 'a',
        portId: 'wan',
        patch: {
          name: 'WAN',
          role: 'routed/WAN',
          address: '192.0.2.1/31',
          pvid: '20',
          taggedVlans: ['20', '30'],
          row: 1,
        },
      },
      { operation: 'create_network', network: { id: 'n', entries: [] } },
      {
        operation: 'add_network_entry',
        elementId: 'n',
        entry: { networkEntryId: 'v20', vlanId: '20', dhcpServer: false },
      },
      {
        operation: 'update_network',
        elementId: 'n',
        entryId: 'v20',
        patch: {
          gateway: '192.0.2.1',
          dns: '192.0.2.53, 198.51.100.53',
          customFields: { purpose: 'Reference only' },
        },
      },
      {
        operation: 'create_annotation',
        annotation: { id: 'note', type: 'text', text: 'Unverified reference' },
      },
      {
        operation: 'update_layout',
        elements: [{ id: 'a', x: -100, y: 250, width: 600, height: 500 }],
      },
    ]);
    expect(document.ports[0]).toMatchObject({
      id: 'wan',
      deviceId: 'a',
      kind: 'sfp',
      row: 1,
      role: 'routed/WAN',
      taggedVlans: ['20', '30'],
    });
    expect(document.elements[0]).toMatchObject({
      x: -100,
      y: 250,
      width: 600,
      height: 500,
    });
    expect(document.elements[1]!.properties.entries).toMatchObject([
      {
        networkEntryId: 'v20',
        dhcpServer: false,
        dns: '192.0.2.53, 198.51.100.53',
      },
    ]);
    expect(document.elements[2]!.properties.text).toBe('Unverified reference');
    expect(() =>
      applyIntegrationCommands(document, [
        {
          operation: 'update_port',
          deviceId: 'missing',
          portId: 'wan',
          patch: { notes: 'Cross-device edit' },
        },
      ]),
    ).toThrow();
    expect(() =>
      applyIntegrationCommands(document, [
        {
          operation: 'add_network_entry',
          elementId: 'n',
          entry: { networkEntryId: 'v20' },
        },
      ]),
    ).toThrow('Duplicate network entry ID');
  });
});
