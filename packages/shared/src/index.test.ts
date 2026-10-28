import { describe, expect, it } from 'vitest';
import {
  credentialsSchema,
  createSiteSchema,
  createWorkspaceSchema,
  updateSiteSchema,
  versionSchema,
} from './index.js';

describe('organization contracts', () => {
  it('requires a substantial password and bounded username', () => {
    expect(
      credentialsSchema.safeParse({ username: 'admin', password: 'short' })
        .success,
    ).toBe(false);
    expect(
      credentialsSchema.safeParse({
        username: '<admin>',
        password: 'long-test-password',
      }).success,
    ).toBe(false);
    expect(
      credentialsSchema.parse({
        username: 'admin',
        password: 'long-test-password',
      }).username,
    ).toBe('admin');
  });
  it('rejects empty organization names and normalizes whitespace', () => {
    expect(createWorkspaceSchema.safeParse({ name: '   ' }).success).toBe(
      false,
    );
    expect(createWorkspaceSchema.parse({ name: '  Lab  ' })).toEqual({
      name: 'Lab',
      description: '',
    });
  });
  it('requires no rack, subnet or VLAN to create a site', () => {
    expect(createSiteSchema.parse({ name: 'Site' })).toEqual({
      name: 'Site',
      description: '',
      notes: '',
    });
  });
  it('rejects client-supplied ownership and stale malformed version fields', () => {
    expect(
      createSiteSchema.safeParse({ name: 'Site', workspaceId: 'other' })
        .success,
    ).toBe(false);
    expect(updateSiteSchema.safeParse({ name: 'New' }).success).toBe(false);
    expect(versionSchema.safeParse({ rowVersion: 0 }).success).toBe(false);
    expect(versionSchema.safeParse({ rowVersion: 1.5 }).success).toBe(false);
  });
});
