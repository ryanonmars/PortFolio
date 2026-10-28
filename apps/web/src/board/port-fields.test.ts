import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  emptyBoardDocument,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import { BoardInspector } from './BoardInspector.js';
import { addPorts, makeBoardPort } from './commands.js';
import {
  knownLinkStatus,
  portHelp,
  purposeSuggestions,
  speedSuggestions,
} from './port-fields.js';

describe('port terminology and documented status', () => {
  it.each([
    ['', 'unknown'],
    ['  ', 'unknown'],
    ['Unknown', 'unknown'],
    ['UP', 'up'],
    [' down ', 'down'],
    [' Documented UP ', 'up'],
    ['documented down', 'down'],
    ['Documented Unknown', 'unknown'],
    ['intermittent / provider notes', null],
    ['disabled', null],
    ['active', null],
    ['connected', null],
    ['documented documented up', null],
  ])('normalizes only recognizable %s for display', (raw, expected) => {
    expect(knownLinkStatus(raw)).toBe(expected);
  });

  it('defaults all new port creation paths to Unknown without modifying existing records', () => {
    expect(makeBoardPort('device', 'sfp_plus', 0, 0, 'WAN').linkState).toBe(
      'unknown',
    );
    const device: BoardElement = {
      id: 'device',
      type: 'device',
      name: 'Switch',
      x: 0,
      y: 0,
      width: 320,
      height: 220,
      z: 0,
      color: '',
      properties: {},
    };
    const existing = makeBoardPort(device.id, 'rj45', 0, 0, 'Existing');
    existing.linkState = ' Not verified by provider ';
    const document = {
      ...emptyBoardDocument(),
      elements: [device],
      ports: [existing],
    };
    const next = addPorts(document, device.id, 'rj45', 1, 'front');
    expect(next.ports[0]).toEqual(existing);
    expect(next.ports[1]!.linkState).toBe('unknown');
    expect(document.ports).toEqual([existing]);
  });

  it('renders renamed fields, associated help, free text suggestions and an untouched legacy status', () => {
    const device: BoardElement = {
      id: 'device',
      type: 'device',
      name: 'Switch',
      x: 0,
      y: 0,
      width: 320,
      height: 220,
      z: 0,
      color: '',
      properties: {},
    };
    const port = {
      ...makeBoardPort(device.id, 'rj45', 0, 0, 'WAN'),
      linkState: 'provider testing',
      role: 'Anything authored',
      nativeVlan: '20',
      pvid: '7',
      address: 'DHCP or hostname',
      externalDestination: 'Wall Jack A12',
    };
    const document = {
      ...emptyBoardDocument(),
      elements: [device],
      ports: [port],
    };
    const before = JSON.stringify(document);
    const change = vi.fn();
    const html = renderToStaticMarkup(
      createElement(BoardInspector, {
        document,
        selection: { type: 'port', id: port.id },
        onChange: change,
        onClose: vi.fn(),
        onDelete: vi.fn(),
        onDuplicate: vi.fn(),
      }),
    );
    for (const label of Object.keys(portHelp)) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`aria-label="Help for ${label}"`);
    }
    expect(html.match(/role="tooltip"/g)).toHaveLength(8);
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('Saved: provider testing');
    expect(html).toContain('PortFolio does not monitor live port status.');
    expect(html).toContain('PVID is independent of the Native VLAN field.');
    expect(html).toContain('Anything authored');
    expect(html).toContain('Wall Jack A12');
    expect(html).not.toContain('aria-label="Port role"');
    expect(html).not.toContain('aria-label="Documented link state"');
    expect(purposeSuggestions).toContain('Uplink');
    expect(speedSuggestions).toContain('2.5G');
    expect(change).not.toHaveBeenCalled();
    expect(JSON.stringify(document)).toBe(before);
  });
});
