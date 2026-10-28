import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  boardDocumentSchema,
  emptyBoardDocument,
  type BoardDocument,
  type BoardElement,
  type BoardPort,
  type JsonValue,
} from '../../shared/src/board.js';

type Row = Record<string, string | number | null>;
const siteTables = [
  'racks',
  'vlans',
  'subnets',
  'dhcp_scopes',
  'devices',
  'ports',
  'port_tagged_vlans',
  'port_custom_field_defs',
  'port_custom_values',
  'connections',
  'logical_connections',
] as const;
const value = (row: Row, key: string) => String(row[key] ?? '');
const numeric = (row: Row, key: string) => Number(row[key] ?? 0);
const validColor = (input: unknown) =>
  typeof input === 'string' && /^#[0-9a-fA-F]{6}$/.test(input) ? input : '';
function preserve(input: unknown): JsonValue {
  if (typeof input === 'string') {
    if (input.length <= 50000) return input;
    const chunks: Record<string, JsonValue> = {};
    for (let offset = 0; offset < input.length; offset += 50000)
      chunks[String(offset / 50000)] = input.slice(offset, offset + 50000);
    return { encoding: 'portfolio-text-chunks-v1', chunks };
  }
  if (input === null || typeof input === 'boolean' || typeof input === 'number')
    return input;
  if (Array.isArray(input))
    return Object.fromEntries(
      input.map((item, index) => [String(index), preserve(item)]),
    );
  if (input && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [key, preserve(item)]),
    );
  return String(input);
}
function parsed(input: string, fallback: JsonValue): JsonValue {
  try {
    return JSON.parse(input) as JsonValue;
  } catch {
    return fallback;
  }
}

/** Convert trusted relational rows into one canonical document; retain the entire source graph. */
export function legacyBoardDocument(
  db: DatabaseSync,
  siteId: string,
): BoardDocument {
  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId) as Row;
  const workspace = db
    .prepare('SELECT * FROM workspaces WHERE id=?')
    .get(value(site, 'workspace_id')) as Row;
  const tables = Object.fromEntries(
    siteTables.map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table} WHERE site_id=? ORDER BY rowid`)
        .all(siteId) as Row[],
    ]),
  ) as Record<(typeof siteTables)[number], Row[]>;
  const templates = db
    .prepare('SELECT * FROM device_templates ORDER BY id')
    .all();
  const document = emptyBoardDocument();
  const warnings: string[] = [];
  if (tables.logical_connections.length)
    warnings.push(
      'Device-to-device logical links are preserved in the relational snapshot.',
    );
  document.legacy = {
    format: 'portfolio-relational-snapshot-v1',
    description:
      'Source rows remain unchanged in SQLite. Numeric-keyed row maps preserve all fields; portfolio-text-chunks-v1 strings concatenate chunks by numeric key.',
    workspace: preserve(workspace),
    site: preserve(site),
    tables: preserve(tables),
    deviceTemplates: preserve(templates),
  };
  const vlans = new Map(tables.vlans.map((row) => [value(row, 'id'), row]));
  const fields = new Map(
    tables.port_custom_field_defs.map((row) => [value(row, 'id'), row]),
  );
  const nativeId = (reference: string) =>
    vlans.has(reference) ? value(vlans.get(reference)!, 'vlan_id') : reference;
  const devices = [...tables.devices].sort(
    (a, b) =>
      numeric(a, 'order_index') - numeric(b, 'order_index') ||
      value(a, 'id').localeCompare(value(b, 'id')),
  );
  const globalIds = new Set<string>();
  const portsByDevice = new Map<string, Row[]>();
  for (const row of tables.ports) {
    const id = value(row, 'device_id');
    const rows = portsByDevice.get(id) ?? [];
    rows.push(row);
    portsByDevice.set(id, rows);
  }
  for (const [index, row] of devices.entries()) {
    if (document.elements.length >= 255) {
      warnings.push(
        'Additional equipment is preserved in the source snapshot because the canvas element limit was reached.',
      );
      break;
    }
    const id = value(row, 'id');
    if (!id || id.length > 100 || globalIds.has(id)) {
      warnings.push(
        'Equipment with an incompatible or duplicate ID remains in the source snapshot.',
      );
      continue;
    }
    const rows = (portsByDevice.get(id) ?? []).sort(
      (a, b) =>
        numeric(a, 'order_index') - numeric(b, 'order_index') ||
        value(a, 'id').localeCompare(value(b, 'id')),
    );
    const faceCounts = { front: 0, rear: 0 };
    for (const port of rows)
      faceCounts[port.face === 'rear' ? 'rear' : 'front'] += 1;
    const columns = 12;
    const height = Math.max(
      204,
      104 +
        Math.ceil(Math.max(faceCounts.front, faceCounts.rear) / columns) * 100,
    );
    const element: BoardElement = {
      id,
      type: 'device',
      name: value(row, 'display_name'),
      x: (index % 2) * 1050,
      y: Math.floor(index / 2) * 700,
      width: 980,
      height,
      z: index,
      color: '',
      properties: {
        deviceType: value(row, 'type'),
        manufacturer: value(row, 'manufacturer'),
        model: value(row, 'model'),
        managementAddress: value(row, 'management_ip'),
        hostname: value(row, 'hostname'),
        serial: value(row, 'serial'),
        mac: value(row, 'mac'),
        description: value(row, 'description'),
        notes: value(row, 'description'),
        tags: parsed(value(row, 'metadata_tags_json'), []),
        rackId: row.rack_id ?? null,
        frontColumns: columns,
        rearColumns: columns,
        frontRows: Math.max(1, Math.ceil(faceCounts.front / columns)),
        rearRows: Math.max(1, Math.ceil(faceCounts.rear / columns)),
        portSpacing: 8,
        face: 'front',
      },
    };
    document.elements.push(element);
    globalIds.add(id);
    const slots = { front: 0, rear: 0 };
    let deviceCount = 0;
    for (const port of rows) {
      if (document.ports.length >= 4096 || deviceCount >= 512) {
        warnings.push(
          'Additional ports are preserved in the source snapshot because canvas capacity was reached.',
        );
        break;
      }
      const portId = value(port, 'id');
      if (!portId || portId.length > 100 || globalIds.has(portId)) {
        warnings.push(
          'A port with an incompatible or duplicate ID remains in the source snapshot.',
        );
        continue;
      }
      const face = port.face === 'rear' ? 'rear' : 'front';
      const slot = slots[face]++;
      const customFields: Record<string, JsonValue> = {};
      for (const definition of fields.values())
        customFields[value(definition, 'key')] = parsed(
          value(definition, 'default_value_json'),
          null,
        );
      for (const custom of tables.port_custom_values.filter(
        (item) => item.port_id === portId,
      )) {
        const definition = fields.get(value(custom, 'field_def_id'));
        customFields[
          definition ? value(definition, 'key') : value(custom, 'field_def_id')
        ] = parsed(value(custom, 'value_json'), null);
      }
      const kind = ['rj45', 'sfp', 'sfp_plus', 'qsfp', 'other'].includes(
        value(port, 'kind'),
      )
        ? (value(port, 'kind') as BoardPort['kind'])
        : 'other';
      document.ports.push({
        id: portId,
        deviceId: id,
        face,
        row: Math.floor(slot / columns),
        column: slot % columns,
        name: value(port, 'name'),
        kind,
        color: validColor(vlans.get(value(port, 'native_vlan_ref'))?.color_hex),
        role: value(port, 'mode'),
        speed: value(port, 'speed'),
        linkState: value(port, 'documented_link_state'),
        nativeVlan: nativeId(value(port, 'native_vlan_ref')),
        taggedVlans: tables.port_tagged_vlans
          .filter((tag) => tag.port_id === portId)
          .map((tag) => nativeId(value(tag, 'vlan_ref'))),
        pvid: value(port, 'pvid'),
        address: '',
        externalDestination: value(port, 'external_destination_label'),
        notes: value(port, 'description'),
        customFields,
      });
      globalIds.add(portId);
      deviceCount += 1;
    }
  }
  const knownPorts = new Set(document.ports.map((port) => port.id));
  const occupied = new Set<string>();
  for (const row of tables.connections) {
    const id = value(row, 'id');
    const sourcePortId = value(row, 'endpoint_a_port_id');
    const targetPortId = value(row, 'endpoint_b_port_id');
    if (
      !knownPorts.has(sourcePortId) ||
      !knownPorts.has(targetPortId) ||
      sourcePortId === targetPortId ||
      occupied.has(sourcePortId) ||
      occupied.has(targetPortId) ||
      !id ||
      id.length > 100 ||
      globalIds.has(id) ||
      document.cables.length >= 2048
    ) {
      warnings.push(
        'An unsupported cable remains preserved in the source snapshot.',
      );
      continue;
    }
    document.cables.push({
      id,
      sourcePortId,
      targetPortId,
      name: '',
      cableType: value(row, 'cable_type'),
      sourceConnector: '',
      targetConnector: '',
      color: '',
      length: '',
      notes: value(row, 'notes'),
    });
    occupied.add(sourcePortId);
    occupied.add(targetPortId);
    globalIds.add(id);
  }
  if (
    tables.vlans.length ||
    tables.subnets.length ||
    tables.dhcp_scopes.length ||
    value(site, 'notes') ||
    value(site, 'description')
  ) {
    const emptyEntry = () => ({
      name: '',
      vlanId: '',
      vlanName: '',
      color: '',
      subnet: '',
      gateway: '',
      pvid: '',
      addresses: '',
      dhcpStatus: '',
      dhcpStart: '',
      dhcpEnd: '',
      dns: '',
      notes: '',
    });
    const subnetEntry = (row: Row) => {
      const vlan = vlans.get(value(row, 'vlan_ref'));
      const dns = parsed(value(row, 'dns_servers_json'), []);
      return {
        ...emptyEntry(),
        name: value(row, 'name') || value(row, 'cidr'),
        vlanId: vlan ? value(vlan, 'vlan_id') : '',
        vlanName: vlan ? value(vlan, 'name') : '',
        color: validColor(vlan?.color_hex),
        subnet: value(row, 'cidr'),
        gateway: value(row, 'gateway_ip'),
        dns: Array.isArray(dns)
          ? dns.map(String).join(', ')
          : value(row, 'dns_servers_json'),
        notes: value(row, 'notes'),
      };
    };
    const subnets = new Map(
      tables.subnets.map((row) => [value(row, 'id'), row]),
    );
    const entries = [
      ...tables.vlans.map((row) => ({
        ...emptyEntry(),
        name: value(row, 'name'),
        vlanId: value(row, 'vlan_id'),
        vlanName: value(row, 'name'),
        color: validColor(row.color_hex),
        notes: value(row, 'description'),
      })),
      ...tables.subnets.map(subnetEntry),
      ...tables.dhcp_scopes.map((row) => {
        const subnet = subnets.get(value(row, 'subnet_id'));
        const inherited = subnet ? subnetEntry(subnet) : emptyEntry();
        return {
          ...inherited,
          name: value(row, 'name') || `${inherited.subnet || 'Network'} DHCP`,
          dhcpStatus: numeric(row, 'enabled') ? 'Enabled' : 'Disabled',
          dhcpStart: value(row, 'start_ip'),
          dhcpEnd: value(row, 'end_ip'),
          notes: [inherited.notes, value(row, 'notes')]
            .filter(Boolean)
            .join('\n\n'),
        };
      }),
    ];
    if (entries.length > 4096)
      warnings.push(
        'Additional network entries are preserved in the source snapshot because canvas entry capacity was reached.',
      );
    document.elements.push({
      id: randomUUID(),
      type: 'network',
      name: value(site, 'name') + ' network',
      x: 0,
      y: Math.min(100000, Math.ceil(devices.length / 2) * 700),
      width: 620,
      height: 400,
      z: document.elements.length,
      color: '',
      properties: {
        notes: [value(site, 'description'), value(site, 'notes')]
          .filter(Boolean)
          .join('\n\n'),
        description: value(site, 'description'),
        entries: entries.slice(0, 4096),
        subnets: preserve(tables.subnets),
        dhcpScopes: preserve(tables.dhcp_scopes),
      },
    });
  }
  document.legacy.migrationWarnings = [...new Set(warnings)];
  const validated = boardDocumentSchema.safeParse(document);
  if (validated.success) return validated.data;
  // A valid, recoverable board is safer than failing startup or dropping unusual source records.
  const fallback = emptyBoardDocument();
  fallback.legacy = {
    ...document.legacy,
    migrationWarnings: [
      'Some source data requires manual layout conversion. The complete relational snapshot is preserved in this board export.',
    ],
  };
  return boardDocumentSchema.parse(fallback);
}

/** Called after SQL migrations; never writes to or removes the legacy tables. */
export function migrateLegacyBoards(db: DatabaseSync): void {
  if (
    !db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='boards'",
      )
      .get()
  )
    return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const workspaces = db
      .prepare('SELECT * FROM workspaces ORDER BY created_at,id')
      .all() as Row[];
    for (const [order, workspace] of workspaces.entries()) {
      const id = value(workspace, 'id');
      if (
        db
          .prepare(
            'SELECT legacy_workspace_id FROM board_legacy_groups WHERE legacy_workspace_id=?',
          )
          .get(id)
      )
        continue;
      const groupId =
        id.length > 100 ||
        db.prepare('SELECT id FROM board_groups WHERE id=?').get(id)
          ? randomUUID()
          : id;
      db.prepare(
        'INSERT INTO board_groups (id,name,order_index,created_at,updated_at) VALUES (?,?,?,?,?)',
      ).run(groupId, value(workspace, 'name'), order, Date.now(), Date.now());
      db.prepare(
        'INSERT INTO board_legacy_groups (legacy_workspace_id,group_id,converted_at) VALUES (?,?,?)',
      ).run(id, groupId, Date.now());
    }
    const sites = db
      .prepare('SELECT * FROM sites ORDER BY created_at,id')
      .all() as Row[];
    for (const [order, site] of sites.entries()) {
      const id = value(site, 'id');
      if (
        db
          .prepare(
            'SELECT legacy_site_id FROM board_legacy_sites WHERE legacy_site_id=?',
          )
          .get(id)
      )
        continue;
      const group = db
        .prepare(
          'SELECT group_id FROM board_legacy_groups WHERE legacy_workspace_id=?',
        )
        .get(value(site, 'workspace_id')) as { group_id: string | null };
      const boardId =
        id.length > 100 ||
        db.prepare('SELECT id FROM boards WHERE id=?').get(id)
          ? randomUUID()
          : id;
      const document = legacyBoardDocument(db, id);
      db.prepare(
        'INSERT INTO boards (id,group_id,name,order_index,document_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(
        boardId,
        group.group_id,
        value(site, 'name'),
        order,
        JSON.stringify(document),
        Date.now(),
        Date.now(),
      );
      db.prepare(
        'INSERT INTO board_legacy_sites (legacy_site_id,legacy_workspace_id,board_id,converted_at) VALUES (?,?,?,?)',
      ).run(id, value(site, 'workspace_id'), boardId, Date.now());
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
