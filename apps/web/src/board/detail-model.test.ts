import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardElement,
  type BoardPort,
} from '../../../../packages/shared/src/board.js';
import {
  boardPagePath,
  parseBoardLocation,
  resolveBoardLocation,
  networkItems,
  findNetwork,
  deviceItems,
  portPeer,
  type BoardPage,
} from './detail-model.js';

const element = (id: string, type: BoardElement['type']): BoardElement => ({
  id,
  type,
  name: 'Same',
  x: 0,
  y: 0,
  width: 320,
  height: 220,
  z: 0,
  color: '',
  properties: {},
});
const port = (id: string, deviceId: string): BoardPort => ({
  id,
  deviceId,
  name: 'Same',
  face: 'front',
  row: 0,
  column: 0,
  kind: 'rj45',
  color: '',
  role: '',
  speed: '',
  linkState: '',
  nativeVlan: '1',
  taggedVlans: [],
  pvid: '',
  address: 'same',
  externalDestination: '',
  notes: '',
  customFields: {},
});

describe('board detail route identity', () => {
  it('keeps safely decoded board context for malformed destinations', () => {
    for (const suffix of [
      '/networks/parent/%',
      '/networks/parent',
      '/devices/',
      '/unknown',
    ])
      expect(resolveBoardLocation(`/boards/board%252F${suffix}`)).toEqual({
        boardId: 'board%2F',
        page: { kind: 'unavailable' },
      });
    expect(resolveBoardLocation('/boards/%E0%A4%A/devices/x')).toBeNull();
    expect(resolveBoardLocation('/boards//devices/x')).toBeNull();
    expect(resolveBoardLocation('/other/board')).toBeNull();
    expect(resolveBoardLocation('/boards/b/devices/d')).toEqual({
      boardId: 'b',
      page: { kind: 'device', deviceId: 'd' },
    });
    const path = boardPagePath('board /', { kind: 'unavailable' });
    expect(parseBoardLocation(path)).toEqual({
      boardId: 'board /',
      page: { kind: 'unavailable' },
    });
  });
  it.each<BoardPage>([
    { kind: 'canvas' },
    { kind: 'canvas', focusId: 'object /?#%雪' },
    { kind: 'networks' },
    { kind: 'devices' },
    { kind: 'device', deviceId: '__proto__ /雪' },
    { kind: 'network', containerId: 'net /#', entryId: 'entry ?%雪' },
  ])('round-trips encoded IDs for $kind', (page) => {
    const path = boardPagePath('board /?雪', page);
    const [pathname, search] = path.split('?');
    expect(parseBoardLocation(pathname!, search ? `?${search}` : '')).toEqual({
      boardId: 'board /?雪',
      page,
    });
  });
  it.each([
    '/boards',
    '/boards/',
    '/boards/b/',
    '/boards/b/networks/n',
    '/boards/b/networks/n/e/extra',
    '/boards/b/devices',
    '/boards/b/devices/',
    '/boards/b/devices/%',
    '/boards/%E0%A4%A',
    '/other/b',
  ])('rejects malformed or missing routes: %s', (path) => {
    if (path === '/boards/b/devices')
      expect(parseBoardLocation(path)?.page).toEqual({ kind: 'devices' });
    else expect(parseBoardLocation(path)).toBeNull();
  });
  it('rejects malformed canvas focus instead of decoding to a different identity', () => {
    expect(parseBoardLocation('/boards/b', '?focus=%E0%A4%A')).toBeNull();
  });
});

describe('board detail selectors', () => {
  it('resolves duplicate labels only by both parent and entry identity', () => {
    const document = emptyBoardDocument();
    document.elements = ['a', 'b'].map((id): BoardElement => ({
      ...element(id, 'network'),
      properties: {
        entries: [
          { networkEntryId: 'shared', vlanName: 'Same', vlanId: '1' },
          { vlanName: 'Same', vlanId: '1' },
          null,
          'unstructured',
        ],
      },
    }));
    const items = networkItems(document);
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.label)).toEqual([
      'VLAN 1 — Same',
      'VLAN 1 — Same',
      'VLAN 1 — Same',
      'VLAN 1 — Same',
    ]);
    expect(findNetwork(document, 'b', 'shared')?.container.id).toBe('b');
    expect(findNetwork(document, 'missing', 'shared')).toBeUndefined();
    expect(findNetwork(document, 'a', 'missing')).toBeUndefined();
    expect(networkItems(document)).toEqual(items);
  });
  it('excludes other object types and derives peers exclusively from real cables', () => {
    const document = emptyBoardDocument();
    document.elements = [
      element('a', 'device'),
      element('b', 'device'),
      element('n', 'network'),
    ];
    document.ports = [port('one', 'a'), port('two', 'b')];
    expect(deviceItems(document).map((item) => item.id)).toEqual(['a', 'b']);
    expect(portPeer(document, document.ports[0]!)).toBeNull();
    document.cables = [
      {
        id: 'cable',
        sourcePortId: 'one',
        targetPortId: 'two',
        name: '',
        cableType: '',
        sourceConnector: '',
        targetConnector: '',
        color: '',
        length: '',
        notes: '',
      },
    ];
    expect(portPeer(document, document.ports[0]!)).toEqual({
      device: document.elements[1],
      port: document.ports[1],
    });
    expect(portPeer(document, document.ports[1]!)?.port.id).toBe('one');
    expect(portPeer(document, port('one', 'foreign'))).toBeNull();
    document.ports[1]!.deviceId = 'n';
    expect(portPeer(document, document.ports[0]!)).toBeNull();
  });
});
