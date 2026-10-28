import { describe, expect, it } from 'vitest';
import {
  createTemplateSchema,
  templatePortGroupsSchema,
  addTemplatePortsSchema,
} from './templates.js';
describe('reusable port layout validation', () => {
  it('requires a current version and nonempty appended layout without allowing record references', () => {
    expect(
      addTemplatePortsSchema.safeParse({
        rowVersion: 1,
        groups: [{ count: 1, kind: 'sfp', face: 'rear' }],
      }).success,
    ).toBe(true);
    for (const value of [
      { rowVersion: 0, groups: [{ count: 1 }] },
      { rowVersion: 1, groups: [] },
      { rowVersion: 1, groups: [{ count: 0 }] },
      { rowVersion: 1, groups: [{ count: 1, siteId: 'forbidden' }] },
    ])
      expect(addTemplatePortsSchema.safeParse(value).success).toBe(false);
  });
  it('rejects duplicate generated names across groups using SQLite case semantics', () => {
    expect(
      templatePortGroupsSchema.safeParse([
        { count: 1, namePrefix: 'Port 1' },
        { count: 10, namePrefix: 'port ' },
      ]).success,
    ).toBe(false);
    expect(
      createTemplateSchema.safeParse({
        name: 'Conflicting layout',
        groups: [
          { count: 1, namePrefix: 'Port 1' },
          { count: 10, namePrefix: 'port ' },
        ],
      }).success,
    ).toBe(false);
  });
  it('accepts mixed faces and custom empty groups within the aggregate limit', () => {
    expect(
      templatePortGroupsSchema.safeParse([
        { count: 510, kind: 'rj45' },
        { count: 2, kind: 'sfp_plus', face: 'rear', namePrefix: 'Uplink ' },
      ]).success,
    ).toBe(true);
    expect(templatePortGroupsSchema.safeParse([]).success).toBe(true);
    expect(
      templatePortGroupsSchema.safeParse([{ count: 512 }, { count: 1 }])
        .success,
    ).toBe(false);
  });
});
