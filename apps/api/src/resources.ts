import type { DatabaseSync } from 'node:sqlite';
import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

export function siteRoute(
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
) {
  return {
    preHandler: async (request: FastifyRequest) => {
      requireAuth(request);
      const { siteId } = request.params as { siteId: string };
      if (!db.prepare('SELECT id FROM sites WHERE id=?').get(siteId))
        throw new ApiError(404, 'NOT_FOUND', 'Site not found');
    },
  };
}
export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function readSnapshot<T>(db: DatabaseSync, action: () => T): T {
  if (db.isTransaction) return action();
  db.exec('BEGIN');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Caller owns the transaction; restrictive foreign keys stay enabled. */
export function clearSiteContents(db: DatabaseSync, siteId: string): void {
  for (const table of [
    'logical_connections',
    'connections',
    'port_custom_values',
    'port_tagged_vlans',
    'ports',
    'devices',
    'dhcp_scopes',
    'subnets',
    'port_custom_field_defs',
    'racks',
    'vlans',
  ])
    db.prepare(`DELETE FROM ${table} WHERE site_id=?`).run(siteId);
}
export function mutation<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'errcode' in error
        ? error.errcode
        : undefined;
    if (code === 2067 || code === 1555)
      throw new ApiError(
        409,
        'DUPLICATE_RECORD',
        'That name, number or position is already in use',
      );
    if (code === 787)
      throw new ApiError(
        409,
        'REFERENCED_RECORD',
        'The record is referenced or belongs to another site',
      );
    if (code === 275 || code === 1811)
      throw new ApiError(
        400,
        'INVALID_CONFIGURATION',
        'The configuration violates a data rule',
      );
    throw error;
  }
}
export function staleVersion(): never {
  throw new ApiError(
    409,
    'STALE_VERSION',
    'This record changed. Reload before saving',
  );
}
