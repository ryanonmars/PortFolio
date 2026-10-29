import { describe, expect, it } from 'vitest';
import {
  boardDocumentSchema,
  emptyBoardDocument,
  type BoardDocument,
  type BoardPort,
  type BoardRecord,
} from '../../../../packages/shared/src/board.js';
import { makeBoardPort } from './commands.js';
import { BoardSession } from './session.js';
import {
  copyPortField,
  copyPortSettings,
  pastePortSettings,
  portClipboardLabel,
  portClipboardSchema,
  portSelectionRange,
  portSettingKeys,
  type PortClipboard,
} from './port-clipboard.js';

function fixture(): BoardDocument {
  const document = emptyBoardDocument();
  document.elements = ['router', 'switch'].map((id, index) => ({
    id,
    type: 'device',
    name: id,
    x: index * 1300,
    y: -50,
    width: 1200,
    height: 600,
    z: index,
    color: '',
    properties: { deviceType: 'Custom' },
  }));
  const source: BoardPort = {
    ...makeBoardPort('router', 'sfp_plus', 0, 0, 'Source'),
    id: 'source',
    role: 'LAN / freely authored purpose',
    speed: 'arbitrary speed',
    linkState: 'legacy documented state',
    nativeVlan: 'No definition required',
    taggedVlans: ['voice', '0', '30'],
    pvid: '0',
    address: 'router.example / any annotation',
    externalDestination: 'Outside',
    color: '#12ab34',
    notes: 'Keep authored notes',
    customFields: {
      Zero: 0,
      Enabled: false,
      Empty: '',
      List: [],
      Nested: { values: ['one'] },
    },
  };
  document.ports = [
    source,
    {
      ...makeBoardPort('router', 'rj45', 2, 3, 'Destination A'),
      id: 'a',
      pvid: '99',
      notes: 'A notes',
      customFields: { Retain: 'A' },
    },
    {
      ...makeBoardPort('switch', 'qsfp', 1, 5, 'Destination B', 'rear'),
      id: 'b',
      pvid: '80',
      address: 'unique address',
      customFields: { Retain: 'B' },
    },
    { ...makeBoardPort('router', 'sfp', 3, 7, 'Unselected'), id: 'other' },
  ];
  document.cables = [
    {
      id: 'cable',
      sourcePortId: 'a',
      targetPortId: 'b',
      name: 'Existing cable',
      cableType: 'Authored',
      sourceConnector: 'A',
      targetConnector: 'B',
      color: '#123456',
      length: 'long',
      notes: 'Retain cable metadata',
    },
  ];
  return document;
}
const byId = (document: BoardDocument, id: string) =>
  document.ports.find((port) => port.id === id)!;
const settings = (port: BoardPort) =>
  Object.fromEntries(portSettingKeys.map((key) => [key, port[key]]));
const placement = ({ id, deviceId, name, face, row, column }: BoardPort) => ({
  id,
  deviceId,
  name,
  face,
  row,
  column,
});

describe('structured port clipboard', () => {
  it('copies exactly the supported configuration and detaches every nested value', () => {
    const document = fixture(),
      source = byId(document, 'source');
    const clipboard = copyPortSettings(source);
    expect(clipboard).toEqual({
      version: 1,
      type: 'port-settings',
      settings: settings(source),
    });
    expect(clipboard.type).toBe('port-settings');
    if (clipboard.type !== 'port-settings')
      throw new Error('Wrong clipboard type');
    for (const key of [
      'id',
      'name',
      'deviceId',
      'face',
      'row',
      'column',
      'cables',
    ])
      expect(Object.hasOwn(clipboard.settings, key)).toBe(false);
    expect(clipboard.settings.customFields).not.toBe(source.customFields);
    expect(clipboard.settings.taggedVlans).not.toBe(source.taggedVlans);
    source.customFields.Nested = { values: ['changed'] };
    source.taggedVlans.push('later');
    expect(clipboard.settings.customFields.Nested).toEqual({ values: ['one'] });
    expect(clipboard.settings.taggedVlans).toEqual(['voice', '0', '30']);
  });

  it('pastes all settings across devices while retaining names, identities, slots and cable records', () => {
    const document = fixture(),
      before = structuredClone(document);
    const result = pastePortSettings(
      document,
      copyPortSettings(byId(document, 'source')),
      ['a', 'b', 'a'],
    );
    expect(document).toEqual(before);
    for (const id of ['a', 'b']) {
      expect(settings(byId(result, id))).toEqual(
        settings(byId(document, 'source')),
      );
      expect(placement(byId(result, id))).toEqual(
        placement(byId(document, id)),
      );
    }
    expect(byId(result, 'source')).toBe(byId(document, 'source'));
    expect(byId(result, 'other')).toBe(byId(document, 'other'));
    expect(result.elements).toBe(document.elements);
    expect(result.cables).toBe(document.cables);
    expect(result.viewport).toBe(document.viewport);
    expect(boardDocumentSchema.safeParse(result).success).toBe(true);
    byId(result, 'a').taggedVlans.push('destination-only');
    (byId(result, 'a').customFields.Nested as { values: string[] }).values.push(
      'A only',
    );
    expect(byId(result, 'b').taggedVlans).toEqual(['voice', '0', '30']);
    expect(byId(result, 'b').customFields.Nested).toEqual({ values: ['one'] });
    expect(document).toEqual(before);
  });

  it('keeps an independent snapshot after the source has changed or been deleted', () => {
    const document = fixture();
    const payload = copyPortSettings(byId(document, 'source'));
    const original = structuredClone(payload);
    document.ports = document.ports.filter((port) => port.id !== 'source');
    const first = pastePortSettings(document, payload, ['a']);
    byId(first, 'a').customFields.Zero = 42;
    const second = pastePortSettings(document, payload, ['b']);
    expect(byId(second, 'b').customFields.Zero).toBe(0);
    expect(payload).toEqual(original);
  });

  it('copies and applies all empty settings to intentionally clear destination configuration', () => {
    const document = fixture();
    const blank = makeBoardPort('router', 'other', 0, 0, 'Blank source');
    const payload = copyPortSettings(blank);
    const result = pastePortSettings(document, payload, ['source']);
    expect(settings(byId(result, 'source'))).toEqual(settings(blank));
    expect(placement(byId(result, 'source'))).toEqual(
      placement(byId(document, 'source')),
    );
    expect(byId(result, 'source').taggedVlans).toEqual([]);
    expect(byId(result, 'source').customFields).toEqual({});
  });

  it.each(portSettingKeys.filter((key) => key !== 'customFields'))(
    'copies only %s without changing another setting',
    (key) => {
      const document = fixture(),
        source = byId(document, 'source');
      const payload = copyPortField(source, key);
      const result = pastePortSettings(document, payload, ['a', 'b']);
      expect(payload).toEqual({
        version: 1,
        type: 'port-field',
        field: key,
        value: source[key],
      });
      for (const id of ['a', 'b'])
        expect(byId(result, id)).toEqual({
          ...byId(document, id),
          [key]: source[key],
        });
      expect(result.cables).toBe(document.cables);
    },
  );

  it('preserves string zero and empty arrays/strings during one-field paste', () => {
    const document = fixture();
    const zero = pastePortSettings(
      document,
      copyPortField(byId(document, 'source'), 'pvid'),
      ['a'],
    );
    expect(byId(zero, 'a').pvid).toBe('0');
    const blank = makeBoardPort('router', 'rj45', 0, 0, 'Blank');
    const cleared = pastePortSettings(
      zero,
      copyPortField(blank, 'taggedVlans'),
      ['source'],
    );
    expect(byId(cleared, 'source')).toEqual({
      ...byId(zero, 'source'),
      taggedVlans: [],
    });
    const empty = pastePortSettings(cleared, copyPortField(blank, 'pvid'), [
      'a',
    ]);
    expect(byId(empty, 'a')).toEqual({ ...byId(cleared, 'a'), pvid: '' });
  });

  it.each(['Zero', 'Enabled', 'Empty', 'List', 'Nested'])(
    'copies custom field %s including explicit false/zero/empty values',
    (key) => {
      const document = fixture(),
        source = byId(document, 'source');
      const clipboard = copyPortField(source, 'customFields', key);
      const result = pastePortSettings(document, clipboard, ['a', 'b']);
      for (const id of ['a', 'b'])
        expect(byId(result, id).customFields).toEqual({
          ...byId(document, id).customFields,
          [key]: source.customFields[key],
        });
      expect(clipboard).toEqual({
        version: 1,
        type: 'port-field',
        field: 'customFields',
        key,
        value: source.customFields[key],
      });
    },
  );

  it('copies custom null and empty keys, safely retaining own constructor/prototype names', () => {
    const document = fixture();
    const source = byId(document, 'source');
    source.customFields = Object.fromEntries([
      ['constructor', false],
      ['prototype', 0],
      ['', null],
    ]);
    for (const key of ['constructor', 'prototype', '']) {
      const result = pastePortSettings(
        document,
        copyPortField(source, 'customFields', key),
        ['a'],
      );
      expect(Object.hasOwn(byId(result, 'a').customFields, key)).toBe(true);
      expect(byId(result, 'a').customFields[key]).toEqual(
        source.customFields[key],
      );
      expect(Object.getPrototypeOf(byId(result, 'a').customFields)).toBe(
        Object.prototype,
      );
    }
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('rejects invalid payload versions, identity/layout fields, partial settings and unrelated text', () => {
    const full = copyPortSettings(byId(fixture(), 'source'));
    const invalid: unknown[] = [
      'ordinary clipboard text',
      null,
      {},
      { ...full, version: 2 },
      { ...full, id: 'overwrite' },
      { version: 1, type: 'port-settings', settings: { pvid: '20' } },
      ...[
        'id',
        'name',
        'deviceId',
        'row',
        'column',
        'face',
        'cables',
        'unknown',
      ].map((field) => ({ version: 1, type: 'port-field', field, value: 'x' })),
      { version: 1, type: 'port-field', field: 'pvid', value: 0 },
      { version: 1, type: 'port-field', field: 'taggedVlans', value: [0] },
      { version: 1, type: 'port-field', field: 'kind', value: 'anything' },
      { version: 1, type: 'port-field', field: 'color', value: 'red' },
      { version: 1, type: 'port-field', field: 'customFields', key: 'x' },
      {
        version: 1,
        type: 'port-field',
        field: 'pvid',
        value: '1',
        key: 'unexpected',
      },
      { version: 1, type: 'port-field', field: 'pvid', value: '1', row: 2 },
    ];
    for (const payload of invalid)
      expect(portClipboardSchema.safeParse(payload).success).toBe(false);
    if (full.type !== 'port-settings') throw new Error('Wrong clipboard type');
    expect(
      portClipboardSchema.safeParse({
        ...full,
        settings: { ...full.settings, name: 'overwrite' },
      }).success,
    ).toBe(false);
    expect(
      portClipboardSchema.safeParse({
        ...full,
        settings: { ...full.settings, pvid: 'x'.repeat(10001) },
      }).success,
    ).toBe(false);
    expect(
      portClipboardSchema.safeParse({
        ...full,
        settings: { ...full.settings, taggedVlans: Array(513).fill('x') },
      }).success,
    ).toBe(false);
  });

  it('rejects reserved keys, cycles and non-JSON values instead of silently discarding them', () => {
    const field = {
      version: 1,
      type: 'port-field',
      field: 'customFields',
      key: 'Nested',
      value: {},
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      cyclic,
      new Date(),
      Object.fromEntries([['__proto__', { polluted: true }]]),
    ])
      expect(portClipboardSchema.safeParse({ ...field, value }).success).toBe(
        false,
      );
    expect(
      portClipboardSchema.safeParse({
        ...field,
        key: '__proto__',
        value: 'no silent loss',
      }).success,
    ).toBe(false);
    const payload = copyPortSettings(byId(fixture(), 'source'));
    if (payload.type !== 'port-settings')
      throw new Error('Wrong clipboard type');
    payload.settings.customFields = Object.fromEntries([
      ['__proto__', { polluted: true }],
    ]);
    expect(portClipboardSchema.safeParse(payload).success).toBe(false);
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
  });

  it('rejects unavailable destinations atomically and never changes the source document on failure', () => {
    const document = fixture(),
      before = structuredClone(document);
    const payload = copyPortSettings(byId(document, 'source'));
    for (const ids of [[], ['a', 'deleted'], ['foreign-board-id']])
      expect(() => pastePortSettings(document, payload, ids)).toThrow();
    expect(() => pastePortSettings(document, { version: 99 }, ['a'])).toThrow();
    expect(document).toEqual(before);
  });

  it('rejects missing custom keys and unknown copy-field identities', () => {
    const port = byId(fixture(), 'source');
    expect(() => copyPortField(port, 'customFields')).toThrow(
      /existing custom field/,
    );
    expect(() => copyPortField(port, 'customFields', 'missing')).toThrow(
      /existing custom field/,
    );
    expect(() => copyPortField(port, 'pvid', 'not a custom field')).toThrow();
    expect(() => copyPortField(port, 'id' as 'pvid')).toThrow();
  });

  it('provides specific feedback labels', () => {
    const port = byId(fixture(), 'source');
    expect(portClipboardLabel(copyPortSettings(port))).toBe('Port settings');
    expect(portClipboardLabel(copyPortField(port, 'pvid'))).toBe('PVID');
    expect(portClipboardLabel(copyPortField(port, 'taggedVlans'))).toBe(
      'Tagged VLANs',
    );
    expect(
      portClipboardLabel(copyPortField(port, 'customFields', 'Zero')),
    ).toBe('Zero');
  });
});

describe('logical port selection ranges', () => {
  it('uses document creation order rather than custom names, physical placement or another face/device', () => {
    const document = fixture();
    expect(portSelectionRange(document, 'source', 'other')).toEqual([
      'source',
      'a',
      'other',
    ]);
    expect(portSelectionRange(document, 'other', 'source')).toEqual([
      'source',
      'a',
      'other',
    ]);
    expect(portSelectionRange(document, 'source', 'a')).toEqual([
      'source',
      'a',
    ]);
    expect(portSelectionRange(document, 'a', 'a')).toEqual(['a']);
    for (const [anchor, target] of [
      ['source', 'b'],
      ['missing', 'a'],
      ['a', 'missing'],
    ])
      expect(portSelectionRange(document, anchor!, target!)).toEqual([]);
    byId(document, 'other').face = 'rear';
    expect(portSelectionRange(document, 'a', 'other')).toEqual([]);
  });
});

describe('paste history and recovery', () => {
  it('saves all destinations once, restores them with one Undo/Redo, and retains recoverable state on failure', async () => {
    const document = fixture(),
      original = structuredClone(document);
    const board: BoardRecord = {
      id: 'board',
      name: 'Clipboard board',
      groupId: null,
      order: 0,
      rowVersion: 1,
      document,
    };
    const writes: BoardDocument[] = [];
    let fail = true;
    const session = new BoardSession(
      board.id,
      board,
      async (_id, next, rowVersion) => {
        if (fail) throw new Error('Synthetic save unavailable');
        writes.push(next);
        return { ...board, document: next, rowVersion: rowVersion + 1 };
      },
      () => {},
      100000,
    );
    const payload: PortClipboard = copyPortSettings(byId(document, 'source'));
    const pasted = pastePortSettings(session.document, payload, ['a', 'b']);
    session.update(pasted, 'Paste port settings');
    await expect(session.flush()).rejects.toThrow('Synthetic save unavailable');
    expect(session.state).toBe('error');
    expect(session.document).toEqual(pasted);
    expect(session.dirty).toBe(true);
    fail = false;
    await session.retry();
    expect(writes).toEqual([pasted]);
    expect(session.dirty).toBe(false);
    session.undo();
    expect(session.document).toEqual(original);
    expect(session.canUndo).toBe(false);
    session.redo();
    expect(session.document).toEqual(pasted);
    await session.flush();
    expect(JSON.parse(JSON.stringify(writes.at(-1)))).toEqual(pasted);
    expect(session.document.cables).toEqual(original.cables);
    session.dispose();
  });
});
