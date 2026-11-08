import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  normalizeNetworkDocument,
} from '../../../../packages/shared/src/board.js';
import { networkItems } from './detail-model.js';
import {
  editDeviceField,
  editDocumentationField,
  editNetworkField,
  editPortField,
} from './detail-edit.js';
function fixture() {
  const document = emptyBoardDocument();
  const base = {
    x: 12,
    y: 24,
    width: 500,
    height: 260,
    color: '#24332b',
    z: 0,
  };
  document.elements = [
    {
      ...base,
      id: 'device',
      name: 'Switch',
      type: 'device',
      properties: {
        model: 'Existing',
        documentation: { futureField: { preserved: true } },
        customFields: { Custom: 'Keep' },
      },
    },
    {
      ...base,
      id: 'network',
      name: 'Networks',
      type: 'network',
      properties: {
        entries: [
          {
            vlanId: '20',
            vlanName: 'Servers',
            subnet: '192.0.2.0/24',
            futureField: 'Keep',
            documentation: { futureField: 'Keep' },
          },
        ],
        displayMode: 'detailed',
      },
    },
  ];
  document.ports = [
    {
      id: 'port',
      deviceId: 'device',
      face: 'front',
      row: 0,
      column: 0,
      name: '1',
      kind: 'rj45',
      color: '',
      role: '',
      speed: '',
      linkState: '',
      nativeVlan: '',
      taggedVlans: [],
      pvid: '',
      address: '',
      externalDestination: '',
      notes: '',
      customFields: { Custom: 'Keep' },
    },
  ];
  return normalizeNetworkDocument(document);
}
describe('detail-page canonical editing', () => {
  it('edits the existing device without changing geometry, ports, cables, or unknown properties', () => {
    const document = fixture();
    const snapshot = structuredClone(document);
    const renamed = editDeviceField(document, 'device', 'name', 'Renamed')!;
    expect(renamed.elements[0]!.name).toBe('Renamed');
    expect(renamed.elements[0]!.width).toBe(500);
    expect(renamed.ports).toEqual(document.ports);
    expect(renamed.cables).toEqual(document.cables);
    const changed = editDeviceField(
      renamed,
      'device',
      'managementAddress',
      'authored value',
    )!;
    expect(changed.elements[0]!.properties.managementAddress).toBe(
      'authored value',
    );
    expect(changed.elements[0]!.properties.customFields).toEqual({
      Custom: 'Keep',
    });
    expect(document).toEqual(snapshot);
    expect(editDeviceField(document, 'device', 'id', 'bad')).toBeNull();
    expect(editDeviceField(document, 'missing', 'name', 'bad')).toBeNull();
    expect(editDeviceField(document, 'network', 'name', 'bad')).toBeNull();
    expect(
      editDeviceField(document, 'device', 'name', 'a'.repeat(241)),
    ).toBeNull();
  });
  it('updates exactly the existing network entry by stable identity while preserving all container preferences', () => {
    const document = fixture();
    const item = networkItems(document)[0]!;
    const changed = editNetworkField(
      document,
      'network',
      item.entryId,
      'gateway',
      'unconventional documented value',
    )!;
    expect(networkItems(changed)[0]!.entry.gateway).toBe(
      'unconventional documented value',
    );
    expect(networkItems(changed)[0]!.entry.futureField).toBe('Keep');
    expect(networkItems(changed)[0]!.entryId).toBe(item.entryId);
    expect(changed.elements[1]!.properties.displayMode).toBe('detailed');
    expect(changed.elements[1]!.height).toBe(260);
    expect(
      editNetworkField(
        document,
        'network',
        item.entryId,
        'networkEntryId',
        'bad',
      ),
    ).toBeNull();
    expect(
      editNetworkField(document, 'network', 'missing', 'vlanName', 'bad'),
    ).toBeNull();
    expect(
      editNetworkField(document, 'network', item.entryId, 'dhcpServer', 'true'),
    ).toBeNull();
    expect(
      editNetworkField(document, 'network', item.entryId, 'color', '#bad'),
    ).toBeNull();
  });
  it('stores optional documentation on its existing object and preserves unknown nested metadata', () => {
    const document = fixture();
    const item = networkItems(document)[0]!;
    const device = editDocumentationField(
      document,
      { kind: 'device', deviceId: 'device' },
      'description',
      'A description',
    )!;
    expect(device.elements[0]!.properties.documentation).toEqual({
      futureField: { preserved: true },
      description: 'A description',
    });
    const network = editDocumentationField(
      document,
      { kind: 'network', containerId: 'network', entryId: item.entryId },
      'notes',
      'Notes',
    )!;
    expect(networkItems(network)[0]!.entry.documentation).toEqual({
      futureField: 'Keep',
      notes: 'Notes',
    });
    expect(
      editDocumentationField(
        document,
        { kind: 'device', deviceId: 'device' },
        'unknownField',
        'bad',
      ),
    ).toBeNull();
  });
  it('changes only allowed port configuration and enforces existing schema limits', () => {
    const document = fixture();
    const changed = editPortField(document, 'device', 'port', 'taggedVlans', [
      '20',
      '30',
    ])!;
    expect(changed.ports[0]!.taggedVlans).toEqual(['20', '30']);
    expect(changed.ports[0]!.id).toBe('port');
    expect(changed.ports[0]!.deviceId).toBe('device');
    expect(changed.ports[0]!.row).toBe(0);
    expect(changed.ports[0]!.customFields).toEqual({ Custom: 'Keep' });
    expect(editPortField(document, 'device', 'port', 'row', 5)).toBeNull();
    expect(
      editPortField(document, 'missing', 'port', 'name', 'bad'),
    ).toBeNull();
    expect(
      editPortField(document, 'device', 'port', 'kind', 'invalid'),
    ).toBeNull();
    expect(
      editPortField(document, 'device', 'port', 'notes', 'a'.repeat(10001)),
    ).toBeNull();
  });
  it('preserves pre-existing scalar and array documentation when structured fields are added', () => {
    for (const raw of [
      'Authored plain documentation',
      ['reference', 'notes'],
      true,
      12,
      null,
    ]) {
      const document = fixture();
      document.elements[0]!.properties.documentation = raw;
      const device = editDocumentationField(
        document,
        { kind: 'device', deviceId: 'device' },
        'description',
        'New structured description',
      )!;
      expect(device.elements[0]!.properties.documentation).toEqual({
        legacyValue: raw,
        description: 'New structured description',
      });
      const item = networkItems(document)[0]!;
      document.elements[1]!.properties.entries = [
        { ...item.entry, documentation: raw },
      ];
      const network = editDocumentationField(
        document,
        { kind: 'network', containerId: 'network', entryId: item.entryId },
        'notes',
        'New structured notes',
      )!;
      expect(networkItems(network)[0]!.entry.documentation).toEqual({
        legacyValue: raw,
        notes: 'New structured notes',
      });
    }
  });
  it('preserves legacy DHCP state aliases while explicit canonical edits take precedence', () => {
    const document = fixture();
    const item = networkItems(document)[0]!;
    document.elements[1]!.properties.entries = [
      { ...item.entry, dhcpStatus: 'Enabled', dhcpServer: true },
    ];
    const cleared = editNetworkField(
      document,
      'network',
      item.entryId,
      'dhcpServer',
      null,
    )!;
    expect(networkItems(cleared)[0]!.entry.dhcpServer).toBeNull();
    expect(networkItems(cleared)[0]!.entry.dhcpStatus).toBe('Enabled');
    const disabled = editNetworkField(
      document,
      'network',
      item.entryId,
      'dhcpServer',
      false,
    )!;
    expect(networkItems(disabled)[0]!.entry.dhcpStatus).toBe('Enabled');
    expect(networkItems(document)[0]!.entry.dhcpStatus).toBe('Enabled');
  });
  it('scopes equal entry IDs by parent container and refuses port edits through another device', () => {
    const document = fixture();
    const item = networkItems(document)[0]!;
    document.elements.push({
      ...document.elements[1]!,
      id: 'other-network',
      properties: { entries: [{ ...item.entry, vlanName: 'Other parent' }] },
    });
    document.elements.push({ ...document.elements[0]!, id: 'other-device' });
    const changed = editNetworkField(
      document,
      'network',
      item.entryId,
      'vlanName',
      'Only target',
    )!;
    expect(
      networkItems(changed).find((row) => row.container.id === 'network')!.entry
        .vlanName,
    ).toBe('Only target');
    expect(
      networkItems(changed).find((row) => row.container.id === 'other-network')!
        .entry.vlanName,
    ).toBe('Other parent');
    expect(
      editPortField(document, 'other-device', 'port', 'name', 'Bad ownership'),
    ).toBeNull();
    expect(document.ports[0]!.name).toBe('1');
  });
});
