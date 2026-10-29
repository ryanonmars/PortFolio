import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardDocument,
  type BoardElement,
  type BoardPort,
} from '../../../../packages/shared/src/board.js';
import { DeviceSummary } from './DeviceSummary.js';
import { summaryPresentation } from './summary-presentation.js';

const device: BoardElement = {
  id: 'device',
  type: 'device',
  name: 'Core <Switch>',
  x: 0,
  y: 0,
  width: 600,
  height: 400,
  z: 0,
  color: '',
  properties: {
    deviceType: 'switch',
    manufacturer: 'Maker',
    model: 'Model A',
    managementAddress: 'switch.example',
    notes: 'Device notes',
    customFields: {
      Count: 0,
      Active: false,
      Empty: '',
      Nested: { value: 'yes' },
    },
    headerFields: [],
  },
};
const summary: BoardElement = {
  ...device,
  id: 'summary',
  type: 'summary' as BoardElement['type'],
  name: 'Summary',
  properties: { linkedDeviceId: 'device' },
};
function port(overrides: Partial<BoardPort> = {}): BoardPort {
  return {
    id: 'p1',
    deviceId: 'device',
    face: 'front',
    row: 0,
    column: 0,
    name: 'Port 1',
    kind: 'sfp_plus',
    color: '#aabbcc',
    role: 'Uplink',
    speed: '10G',
    linkState: 'documented down',
    nativeVlan: '0',
    taggedVlans: ['20', '30'],
    pvid: '0',
    address: '192.0.2.1/24',
    externalDestination: 'Wall jack',
    notes: 'Port notes',
    customFields: { Enabled: false, Count: 0, Empty: '', Null: null },
    ...overrides,
  };
}
function fixture(): BoardDocument {
  return {
    ...emptyBoardDocument(),
    elements: [device, summary],
    ports: [port()],
  };
}
function render(document = fixture(), element = summary) {
  return renderToStaticMarkup(
    createElement(DeviceSummary, { document, element }),
  );
}

describe('Device Summary presentation', () => {
  it('resolves only a current board device by stable ID and distinguishes cleared and deleted links', () => {
    expect(summaryPresentation(fixture(), summary).state).toBe('linked');
    expect(
      render(fixture(), { ...summary, properties: { linkedDeviceId: '' } }),
    ).toContain('Select a device in the inspector.');
    expect(render({ ...fixture(), elements: [summary] })).toContain(
      'Linked device unavailable.',
    );
    expect(
      render(fixture(), {
        ...summary,
        properties: { linkedDeviceId: 'summary' },
      }),
    ).toContain('Linked device unavailable.');
  });
  it('shows comprehensive device and port data, preserving zeros, false and documented Down', () => {
    const result = summaryPresentation(fixture(), summary);
    if (result.state !== 'linked') throw new Error('Expected linked summary');
    expect(result.name).toBe('Core <Switch>');
    expect(result.chips).toEqual(
      expect.arrayContaining([
        { key: 'deviceType', label: 'Device Type', value: 'switch' },
        { key: 'portCount', label: 'Port Count', value: '1' },
        { key: 'customFields.Count', label: 'Count', value: '0' },
        { key: 'customFields.Active', label: 'Active', value: 'false' },
      ]),
    );
    expect(result.ports[0]).toMatchObject({
      name: 'Port 1',
      connector: 'SFP+',
      color: '#aabbcc',
    });
    const html = render();
    for (const value of [
      'Maker',
      'Model A',
      'switch.example',
      'Device notes',
      'Port notes',
      'Uplink',
      '10G',
      'Down',
      '20, 30',
      '192.0.2.1/24',
      'Wall jack',
      '#aabbcc',
      'Front · Row 1 · Column 1',
      'Documented Link Status',
    ])
      expect(html).toContain(value);
    expect(html).toContain('data-field="nativeVlan"');
    expect(html).toContain('data-field="pvid"');
    expect(html).toContain('>0<');
    expect(html).toContain('>false<');
    expect(html).not.toContain('data-field="customFields.Empty"');
    expect(html).not.toContain('data-field="customFields.Null"');
    expect(html).not.toMatch(/<(input|button|details|summary)\b/);
  });
  it('orders copied ports by face then slot without changing source data or hiding rear ports', () => {
    const document = fixture();
    document.ports = [
      port({ id: 'rear', face: 'rear' }),
      port({ id: 'last', row: 1 }),
      port({ id: 'second', column: 2 }),
      port(),
    ];
    const before = JSON.stringify(document);
    const result = summaryPresentation(document, summary);
    if (result.state !== 'linked') throw new Error('Expected linked summary');
    expect(result.ports.map((item) => item.id)).toEqual([
      'p1',
      'second',
      'last',
      'rear',
    ]);
    render(document);
    expect(JSON.stringify(document)).toBe(before);
  });
  it('derives fresh names, configurations, cable peers and network colors without confusing external text with cables', () => {
    const document = fixture();
    document.elements.push(
      { ...device, id: 'peer', name: 'Edge' },
      {
        ...device,
        id: 'network',
        type: 'network',
        properties: { entries: [{ vlanId: '0', color: '#123456' }] },
      },
    );
    document.ports = [
      port({ color: '', linkState: 'maintenance window' }),
      port({ id: 'peerport', deviceId: 'peer', name: 'WAN', kind: 'rj45' }),
    ];
    document.cables = [
      {
        id: 'cable',
        sourcePortId: 'peerport',
        targetPortId: 'p1',
        name: '',
        cableType: '',
        sourceConnector: '',
        targetConnector: '',
        color: '',
        length: '',
        notes: '',
      },
    ];
    expect(render(document)).toContain('Edge / WAN');
    expect(render(document)).toContain('maintenance window');
    expect(render(document)).toContain('#123456');
    document.elements[0] = {
      ...device,
      name: 'Renamed',
      properties: { model: 'Updated' },
    };
    document.ports[0] = port({
      name: 'Changed port',
      taggedVlans: [],
      nativeVlan: '',
      pvid: '',
      linkState: '',
    });
    const html = render(document);
    for (const value of ['Renamed', 'Updated', 'Changed port'])
      expect(html).toContain(value);
    expect(html).not.toContain('data-field="nativeVlan"');
    expect(html).not.toContain('data-field="pvid"');
    document.cables = [];
    expect(render(document)).not.toContain('Edge / WAN');
    expect(render(document)).toContain('Wall jack');
  });
  it.each([8, 24, 48])(
    'renders every one of %i ports and long text safely in one scrolling body',
    (count) => {
      const document = fixture();
      document.ports = Array.from({ length: count }, (_, index) =>
        port({
          id: `p${index}`,
          name: `Port ${index + 1}`,
          column: index,
          notes: '<script>alert(1)</script>' + 'long'.repeat(200),
          customFields: { Long: 'word'.repeat(200) },
        }),
      );
      const html = render(document);
      expect(html.match(/class="board-summary-port"/g)).toHaveLength(count);
      expect(html.match(/class="board-summary-content"/g)).toHaveLength(1);
      expect(html).toContain(`Port Configuration (${count})`);
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(html).not.toContain('<script>');
      expect(html).toContain(`Port ${count}`);
    },
  );
});
