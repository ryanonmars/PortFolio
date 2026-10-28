import { describe, expect, it } from 'vitest';
import { createTemplateSchema, templatePortGroupsSchema } from './templates.js';
describe('reusable port layout validation', () => {
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
