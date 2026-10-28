import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  addressInSubnet,
  createDhcpScopeSchema,
  createRackSchema,
  createSubnetSchema,
  createVlanSchema,
  dhcpScopeRecordSchema,
  rackRecordSchema,
  subnetRecordSchema,
  updateDhcpScopeSchema,
  updateRackSchema,
  updateSubnetSchema,
  updateVlanSchema,
  versionSchema,
  vlanRecordSchema,
  type DhcpScope,
  type Rack,
  type Subnet,
  type Vlan,
} from '../../../packages/shared/src/index.js';
import { ApiError, validate } from './errors.js';
import { mutation, siteRoute, staleVersion, transaction } from './resources.js';

const vlanColumns =
  'id, site_id AS siteId, vlan_id AS vlanId, name, color_hex AS color, description, row_version AS rowVersion';
const rackColumns =
  'id, site_id AS siteId, name, description, order_index AS orderIndex, row_version AS rowVersion';
const subnetColumns =
  'id, site_id AS siteId, vlan_ref AS vlanRef, cidr, name, gateway_ip AS gatewayIp, dns_servers_json AS dnsServers, notes, row_version AS rowVersion';
const scopeColumns =
  'id, site_id AS siteId, subnet_id AS subnetId, name, start_ip AS startIp, end_ip AS endIp, enabled, notes, row_version AS rowVersion';
type SubnetRow = Omit<Subnet, 'dnsServers'> & { dnsServers: string };
type ScopeRow = Omit<DhcpScope, 'enabled'> & { enabled: number };
const fromSubnet = (row: SubnetRow): Subnet => ({
  ...row,
  dnsServers: JSON.parse(row.dnsServers) as string[],
});
const fromScope = (row: ScopeRow): DhcpScope => ({
  ...row,
  enabled: row.enabled === 1,
});
const params = (request: FastifyRequest) =>
  request.params as Record<string, string>;

export function registerNetwork(
  app: FastifyInstance,
  db: DatabaseSync,
  requireAuth: (request: FastifyRequest) => unknown,
) {
  const protectedSite = siteRoute(db, requireAuth);
  const write = <T>(action: () => T): T =>
    mutation(() => transaction(db, action));
  const missing = (entity: string): never => {
    throw new ApiError(404, 'NOT_FOUND', `${entity} not found`);
  };
  const referenced = (message: string): never => {
    throw new ApiError(409, 'REFERENCED_RECORD', message);
  };
  const findVlan = (siteId: string, id: string): Vlan =>
    (db
      .prepare(`SELECT ${vlanColumns} FROM vlans WHERE site_id=? AND id=?`)
      .get(siteId, id) as Vlan | undefined) ?? missing('VLAN');
  const findRack = (siteId: string, id: string): Rack =>
    (db
      .prepare(`SELECT ${rackColumns} FROM racks WHERE site_id=? AND id=?`)
      .get(siteId, id) as Rack | undefined) ?? missing('Rack');
  const findSubnet = (siteId: string, id: string): Subnet => {
    const row = db
      .prepare(`SELECT ${subnetColumns} FROM subnets WHERE site_id=? AND id=?`)
      .get(siteId, id) as SubnetRow | undefined;
    return row ? fromSubnet(row) : missing('Subnet');
  };
  const findScope = (
    siteId: string,
    subnetId: string,
    id: string,
  ): DhcpScope => {
    const row = db
      .prepare(
        `SELECT ${scopeColumns} FROM dhcp_scopes WHERE site_id=? AND subnet_id=? AND id=?`,
      )
      .get(siteId, subnetId, id) as ScopeRow | undefined;
    return row ? fromScope(row) : missing('DHCP scope');
  };
  const checkRange = (
    subnet: Subnet,
    scope: Pick<DhcpScope, 'startIp' | 'endIp'>,
  ) => {
    if (
      !addressInSubnet(subnet.cidr, scope.startIp, true) ||
      !addressInSubnet(subnet.cidr, scope.endIp, true)
    ) {
      throw new ApiError(
        400,
        'INVALID_DHCP_RANGE',
        'DHCP range must use addresses within its subnet',
      );
    }
  };
  const checkVersion = (current: { rowVersion: number }, expected: number) => {
    if (current.rowVersion !== expected) staleVersion();
  };

  app.get('/api/v1/sites/:siteId/vlans', protectedSite, async (request) => ({
    vlans: db
      .prepare(
        `SELECT ${vlanColumns} FROM vlans WHERE site_id=? ORDER BY vlan_id,id`,
      )
      .all(params(request).siteId!),
  }));
  app.get(
    '/api/v1/sites/:siteId/vlans/:vlanId',
    protectedSite,
    async (request) => ({
      vlan: findVlan(params(request).siteId!, params(request).vlanId!),
    }),
  );
  app.post(
    '/api/v1/sites/:siteId/vlans',
    protectedSite,
    async (request, reply) => {
      const input = validate(createVlanSchema, request.body);
      const vlan = write(() => {
        const id = randomUUID();
        const siteId = params(request).siteId!;
        db.prepare(
          'INSERT INTO vlans (id,site_id,vlan_id,name,color_hex,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        ).run(
          id,
          siteId,
          input.vlanId,
          input.name,
          input.color,
          input.description,
          Date.now(),
          Date.now(),
        );
        return findVlan(siteId, id);
      });
      return reply.code(201).send({ vlan });
    },
  );
  app.patch(
    '/api/v1/sites/:siteId/vlans/:vlanId',
    protectedSite,
    async (request) => {
      const input = validate(updateVlanSchema, request.body);
      return {
        vlan: write(() => {
          const current = findVlan(
            params(request).siteId!,
            params(request).vlanId!,
          );
          checkVersion(current, input.rowVersion);
          const candidate = validate(vlanRecordSchema, {
            ...current,
            ...input,
          });
          const result = db
            .prepare(
              'UPDATE vlans SET vlan_id=?,name=?,color_hex=?,description=?,updated_at=?,row_version=row_version+1 WHERE site_id=? AND id=? AND row_version=?',
            )
            .run(
              candidate.vlanId,
              candidate.name,
              candidate.color,
              candidate.description,
              Date.now(),
              current.siteId,
              current.id,
              input.rowVersion,
            );
          if (!result.changes) staleVersion();
          return findVlan(current.siteId, current.id);
        }),
      };
    },
  );
  app.delete(
    '/api/v1/sites/:siteId/vlans/:vlanId',
    protectedSite,
    async (request, reply) => {
      const input = validate(versionSchema, request.body);
      write(() => {
        const current = findVlan(
          params(request).siteId!,
          params(request).vlanId!,
        );
        checkVersion(current, input.rowVersion);
        const used = db
          .prepare(
            'SELECT 1 FROM ports WHERE site_id=? AND native_vlan_ref=? UNION ALL SELECT 1 FROM port_tagged_vlans WHERE site_id=? AND vlan_ref=? UNION ALL SELECT 1 FROM subnets WHERE site_id=? AND vlan_ref=? LIMIT 1',
          )
          .get(
            current.siteId,
            current.id,
            current.siteId,
            current.id,
            current.siteId,
            current.id,
          );
        if (used)
          referenced(
            'Remove native, tagged and subnet references before deleting this VLAN',
          );
        if (
          !db
            .prepare(
              'DELETE FROM vlans WHERE site_id=? AND id=? AND row_version=?',
            )
            .run(current.siteId, current.id, input.rowVersion).changes
        )
          staleVersion();
      });
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/sites/:siteId/racks', protectedSite, async (request) => ({
    racks: db
      .prepare(
        `SELECT ${rackColumns} FROM racks WHERE site_id=? ORDER BY order_index,id`,
      )
      .all(params(request).siteId!),
  }));
  app.get(
    '/api/v1/sites/:siteId/racks/:rackId',
    protectedSite,
    async (request) => ({
      rack: findRack(params(request).siteId!, params(request).rackId!),
    }),
  );
  app.post(
    '/api/v1/sites/:siteId/racks',
    protectedSite,
    async (request, reply) => {
      const input = validate(createRackSchema, request.body);
      const rack = write(() => {
        const siteId = params(request).siteId!;
        const last = db
          .prepare(
            'SELECT COALESCE(MAX(order_index),-1) AS last FROM racks WHERE site_id=?',
          )
          .get(siteId) as { last: number };
        const candidate = validate(rackRecordSchema, {
          ...input,
          id: randomUUID(),
          siteId,
          orderIndex: input.orderIndex ?? last.last + 1,
          rowVersion: 1,
        });
        db.prepare(
          'INSERT INTO racks (id,site_id,name,description,order_index,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        ).run(
          candidate.id,
          siteId,
          candidate.name,
          candidate.description,
          candidate.orderIndex,
          Date.now(),
          Date.now(),
        );
        return findRack(siteId, candidate.id);
      });
      return reply.code(201).send({ rack });
    },
  );
  app.patch(
    '/api/v1/sites/:siteId/racks/:rackId',
    protectedSite,
    async (request) => {
      const input = validate(updateRackSchema, request.body);
      return {
        rack: write(() => {
          const current = findRack(
            params(request).siteId!,
            params(request).rackId!,
          );
          checkVersion(current, input.rowVersion);
          const candidate = validate(rackRecordSchema, {
            ...current,
            ...input,
          });
          if (
            !db
              .prepare(
                'UPDATE racks SET name=?,description=?,order_index=?,updated_at=?,row_version=row_version+1 WHERE site_id=? AND id=? AND row_version=?',
              )
              .run(
                candidate.name,
                candidate.description,
                candidate.orderIndex,
                Date.now(),
                current.siteId,
                current.id,
                input.rowVersion,
              ).changes
          )
            staleVersion();
          return findRack(current.siteId, current.id);
        }),
      };
    },
  );
  app.delete(
    '/api/v1/sites/:siteId/racks/:rackId',
    protectedSite,
    async (request, reply) => {
      const input = validate(versionSchema, request.body);
      write(() => {
        const current = findRack(
          params(request).siteId!,
          params(request).rackId!,
        );
        checkVersion(current, input.rowVersion);
        if (
          db
            .prepare(
              'SELECT id FROM devices WHERE site_id=? AND rack_id=? LIMIT 1',
            )
            .get(current.siteId, current.id)
        )
          referenced('Remove equipment from this rack before deleting it');
        if (
          !db
            .prepare(
              'DELETE FROM racks WHERE site_id=? AND id=? AND row_version=?',
            )
            .run(current.siteId, current.id, input.rowVersion).changes
        )
          staleVersion();
      });
      return reply.code(204).send();
    },
  );

  app.get('/api/v1/sites/:siteId/subnets', protectedSite, async (request) => ({
    subnets: (
      db
        .prepare(
          `SELECT ${subnetColumns} FROM subnets WHERE site_id=? ORDER BY cidr,id`,
        )
        .all(params(request).siteId!) as SubnetRow[]
    ).map(fromSubnet),
  }));
  app.get(
    '/api/v1/sites/:siteId/subnets/:subnetId',
    protectedSite,
    async (request) => ({
      subnet: findSubnet(params(request).siteId!, params(request).subnetId!),
    }),
  );
  app.post(
    '/api/v1/sites/:siteId/subnets',
    protectedSite,
    async (request, reply) => {
      const input = validate(createSubnetSchema, request.body);
      const subnet = write(() => {
        const siteId = params(request).siteId!;
        const id = randomUUID();
        if (input.vlanRef) findVlan(siteId, input.vlanRef);
        db.prepare(
          'INSERT INTO subnets (id,site_id,vlan_ref,cidr,name,gateway_ip,dns_servers_json,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          siteId,
          input.vlanRef,
          input.cidr,
          input.name,
          input.gatewayIp,
          JSON.stringify(input.dnsServers),
          input.notes,
          Date.now(),
          Date.now(),
        );
        return findSubnet(siteId, id);
      });
      return reply.code(201).send({ subnet });
    },
  );
  app.patch(
    '/api/v1/sites/:siteId/subnets/:subnetId',
    protectedSite,
    async (request) => {
      const input = validate(updateSubnetSchema, request.body);
      return {
        subnet: write(() => {
          const current = findSubnet(
            params(request).siteId!,
            params(request).subnetId!,
          );
          checkVersion(current, input.rowVersion);
          const candidate = validate(subnetRecordSchema, {
            ...current,
            ...input,
          });
          if (candidate.vlanRef) findVlan(current.siteId, candidate.vlanRef);
          const scopes = db
            .prepare(
              `SELECT ${scopeColumns} FROM dhcp_scopes WHERE site_id=? AND subnet_id=?`,
            )
            .all(current.siteId, current.id) as ScopeRow[];
          for (const scope of scopes) checkRange(candidate, scope);
          if (
            !db
              .prepare(
                'UPDATE subnets SET vlan_ref=?,cidr=?,name=?,gateway_ip=?,dns_servers_json=?,notes=?,updated_at=?,row_version=row_version+1 WHERE site_id=? AND id=? AND row_version=?',
              )
              .run(
                candidate.vlanRef,
                candidate.cidr,
                candidate.name,
                candidate.gatewayIp,
                JSON.stringify(candidate.dnsServers),
                candidate.notes,
                Date.now(),
                current.siteId,
                current.id,
                input.rowVersion,
              ).changes
          )
            staleVersion();
          return findSubnet(current.siteId, current.id);
        }),
      };
    },
  );
  app.delete(
    '/api/v1/sites/:siteId/subnets/:subnetId',
    protectedSite,
    async (request, reply) => {
      const input = validate(versionSchema, request.body);
      write(() => {
        const current = findSubnet(
          params(request).siteId!,
          params(request).subnetId!,
        );
        checkVersion(current, input.rowVersion);
        if (
          db
            .prepare(
              'SELECT id FROM dhcp_scopes WHERE site_id=? AND subnet_id=? LIMIT 1',
            )
            .get(current.siteId, current.id)
        )
          referenced('Remove DHCP scopes before deleting this subnet');
        if (
          !db
            .prepare(
              'DELETE FROM subnets WHERE site_id=? AND id=? AND row_version=?',
            )
            .run(current.siteId, current.id, input.rowVersion).changes
        )
          staleVersion();
      });
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/v1/sites/:siteId/subnets/:subnetId/dhcp-scopes',
    protectedSite,
    async (request) => {
      const subnet = findSubnet(
        params(request).siteId!,
        params(request).subnetId!,
      );
      return {
        dhcpScopes: (
          db
            .prepare(
              `SELECT ${scopeColumns} FROM dhcp_scopes WHERE site_id=? AND subnet_id=? ORDER BY start_ip,id`,
            )
            .all(subnet.siteId, subnet.id) as ScopeRow[]
        ).map(fromScope),
      };
    },
  );
  app.get(
    '/api/v1/sites/:siteId/subnets/:subnetId/dhcp-scopes/:scopeId',
    protectedSite,
    async (request) => {
      const subnet = findSubnet(
        params(request).siteId!,
        params(request).subnetId!,
      );
      return {
        dhcpScope: findScope(
          subnet.siteId,
          subnet.id,
          params(request).scopeId!,
        ),
      };
    },
  );
  app.post(
    '/api/v1/sites/:siteId/subnets/:subnetId/dhcp-scopes',
    protectedSite,
    async (request, reply) => {
      const input = validate(createDhcpScopeSchema, request.body);
      const dhcpScope = write(() => {
        const subnet = findSubnet(
          params(request).siteId!,
          params(request).subnetId!,
        );
        checkRange(subnet, input);
        const id = randomUUID();
        db.prepare(
          'INSERT INTO dhcp_scopes (id,site_id,subnet_id,name,start_ip,end_ip,enabled,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        ).run(
          id,
          subnet.siteId,
          subnet.id,
          input.name,
          input.startIp,
          input.endIp,
          Number(input.enabled),
          input.notes,
          Date.now(),
          Date.now(),
        );
        return findScope(subnet.siteId, subnet.id, id);
      });
      return reply.code(201).send({ dhcpScope });
    },
  );
  app.patch(
    '/api/v1/sites/:siteId/subnets/:subnetId/dhcp-scopes/:scopeId',
    protectedSite,
    async (request) => {
      const input = validate(updateDhcpScopeSchema, request.body);
      return {
        dhcpScope: write(() => {
          const subnet = findSubnet(
            params(request).siteId!,
            params(request).subnetId!,
          );
          const current = findScope(
            subnet.siteId,
            subnet.id,
            params(request).scopeId!,
          );
          checkVersion(current, input.rowVersion);
          const candidate = validate(dhcpScopeRecordSchema, {
            ...current,
            ...input,
          });
          checkRange(subnet, candidate);
          if (
            !db
              .prepare(
                'UPDATE dhcp_scopes SET name=?,start_ip=?,end_ip=?,enabled=?,notes=?,updated_at=?,row_version=row_version+1 WHERE site_id=? AND subnet_id=? AND id=? AND row_version=?',
              )
              .run(
                candidate.name,
                candidate.startIp,
                candidate.endIp,
                Number(candidate.enabled),
                candidate.notes,
                Date.now(),
                subnet.siteId,
                subnet.id,
                current.id,
                input.rowVersion,
              ).changes
          )
            staleVersion();
          return findScope(subnet.siteId, subnet.id, current.id);
        }),
      };
    },
  );
  app.delete(
    '/api/v1/sites/:siteId/subnets/:subnetId/dhcp-scopes/:scopeId',
    protectedSite,
    async (request, reply) => {
      const input = validate(versionSchema, request.body);
      write(() => {
        const subnet = findSubnet(
          params(request).siteId!,
          params(request).subnetId!,
        );
        const current = findScope(
          subnet.siteId,
          subnet.id,
          params(request).scopeId!,
        );
        checkVersion(current, input.rowVersion);
        if (
          !db
            .prepare(
              'DELETE FROM dhcp_scopes WHERE site_id=? AND subnet_id=? AND id=? AND row_version=?',
            )
            .run(subnet.siteId, subnet.id, current.id, input.rowVersion).changes
        )
          staleVersion();
      });
      return reply.code(204).send();
    },
  );
}
