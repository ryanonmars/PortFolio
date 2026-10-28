import { describe, expect, it } from 'vitest';
import {
  bulkPortEditSchema,
  createConnectionSchema,
  createPortFieldSchema,
  validCustomValue,
} from './index.js';
const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';
describe('Configure contracts', () => {
  it('reserves core keys and rejects malformed column definitions', () => {
    for (const key of [
      'name',
      'native_vlan_ref',
      'pvid',
      'constructor',
      '__proto__',
      'row_version',
    ])
      expect(
        createPortFieldSchema.safeParse({
          key,
          title: 'Field',
          valueType: 'text',
        }).success,
      ).toBe(false);
    expect(
      createPortFieldSchema.safeParse({
        key: 'owner',
        title: 'Owner',
        valueType: 'select',
        choices: [],
      }).success,
    ).toBe(false);
    expect(
      createPortFieldSchema.safeParse({
        key: 'owner',
        title: 'Owner',
        valueType: 'select',
        choices: ['A', 'A'],
      }).success,
    ).toBe(false);
    expect(
      createPortFieldSchema.safeParse({
        key: 'watts',
        title: 'Watts',
        valueType: 'number',
        defaultValue: '0',
      }).success,
    ).toBe(false);
  });
  it('preserves typed false, zero and explicit unset', () => {
    expect(validCustomValue({ valueType: 'number', choices: [] }, 0)).toBe(
      true,
    );
    expect(validCustomValue({ valueType: 'boolean', choices: [] }, false)).toBe(
      true,
    );
    expect(validCustomValue({ valueType: 'text', choices: [] }, null)).toBe(
      true,
    );
    expect(validCustomValue({ valueType: 'number', choices: [] }, '0')).toBe(
      false,
    );
    expect(
      validCustomValue({ valueType: 'boolean', choices: [] }, 'false'),
    ).toBe(false);
    expect(
      validCustomValue({ valueType: 'number', choices: [] }, Infinity),
    ).toBe(false);
  });
  it('requires real dates and exact select choices', () => {
    expect(
      validCustomValue({ valueType: 'date', choices: [] }, '2024-02-29'),
    ).toBe(true);
    for (const value of ['2025-02-29', '2025-04-31', '2025-1-1', 'yesterday'])
      expect(validCustomValue({ valueType: 'date', choices: [] }, value)).toBe(
        false,
      );
    expect(
      validCustomValue({ valueType: 'select', choices: ['Yes'] }, 'yes'),
    ).toBe(false);
  });
  it('rejects duplicate targets, unknown ownership changes and missing row versions', () => {
    const update = { portId: a, rowVersion: 1, changes: { mode: 'routed' } };
    expect(
      bulkPortEditSchema.safeParse({ updates: [update, update] }).success,
    ).toBe(false);
    expect(
      bulkPortEditSchema.safeParse({
        updates: [{ ...update, changes: { siteId: b } }],
      }).success,
    ).toBe(false);
    expect(
      bulkPortEditSchema.safeParse({ updates: [{ portId: a, changes: {} }] })
        .success,
    ).toBe(false);
    expect(bulkPortEditSchema.safeParse({ updates: [] }).success).toBe(false);
  });
  it('requires distinct, versioned endpoints and an explicit replacement list', () => {
    const input = {
      endpointAPortId: a,
      endpointBPortId: b,
      endpointARowVersion: 1,
      endpointBRowVersion: 1,
    };
    expect(createConnectionSchema.parse(input).replaceConnections).toEqual([]);
    expect(
      createConnectionSchema.safeParse({ ...input, endpointBPortId: a })
        .success,
    ).toBe(false);
    expect(
      createConnectionSchema.safeParse({
        ...input,
        replaceConnections: [
          { id: a, rowVersion: 1 },
          { id: a, rowVersion: 1 },
        ],
      }).success,
    ).toBe(false);
  });
});
