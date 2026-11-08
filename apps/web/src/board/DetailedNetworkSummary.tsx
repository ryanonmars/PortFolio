import type { CSSProperties } from 'react';
import {
  normalizeNetworkEntry,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import {
  networkDisplayValue,
  networkPresentation,
} from './network-presentation.js';
import { ipv4Pool, ipv4Subnet, networkLayoutTotals } from './network-ipv4.js';
import './detailed-network-summary.css';

const count = (value: number) => value.toLocaleString('en-US');
function ConfigurationIcon({ kind }: { kind: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden="true"
    >
      {kind === 'dns' ? (
        <>
          <rect x="3" y="2" width="10" height="5" rx="1" />
          <rect x="3" y="9" width="10" height="5" rx="1" />
          <path d="M5 4.5h1m-1 7h1M8 4.5h3m-3 7h3" />
        </>
      ) : kind === 'gateway' ? (
        <>
          <rect x="2" y="7" width="12" height="6" rx="2" />
          <path d="M5 7V3m6 4V3M5 10h1m2 0h1m2 0h1" />
        </>
      ) : (
        <>
          <rect x="6" y="1" width="4" height="4" rx="1" />
          <rect x="1" y="11" width="4" height="4" rx="1" />
          <rect x="11" y="11" width="4" height="4" rx="1" />
          <path d="M8 5v3H3v3m5-3h5v3" />
        </>
      )}
    </svg>
  );
}

/** A canvas-only presentation of the same authored entries and visibility settings. */
export function DetailedNetworkSummary({ element }: { element: BoardElement }) {
  const entries = Array.isArray(element.properties.entries)
    ? element.properties.entries
    : [];
  const rows = entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const presentation = networkPresentation(element, entry);
    return presentation ? [{ entry, presentation }] : [];
  });
  const totals = networkLayoutTotals(
    rows.map(({ presentation }) => ({
      vlanId: presentation.vlanId,
      subnet:
        presentation.chips.find((field) => field.key === 'subnet')?.value ?? '',
    })),
  );
  const hasTotals = totals.vlans > 0 || totals.subnets > 0;
  const density =
    element.width >= 840 ? 'wide' : element.width >= 520 ? 'medium' : 'narrow';
  return (
    <div
      className="board-network-summary board-network-detailed"
      data-density={density}
      tabIndex={0}
      aria-label="Detailed network configurations"
    >
      {element.properties.showNetworkSummary !== false && hasTotals && (
        <div
          className="board-network-visual-totals"
          aria-label="Network totals"
        >
          {totals.vlans > 0 && (
            <span>
              <strong>{count(totals.vlans)}</strong>{' '}
              {totals.vlans === 1 ? 'VLAN' : 'VLANs'}
            </span>
          )}
          {totals.subnets > 0 && (
            <span>
              <strong>{count(totals.subnets)}</strong> IPv4{' '}
              {totals.subnets === 1 ? 'subnet' : 'subnets'}
            </span>
          )}
          {totals.usable !== null && (
            <span>
              <strong>{count(totals.usable)}</strong> unique usable IPv4
              addresses
            </span>
          )}
        </div>
      )}
      {rows.map(({ entry, presentation }, index) => {
        const subnet = presentation.chips.find(
          (field) => field.key === 'subnet',
        );
        const space = subnet ? ipv4Subnet(subnet.value) : null;
        const poolField = presentation.chips.find(
          (field) => field.key === 'dhcpPool',
        );
        const stateShown = presentation.chips.some(
          (field) => field.key === 'dhcpServer',
        );
        const enabled = stateShown
          ? normalizeNetworkEntry(entry).dhcpServer
          : undefined;
        const pool =
          space && poolField && enabled === true
            ? ipv4Pool(
                space,
                networkDisplayValue(entry.dhcpStart),
                networkDisplayValue(entry.dhcpEnd),
              )
            : null;
        const configuration = presentation.chips.filter(
          (field) => field.key !== 'subnet',
        );
        const diagramMessage = !subnet
          ? 'Subnet not shown'
          : !space
            ? 'IPv4 address space unavailable'
            : !stateShown
              ? 'DHCP state not shown'
              : enabled === false
                ? 'DHCP disabled'
                : !poolField
                  ? 'DHCP pool not shown or incomplete'
                  : enabled !== true
                    ? 'DHCP state unspecified'
                    : !pool
                      ? 'DHCP pool outside usable range or invalid'
                      : 'Configured DHCP pool · not live utilization';
        return (
          <section
            key={index}
            className="board-network-visual-row"
            style={
              { '--network-visual-accent': presentation.color } as CSSProperties
            }
          >
            <div className="board-network-visual-identity">
              {presentation.vlanId && (
                <div className="board-network-visual-vlan">
                  <span>VLAN</span>
                  <strong>{presentation.vlanId}</strong>
                </div>
              )}
              <div className="board-network-visual-name">
                {presentation.vlanName && <h3>{presentation.vlanName}</h3>}
                {subnet && (
                  <p className="board-network-visual-cidr">{subnet.value}</p>
                )}
                {space && (
                  <p className="board-network-visual-usable">
                    {count(space.usable)} usable IPv4 addresses
                  </p>
                )}
              </div>
            </div>
            <div className="board-network-visual-configuration">
              {configuration.length > 0 ? (
                <dl>
                  {configuration.map((field) => (
                    <div key={field.key} data-field={field.key}>
                      <dt>
                        {[
                          'gateway',
                          'dns',
                          'dhcpServer',
                          'dhcpStart',
                          'dhcpEnd',
                          'dhcpPool',
                        ].includes(field.key) && (
                          <ConfigurationIcon kind={field.key} />
                        )}
                        <span>
                          {field.label === 'DHCP Pool'
                            ? 'Pool'
                            : field.label === 'DNS Servers'
                              ? 'DNS'
                              : field.label}
                        </span>
                      </dt>
                      <dd>{field.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="board-network-visual-muted">
                  No additional fields shown
                </p>
              )}
            </div>
            <div className="board-network-visual-space">
              <p className="board-network-visual-space-heading">
                Address space
                {space && (
                  <span>
                    {' '}
                    {space.first} – {space.last}
                  </span>
                )}
              </p>
              {space && (
                <figure
                  aria-label={`Usable IPv4 range ${space.first} to ${space.last}${pool ? `; configured DHCP pool ${pool.start} to ${pool.end}` : ''}`}
                >
                  <div
                    className="board-network-visual-track"
                    aria-hidden="true"
                  >
                    {pool && (
                      <span
                        className="board-network-pool"
                        style={{
                          left: `${pool.offsetPercent}%`,
                          width: `${pool.widthPercent}%`,
                        }}
                      />
                    )}
                  </div>
                  <figcaption>
                    <span>{space.first}</span>
                    <span>{space.last}</span>
                  </figcaption>
                  {pool && (
                    <p className="board-network-visual-pool-range">
                      <span>
                        DHCP {pool.start} – {pool.end}
                      </span>
                      <span>{count(pool.count)} addresses</span>
                    </p>
                  )}
                </figure>
              )}
              <p className="board-network-visual-message">{diagramMessage}</p>
            </div>
            {presentation.notes && (
              <p className="board-network-visual-notes">{presentation.notes}</p>
            )}
          </section>
        );
      })}
      {networkDisplayValue(element.properties.notes) && (
        <p className="board-network-notes">
          {networkDisplayValue(element.properties.notes)}
        </p>
      )}
    </div>
  );
}
