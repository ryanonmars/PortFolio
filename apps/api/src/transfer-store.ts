import { randomUUID } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Site, SiteArchive } from '../../../packages/shared/src/index.js';
import { siteArchiveSchema } from '../../../packages/shared/src/index.js';
import { ApiError, validate } from './errors.js';
import { equipmentStore } from './equipment.js';
import { clearSiteContents, readSnapshot } from './resources.js';

export function readTransferSite(db: DatabaseSync, siteId: string): Site {
  const site = db
    .prepare(
      'SELECT id,workspace_id AS workspaceId,name,description,notes,row_version AS rowVersion FROM sites WHERE id=?',
    )
    .get(siteId) as Site | undefined;
  if (!site) throw new ApiError(404, 'NOT_FOUND', 'Site not found');
  return site;
}

/** Keep the full graph consistent even when another SQLite connection writes concurrently. */
export function readTransferSnapshot<T>(db: DatabaseSync, action: () => T): T {
  return readSnapshot(db, action);
}

/** Read in stable order; archives contain documentation only, never accounts or sessions. */
export function exportSite(db: DatabaseSync, siteId: string): SiteArchive {
  return readTransferSnapshot(db, () => readArchive(db, siteId));
}

function readArchive(db: DatabaseSync, siteId: string): SiteArchive {
  const site = readTransferSite(db, siteId);
  const workspace = db
    .prepare('SELECT id,name,description FROM workspaces WHERE id=?')
    .get(site.workspaceId);
  const rows = (sql: string) => db.prepare(sql).all(siteId);
  const store = equipmentStore(db);
  const devices = rows(
    'SELECT id FROM devices WHERE site_id=? ORDER BY order_index,id',
  ).map((row) => store.readDevice(siteId, String(row.id)));
  const ports = rows(
    'SELECT id FROM ports WHERE site_id=? ORDER BY device_id,order_index,id',
  ).map((row) => store.readPort(siteId, String(row.id)));
  const subnets = rows(
    'SELECT id,site_id AS siteId,cidr,name,vlan_ref AS vlanRef,gateway_ip AS gatewayIp,dns_servers_json AS dnsJson,notes,row_version AS rowVersion FROM subnets WHERE site_id=? ORDER BY cidr,id',
  ).map(({ dnsJson, ...row }) => ({
    ...row,
    dnsServers: JSON.parse(String(dnsJson)),
  }));
  const fields = rows(
    'SELECT id,site_id AS siteId,key,title,value_type AS valueType,choices_json AS choicesJson,default_value_json AS defaultJson,visible_by_default AS visible,column_order AS columnOrder,row_version AS rowVersion FROM port_custom_field_defs WHERE site_id=? ORDER BY column_order,id',
  ).map(({ choicesJson, defaultJson, visible, ...row }) => ({
    ...row,
    choices: JSON.parse(String(choicesJson)),
    defaultValue: JSON.parse(String(defaultJson)),
    visibleByDefault: Boolean(visible),
  }));
  return validate(siteArchiveSchema, {
    schemaVersion: 1,
    application: 'PortFolio',
    workspace,
    site,
    racks: rows(
      'SELECT id,site_id AS siteId,name,description,order_index AS orderIndex,row_version AS rowVersion FROM racks WHERE site_id=? ORDER BY order_index,id',
    ),
    vlans: rows(
      'SELECT id,site_id AS siteId,vlan_id AS vlanId,name,color_hex AS color,description,row_version AS rowVersion FROM vlans WHERE site_id=? ORDER BY vlan_id,id',
    ),
    subnets,
    dhcpScopes: rows(
      'SELECT id,site_id AS siteId,subnet_id AS subnetId,name,start_ip AS startIp,end_ip AS endIp,enabled,notes,row_version AS rowVersion FROM dhcp_scopes WHERE site_id=? ORDER BY subnet_id,id',
    ).map(({ enabled, ...row }) => ({ ...row, enabled: Boolean(enabled) })),
    devices,
    ports,
    fields,
    connections: rows(
      'SELECT id,site_id AS siteId,endpoint_a_port_id AS endpointAPortId,endpoint_b_port_id AS endpointBPortId,cable_type AS cableType,notes,row_version AS rowVersion FROM connections WHERE site_id=? ORDER BY id',
    ),
    logicalConnections: rows(
      'SELECT id,site_id AS siteId,endpoint_a_device_id AS endpointADeviceId,endpoint_b_device_id AS endpointBDeviceId,name,protocol,notes,row_version AS rowVersion FROM logical_connections WHERE site_id=? ORDER BY id',
    ),
    customValues: rows(
      'SELECT port_id AS portId,field_def_id AS fieldId,value_json AS valueJson FROM port_custom_values WHERE site_id=? ORDER BY port_id,field_def_id',
    ).map(({ valueJson, ...row }) => ({
      ...row,
      value: JSON.parse(String(valueJson)),
    })),
  });
}

/** Called only inside the caller's transaction after graph validation and backup. */
export function applyArchive(
  db: DatabaseSync,
  source: SiteArchive,
  target: Site,
  policy: 'new-site' | 'replace',
  siteName: string,
): Site {
  const now = Date.now();
  const siteId = policy === 'new-site' ? randomUUID() : target.id;
  const insert = (table: string, record: Record<string, SQLInputValue>) => {
    const columns = Object.keys(record);
    db.prepare(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
    ).run(...Object.values(record));
  };
  if (policy === 'replace') {
    // Restrictive foreign keys require explicit child-first removal; any failure rolls back all rows.
    clearSiteContents(db, siteId);
    db.prepare(
      'UPDATE sites SET description=?,notes=?,row_version=row_version+1,updated_at=? WHERE id=?',
    ).run(source.site.description, source.site.notes, now, siteId);
  } else
    insert('sites', {
      id: siteId,
      workspace_id: target.workspaceId,
      name: siteName,
      description: source.site.description,
      notes: source.site.notes,
      created_at: now,
      updated_at: now,
    });
  const allIds = [
    ...source.racks,
    ...source.vlans,
    ...source.subnets,
    ...source.dhcpScopes,
    ...source.devices,
    ...source.ports,
    ...source.fields,
    ...source.connections,
    ...source.logicalConnections,
  ];
  // IDs break ties in persisted presentation order. Keep that relative order while
  // generating fresh identities, without changing user-entered order indices.
  const sourceIds = allIds.map((record) => record.id).sort();
  const freshIds = allIds.map(() => randomUUID()).sort();
  const ids = new Map(sourceIds.map((id, index) => [id, freshIds[index]!]));
  const ref = (id: string) => {
    const result = ids.get(id);
    if (!result)
      throw new ApiError(
        400,
        'INVALID_REFERENCE',
        'Archive contains an unresolved reference',
      );
    return result;
  };
  const optionalRef = (id: string | null) => (id === null ? null : ref(id));
  const base = (id: string) => ({
    id: ref(id),
    site_id: siteId,
    created_at: now,
    updated_at: now,
  });
  for (const row of source.racks)
    insert('racks', {
      ...base(row.id),
      name: row.name,
      description: row.description,
      order_index: row.orderIndex,
    });
  for (const row of source.vlans)
    insert('vlans', {
      ...base(row.id),
      vlan_id: row.vlanId,
      name: row.name,
      color_hex: row.color,
      description: row.description,
    });
  for (const row of source.subnets)
    insert('subnets', {
      ...base(row.id),
      cidr: row.cidr,
      name: row.name,
      vlan_ref: optionalRef(row.vlanRef),
      gateway_ip: row.gatewayIp,
      dns_servers_json: JSON.stringify(row.dnsServers),
      notes: row.notes,
    });
  for (const row of source.dhcpScopes)
    insert('dhcp_scopes', {
      ...base(row.id),
      subnet_id: ref(row.subnetId),
      name: row.name,
      start_ip: row.startIp,
      end_ip: row.endIp,
      enabled: Number(row.enabled),
      notes: row.notes,
    });
  for (const row of source.devices)
    insert('devices', {
      ...base(row.id),
      rack_id: optionalRef(row.rackId),
      type: row.type,
      display_name: row.displayName,
      hostname: row.hostname,
      manufacturer: row.manufacturer,
      model: row.model,
      serial: row.serial,
      management_ip: row.managementIp,
      mac: row.mac,
      description: row.description,
      metadata_tags_json: JSON.stringify(row.tags),
      order_index: row.orderIndex,
    });
  for (const row of source.ports) {
    insert('ports', {
      ...base(row.id),
      device_id: ref(row.deviceId),
      name: row.name,
      order_index: row.orderIndex,
      kind: row.kind,
      speed: row.speed,
      mode: row.mode,
      documented_link_state: row.documentedLinkState,
      native_vlan_ref: optionalRef(row.nativeVlanRef),
      pvid: row.pvid,
      description: row.description,
      external_destination_label: row.externalDestinationLabel,
      face: row.face,
    });
    for (const vlanRef of row.taggedVlanRefs)
      insert('port_tagged_vlans', {
        port_id: ref(row.id),
        site_id: siteId,
        vlan_ref: ref(vlanRef),
      });
  }
  for (const row of source.fields)
    insert('port_custom_field_defs', {
      ...base(row.id),
      key: row.key,
      title: row.title,
      value_type: row.valueType,
      choices_json: JSON.stringify(row.choices),
      default_value_json: JSON.stringify(row.defaultValue),
      visible_by_default: Number(row.visibleByDefault),
      column_order: row.columnOrder,
    });
  for (const row of source.customValues)
    insert('port_custom_values', {
      port_id: ref(row.portId),
      field_def_id: ref(row.fieldId),
      site_id: siteId,
      value_json: JSON.stringify(row.value),
    });
  for (const row of source.connections)
    insert('connections', {
      ...base(row.id),
      endpoint_a_port_id: ref(row.endpointAPortId),
      endpoint_b_port_id: ref(row.endpointBPortId),
      cable_type: row.cableType,
      notes: row.notes,
    });
  for (const row of source.logicalConnections)
    insert('logical_connections', {
      ...base(row.id),
      endpoint_a_device_id: ref(row.endpointADeviceId),
      endpoint_b_device_id: ref(row.endpointBDeviceId),
      name: row.name,
      protocol: row.protocol,
      notes: row.notes,
    });
  return readTransferSite(db, siteId);
}
