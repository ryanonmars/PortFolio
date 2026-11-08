import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  normalizeNetworkEntry,
  type BoardDocument,
  type BoardElement,
  type JsonValue,
} from '../../../../packages/shared/src/board.js';
import {
  deviceItems,
  findNetwork,
  networkItems,
  portPeer,
  type BoardPage,
} from './detail-model.js';
import { networkDisplayValue } from './network-presentation.js';
import { ipv4Pool, ipv4Subnet } from './network-ipv4.js';
import {
  DeviceEditor,
  NetworkEditor,
  DocumentationEditor,
  PortEditor,
  type DetailChange,
} from './DetailPageEditors.js';
import './detail-pages.css';
import { AttachmentsSection } from './AttachmentsSection.js';

interface Props {
  boardId?: string;
  attachmentsReady?: boolean;
  beforeAttachmentChange?: () => Promise<void>;
  document: BoardDocument;
  boardName: string;
  page: BoardPage;
  onNavigate: (page: BoardPage) => void;
  onChange?: DetailChange;
}
const value = (item: JsonValue | undefined) => networkDisplayValue(item);
const subnetValue = (entry: Record<string, JsonValue>) =>
  value(Object.hasOwn(entry, 'subnet') ? entry.subnet : entry.cidr);
const label = (key: string) =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (letter) => letter.toUpperCase());
const collator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'base',
});
const count = (n: number) => n.toLocaleString('en-US');
function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}
function dhcp(entry: Record<string, JsonValue>) {
  const normalized = normalizeNetworkEntry(entry);
  return normalized.dhcpServer === true
    ? 'Enabled'
    : normalized.dhcpServer === false
      ? 'Disabled'
      : (entry.dhcpServer === null ? '' : value(entry.dhcpStatus)) ||
        'Not documented';
}
function Fields({ fields }: { fields: [string, ReactNode][] }) {
  return (
    <dl className="detail-fields">
      {fields.map(([name, item], index) => (
        <div key={`${name}-${index}`}>
          <dt>{name}</dt>
          <dd>
            {item || <span className="detail-muted">Not documented</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
function Documentation({
  properties,
  omit = [],
}: {
  properties: Record<string, JsonValue>;
  omit?: string[];
}) {
  const documentation = object(properties.documentation);
  const fields = Object.entries(documentation).filter(([, item]) =>
    value(item),
  );
  const custom = Object.entries(object(properties.customFields)).filter(
    ([, item]) => value(item),
  );
  const extra = Object.entries(properties).filter(
    ([key, item]) =>
      !omit.includes(key) &&
      !['documentation', 'customFields', 'notes'].includes(key) &&
      value(item),
  );
  if (
    !fields.length &&
    !custom.length &&
    !extra.length &&
    !value(properties.notes)
  )
    return null;
  return (
    <section className="detail-section">
      <h2>Documentation</h2>
      {value(properties.notes) && (
        <p className="detail-prose">{value(properties.notes)}</p>
      )}
      <Fields
        fields={[...fields, ...custom, ...extra].map(([key, item]) => [
          label(key),
          value(item),
        ])}
      />
    </section>
  );
}
function Breadcrumb({
  boardName,
  category,
  name,
  onNavigate,
}: {
  boardName: string;
  category: 'Networks' | 'Devices';
  name?: string;
  onNavigate: Props['onNavigate'];
}) {
  return (
    <nav className="detail-breadcrumb" aria-label="Breadcrumb">
      <button onClick={() => onNavigate({ kind: 'canvas' })}>
        {boardName}
      </button>
      <span aria-hidden="true">/</span>
      {name ? (
        <>
          <button
            onClick={() =>
              onNavigate({
                kind: category === 'Networks' ? 'networks' : 'devices',
              })
            }
          >
            {category}
          </button>
          <span aria-hidden="true">/</span>
          <span title={name} aria-current="page">
            {name}
          </span>
        </>
      ) : (
        <span aria-current="page">{category}</span>
      )}
    </nav>
  );
}
interface Column<T> {
  key: string;
  name: string;
  text: (row: T) => string;
  render?: (row: T) => ReactNode;
}
function Inventory<T>({
  rows,
  columns,
  kind,
  rowKey,
  onOpen,
  openLabel,
}: {
  rows: T[];
  columns: Column<T>[];
  kind: 'networks' | 'devices';
  rowKey: (row: T) => string;
  onOpen: (row: T) => void;
  openLabel: (row: T) => string;
}) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: columns[0]!.key, descending: false });
  const [limit, setLimit] = useState(64);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    const column = columns.find((col) => col.key === sort.key) ?? columns[0]!;
    return rows
      .filter(
        (row) =>
          !query ||
          columns.some((col) => col.text(row).toLowerCase().includes(query)),
      )
      .sort(
        (a, b) =>
          (collator.compare(column.text(a), column.text(b)) ||
            collator.compare(rowKey(a), rowKey(b))) *
          (sort.descending ? -1 : 1),
      );
  }, [rows, columns, search, sort, rowKey]);
  return (
    <>
      <div className="detail-table-tools">
        <label className="detail-search">
          <span className="detail-sr-only">Search {kind}</span>
          <input
            type="search"
            aria-label={`Search ${kind}`}
            placeholder={`Search ${kind}…`}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(64);
            }}
          />
        </label>
        <span className="detail-muted">
          {count(filtered.length)} {kind}
        </span>
      </div>
      <div className="detail-table-scroll">
        <table className="detail-table">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={
                    sort.key === column.key
                      ? sort.descending
                        ? 'descending'
                        : 'ascending'
                      : 'none'
                  }
                >
                  <button
                    onClick={() =>
                      setSort({
                        key: column.key,
                        descending: sort.key === column.key && !sort.descending,
                      })
                    }
                  >
                    {column.name}
                    <span aria-hidden="true">
                      {sort.key === column.key
                        ? sort.descending
                          ? ' ↓'
                          : ' ↑'
                        : ''}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, limit).map((row) => (
              <tr key={rowKey(row)} onClick={() => onOpen(row)}>
                {columns.map((column, index) => (
                  <td key={column.key}>
                    {index === 0 ? (
                      <button
                        className="detail-row-link"
                        aria-label={openLabel(row)}
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpen(row);
                        }}
                      >
                        {column.render?.(row) ?? (column.text(row) || '—')}
                      </button>
                    ) : (
                      (column.render?.(row) ??
                      (column.text(row) || (
                        <span className="detail-muted">—</span>
                      )))
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <p className="detail-empty">
            {rows.length
              ? `No ${kind} match your search.`
              : `No ${kind} are documented on this board.`}
          </p>
        )}
      </div>
      {filtered.length > limit && (
        <button
          className="detail-more"
          onClick={() => setLimit((previous) => previous + 64)}
        >
          Show more {kind}
        </button>
      )}
    </>
  );
}
function NetworkOverview({ document, onNavigate }: Props) {
  const rows = networkItems(document);
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: 'vlanId',
      name: 'VLAN',
      text: ({ entry }) => value(entry.vlanId),
      render: ({ entry }) => (
        <span className="detail-vlan-cell">
          <i
            style={{
              background: /^#[\da-f]{6}$/i.test(value(entry.color))
                ? value(entry.color)
                : '#849389',
            }}
          />
          {value(entry.vlanId) || '—'}
        </span>
      ),
    },
    {
      key: 'name',
      name: 'Network name',
      text: ({ entry }) => value(normalizeNetworkEntry(entry).vlanName),
    },
    {
      key: 'subnet',
      name: 'Subnet',
      text: ({ entry }) => subnetValue(entry),
    },
    {
      key: 'gateway',
      name: 'Gateway',
      text: ({ entry }) => value(entry.gateway),
    },
    { key: 'dhcp', name: 'DHCP', text: ({ entry }) => dhcp(entry) },
    {
      key: 'pool',
      name: 'DHCP pool',
      text: ({ entry }) =>
        [value(entry.dhcpStart), value(entry.dhcpEnd)]
          .filter(Boolean)
          .join(' → '),
    },
    { key: 'dns', name: 'DNS servers', text: ({ entry }) => value(entry.dns) },
  ];
  return (
    <Inventory
      rows={rows}
      columns={columns}
      kind="networks"
      rowKey={(row) => JSON.stringify([row.container.id, row.entryId])}
      onOpen={(row) =>
        onNavigate({
          kind: 'network',
          containerId: row.container.id,
          entryId: row.entryId,
        })
      }
      openLabel={(row) => `Open network ${row.label}`}
    />
  );
}
function DeviceOverview({ document, onNavigate }: Props) {
  const rows = deviceItems(document);
  const portCounts = new Map<string, number>();
  const portOwners = new Map<string, string>();
  const connectionCounts = new Map<string, number>();
  for (const port of document.ports) {
    portOwners.set(port.id, port.deviceId);
    portCounts.set(port.deviceId, (portCounts.get(port.deviceId) ?? 0) + 1);
  }
  for (const cable of document.cables) {
    // One cable is one documented connection even when both ends share a device.
    const owners = new Set([
      portOwners.get(cable.sourcePortId),
      portOwners.get(cable.targetPortId),
    ]);
    for (const owner of owners)
      if (owner)
        connectionCounts.set(owner, (connectionCounts.get(owner) ?? 0) + 1);
  }
  const columns: Column<BoardElement>[] = [
    {
      key: 'name',
      name: 'Device name',
      text: (row) => row.name || 'Unnamed device',
    },
    {
      key: 'manufacturer',
      name: 'Manufacturer',
      text: (row) => value(row.properties.manufacturer),
    },
    { key: 'model', name: 'Model', text: (row) => value(row.properties.model) },
    {
      key: 'managementAddress',
      name: 'Management IP',
      text: (row) => value(row.properties.managementAddress),
    },
    {
      key: 'ports',
      name: 'Ports',
      text: (row) => String(portCounts.get(row.id) ?? 0),
    },
    {
      key: 'connections',
      name: 'Documented connections',
      text: (row) => String(connectionCounts.get(row.id) ?? 0),
    },
  ];
  return (
    <Inventory
      rows={rows}
      columns={columns}
      kind="devices"
      rowKey={(row) => row.id}
      onOpen={(row) => onNavigate({ kind: 'device', deviceId: row.id })}
      openLabel={(row) => `Open device ${row.name || 'Unnamed device'}`}
    />
  );
}
function AddressSpace({ entry }: { entry: Record<string, JsonValue> }) {
  const space = ipv4Subnet(subnetValue(entry));
  const enabled = normalizeNetworkEntry(entry).dhcpServer;
  const pool =
    space && enabled === true
      ? ipv4Pool(space, value(entry.dhcpStart), value(entry.dhcpEnd))
      : null;
  const reason = !space
    ? 'A valid IPv4 subnet is needed to show address space.'
    : enabled === false
      ? 'DHCP is disabled. No configured pool is highlighted.'
      : enabled !== true
        ? 'DHCP state is not documented. No pool is highlighted.'
        : !value(entry.dhcpStart) || !value(entry.dhcpEnd)
          ? 'Document both DHCP endpoints to show pool coverage.'
          : !pool
            ? 'The DHCP range is invalid or outside the usable subnet range.'
            : '';
  return (
    <section className="detail-section detail-address-space">
      <div className="detail-section-heading">
        <h2>Address space</h2>
        {space && (
          <span className="detail-muted">
            {count(space.usable)} usable IPv4{' '}
            {space.usable === 1 ? 'address' : 'addresses'}
          </span>
        )}
      </div>
      {space ? (
        <>
          <div className="detail-address-caption">
            <code>{space.canonicalCidr}</code>
            <span>Usable range</span>
          </div>
          <div
            className="detail-address-track"
            role="img"
            aria-label={`Usable range ${space.first} to ${space.last}${pool ? `; configured DHCP pool ${pool.start} to ${pool.end}, ${count(pool.count)} addresses` : '; no valid enabled DHCP pool'}`}
          >
            {pool && (
              <span
                className="detail-address-pool"
                style={{
                  left: `${pool.offsetPercent}%`,
                  width: `${pool.widthPercent}%`,
                }}
              />
            )}
          </div>
          <div className="detail-address-endpoints">
            <code>{space.first}</code>
            <code>{space.last}</code>
          </div>
          {pool && (
            <>
              <div className="detail-pool-legend">
                <i />
                Configured DHCP pool{' '}
                <code>
                  {pool.start} → {pool.end}
                </code>
              </div>
              <Fields
                fields={[
                  ['DHCP pool', `${count(pool.count)} addresses`],
                  [
                    'Pool coverage',
                    `${((pool.count / space.usable) * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}% of usable range`,
                  ],
                  [
                    'Outside DHCP pool',
                    `${count(space.usable - pool.count)} addresses`,
                  ],
                ]}
              />
            </>
          )}
        </>
      ) : null}
      {reason && <p className="detail-muted">{reason}</p>}
      <p className="detail-footnote">
        Configured address coverage only. This does not indicate active use,
        availability, or live allocation.
      </p>
    </section>
  );
}
function NetworkDetail({
  document,
  page,
  onNavigate,
  onChange,
  boardId,
  beforeAttachmentChange,
  attachmentsReady,
}: Props) {
  const [editing, setEditing] = useState(false);
  if (page.kind !== 'network') return null;
  const item = findNetwork(document, page.containerId, page.entryId);
  if (!item) return <Unavailable onNavigate={onNavigate} category="networks" />;
  const entry = item.entry;
  const normalized = normalizeNetworkEntry(entry);
  const color = /^#[\da-f]{6}$/i.test(value(entry.color))
    ? value(entry.color)
    : '#849389';
  return (
    <>
      <header className="detail-object-heading">
        <div className="detail-network-identity">
          <div className="detail-vlan-badge" style={{ borderColor: color }}>
            <span>VLAN</span>
            <strong>{value(entry.vlanId) || '—'}</strong>
          </div>
          <div>
            <span className="detail-eyebrow">Network</span>
            <h1>{value(normalized.vlanName) || item.label}</h1>
            <code>{subnetValue(entry) || 'Subnet not documented'}</code>
          </div>
        </div>
        <div className="detail-heading-actions">
          {onChange && (
            <button
              className="detail-board-action"
              onClick={() => setEditing((previous) => !previous)}
            >
              {editing ? 'Done editing' : 'Edit network'}
            </button>
          )}
          <button
            className="detail-board-action"
            onClick={() =>
              onNavigate({ kind: 'canvas', focusId: item.container.id })
            }
          >
            View on Board
          </button>
        </div>
      </header>
      <div className="detail-content-grid">
        {editing && onChange ? (
          <NetworkEditor document={document} item={item} onChange={onChange} />
        ) : (
          <section className="detail-section">
            <h2>Configuration</h2>
            <Fields
              fields={[
                ['Gateway', value(entry.gateway)],
                ['DHCP', dhcp(entry)],
                ['DHCP start', value(entry.dhcpStart)],
                ['DHCP end', value(entry.dhcpEnd)],
                ['DNS servers', value(entry.dns)],
                [
                  'Network color',
                  <span className="detail-color-value">
                    <i style={{ background: color }} />
                    {value(entry.color) || 'Default'}
                  </span>,
                ],
              ]}
            />
          </section>
        )}
        <AddressSpace entry={entry} />
      </div>
      {onChange && (
        <DocumentationEditor
          document={document}
          page={page}
          properties={entry}
          entity="Network"
          onChange={onChange}
        />
      )}
      {boardId && (
        <AttachmentsSection
          boardId={boardId}
          ready={attachmentsReady}
          owner={{
            type: 'network',
            elementId: page.containerId,
            entryId: page.entryId,
          }}
          beforeAttachmentChange={beforeAttachmentChange}
        />
      )}
      <Documentation
        properties={entry}
        omit={[
          'networkEntryId',
          'networkEntryVersion',
          'vlanId',
          'vlanName',
          'name',
          'subnet',
          'cidr',
          'gateway',
          'dhcpServer',
          'dhcpStatus',
          'dhcpStart',
          'dhcpEnd',
          'dns',
          'color',
        ]}
      />
    </>
  );
}
function DeviceDetail({
  document,
  page,
  onNavigate,
  onChange,
  boardId,
  beforeAttachmentChange,
  attachmentsReady,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [editingPortId, setEditingPortId] = useState<string | null>(null);
  if (page.kind !== 'device') return null;
  const device = deviceItems(document).find(
    (item) => item.id === page.deviceId,
  );
  if (!device)
    return <Unavailable onNavigate={onNavigate} category="devices" />;
  const ports = document.ports
    .filter((port) => port.deviceId === device.id)
    .sort(
      (a, b) =>
        collator.compare(a.face, b.face) ||
        a.row - b.row ||
        a.column - b.column ||
        collator.compare(a.name, b.name),
    );
  return (
    <>
      <header className="detail-object-heading">
        <div>
          <span className="detail-eyebrow">Device</span>
          <h1>{device.name || 'Unnamed device'}</h1>
          <p className="detail-muted">
            {[
              value(device.properties.manufacturer),
              value(device.properties.model),
            ]
              .filter(Boolean)
              .join(' · ') || 'Device documentation'}
          </p>
        </div>
        <div className="detail-heading-actions">
          {onChange && (
            <button
              className="detail-board-action"
              onClick={() => setEditing((previous) => !previous)}
            >
              {editing ? 'Done editing' : 'Edit device'}
            </button>
          )}
          <button
            className="detail-board-action"
            onClick={() => onNavigate({ kind: 'canvas', focusId: device.id })}
          >
            View on Board
          </button>
        </div>
      </header>
      {editing && onChange ? (
        <DeviceEditor document={document} device={device} onChange={onChange} />
      ) : (
        <section className="detail-section">
          <h2>Overview</h2>
          <Fields
            fields={[
              ['Manufacturer', value(device.properties.manufacturer)],
              ['Model', value(device.properties.model)],
              ['Management IP', value(device.properties.managementAddress)],
              ['Device type', value(device.properties.deviceType)],
              ['Ports', count(ports.length)],
            ]}
          />
        </section>
      )}
      <section className="detail-section">
        <div className="detail-section-heading">
          <h2>Ports</h2>
          <span className="detail-muted">
            Connections as documented on this board
          </span>
        </div>
        <div className="detail-table-scroll">
          <table className="detail-table detail-port-table">
            <thead>
              <tr>
                {[
                  'Port',
                  'Type',
                  'Configuration',
                  'VLAN / PVID',
                  'Connected device',
                  'Connected port',
                ].map((name) => (
                  <th key={name} scope="col">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ports.map((port) => {
                const peer = portPeer(document, port);
                return (
                  <Fragment key={port.id}>
                    <tr>
                      <td>
                        <strong>{port.name || 'Unnamed port'}</strong>
                        <small>{port.face}</small>
                        {onChange && (
                          <button
                            className="detail-port-edit-toggle"
                            aria-label={`${editingPortId === port.id ? 'Done editing port' : 'Edit port'} ${port.name}`}
                            onClick={() =>
                              setEditingPortId((previous) =>
                                previous === port.id ? null : port.id,
                              )
                            }
                          >
                            {editingPortId === port.id ? 'Done' : 'Edit'}
                          </button>
                        )}
                      </td>
                      <td>
                        {
                          {
                            rj45: 'RJ45',
                            sfp: 'SFP',
                            sfp_plus: 'SFP+',
                            qsfp: 'QSFP',
                            other: 'Other',
                          }[port.kind]
                        }
                      </td>
                      <td>
                        {[port.role, port.speed, port.address]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                        {port.linkState && (
                          <small>Documented link: {port.linkState}</small>
                        )}
                        {port.notes && <small>{port.notes}</small>}
                        {Object.entries(port.customFields).map(
                          ([key, item]) => (
                            <small key={key}>
                              {key}: {value(item)}
                            </small>
                          ),
                        )}
                      </td>
                      <td>
                        {[
                          port.nativeVlan && `Native ${port.nativeVlan}`,
                          port.taggedVlans.length > 0 &&
                            `Tagged ${port.taggedVlans.join(', ')}`,
                          port.pvid && `PVID ${port.pvid}`,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </td>
                      <td>
                        {peer ? (
                          <button
                            className="detail-inline-link"
                            onClick={() =>
                              onNavigate({
                                kind: 'device',
                                deviceId: peer.device.id,
                              })
                            }
                          >
                            {peer.device.name || 'Unnamed device'}
                          </button>
                        ) : port.externalDestination ? (
                          <span>External: {port.externalDestination}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{peer?.port.name || '—'}</td>
                    </tr>
                    {editingPortId === port.id && onChange && (
                      <tr>
                        <td colSpan={6}>
                          <PortEditor
                            document={document}
                            port={port}
                            onChange={onChange}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {!ports.length && (
            <p className="detail-empty">
              No ports are documented for this device.
            </p>
          )}
        </div>
      </section>
      {onChange && (
        <DocumentationEditor
          document={document}
          page={page}
          properties={device.properties}
          entity="Device"
          onChange={onChange}
        />
      )}
      {boardId && (
        <AttachmentsSection
          boardId={boardId}
          ready={attachmentsReady}
          owner={{ type: 'device', elementId: device.id }}
          beforeAttachmentChange={beforeAttachmentChange}
        />
      )}
      <Documentation
        properties={device.properties}
        omit={[
          'manufacturer',
          'model',
          'managementAddress',
          'deviceType',
          'portLayout',
          'portCount',
          'displayFields',
          'headerFields',
          'frontRows',
          'rearRows',
          'portsPerRow',
          'showPortNames',
          'portSpacing',
          'face',
          'portSize',
          'frontPortRows',
          'rearPortRows',
        ]}
      />
    </>
  );
}
function Unavailable({
  onNavigate,
  category,
}: {
  onNavigate: Props['onNavigate'];
  category: 'networks' | 'devices';
}) {
  return (
    <section className="detail-unavailable">
      <h1>Object unavailable</h1>
      <p>This object is no longer present on the board.</p>
      <button
        className="detail-board-action"
        onClick={() => onNavigate({ kind: category })}
      >
        Back to {category}
      </button>
    </section>
  );
}
export function BoardDetailPages(props: Props) {
  const { document, boardName, page, onNavigate } = props;
  if (page.kind === 'canvas') return null;
  if (page.kind === 'unavailable')
    return (
      <div className="board-detail-pages">
        <div className="detail-page-inner">
          <nav className="detail-breadcrumb" aria-label="Breadcrumb">
            <button onClick={() => onNavigate({ kind: 'canvas' })}>
              {boardName}
            </button>
          </nav>
          <section className="detail-unavailable">
            <h1>Page unavailable</h1>
            <p>This address does not identify a board documentation page.</p>
            <button
              className="detail-board-action"
              onClick={() => onNavigate({ kind: 'canvas' })}
            >
              Back to Board
            </button>
          </section>
        </div>
      </div>
    );
  const network =
    page.kind === 'network'
      ? findNetwork(document, page.containerId, page.entryId)
      : undefined;
  const device =
    page.kind === 'device'
      ? deviceItems(document).find((item) => item.id === page.deviceId)
      : undefined;
  const category =
    page.kind === 'networks' || page.kind === 'network'
      ? 'Networks'
      : 'Devices';
  const name =
    page.kind === 'network'
      ? network?.label || 'Unavailable network'
      : page.kind === 'device'
        ? device?.name || 'Unavailable device'
        : undefined;
  return (
    <div className="board-detail-pages">
      <div className="detail-page-inner">
        <Breadcrumb
          boardName={boardName}
          category={category}
          name={name}
          onNavigate={onNavigate}
        />
        {page.kind === 'networks' || page.kind === 'devices' ? (
          <>
            <header className="detail-category-heading">
              <span className="detail-eyebrow">{boardName}</span>
              <h1>{category}</h1>
              <p>Documentation from the objects on this board.</p>
            </header>
            {page.kind === 'networks' ? (
              <NetworkOverview {...props} />
            ) : (
              <DeviceOverview {...props} />
            )}
          </>
        ) : page.kind === 'network' ? (
          <NetworkDetail {...props} />
        ) : (
          <DeviceDetail {...props} />
        )}
      </div>
    </div>
  );
}
