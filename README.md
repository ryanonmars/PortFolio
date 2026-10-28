# PortFolio

**Visual Network Documentation**

Application: **PortFolio** · Private GitHub target: `ryanonmars/portfolio` · Docker: `ghcr.io/ryanonmars/portfolio` · Development: `~/VS_Code/PortFolio`

**Local MVP trial — v0.1.0 candidate.** Open a site to see stacked equipment with detailed RJ45/SFP faceplates. Use the sidebar folders to open saved records. A device opens its visual detail page; **Configure interfaces** opens its compact port editor. Records live in SQLite on your server and are shared across browsers. JSON export/import and SQLite recovery are included.

This is manual documentation: no discovery, telemetry, monitoring, SNMP, SSH or actual network configuration changes. No accounts or example networks are created automatically. No public release or image publication has been made.

## Start a local trial

With Docker Desktop running, build and start from this directory:

```bash
PORT=3090 docker compose up -d --build --wait
```

Open [PortFolio on port 3090](http://127.0.0.1:3090), create your administrator account, then add a workspace and site. This machine uses 3090 because 3088 belongs to another app. Compose defaults to 3088 when PORT is omitted. Existing `./data` is retained; use a separate source directory/data bind for a disposable fresh trial.

Search is at the top of the sidebar. Workspaces are expanded by default, with their sites directly beneath them. Click a site once to open its Visual Overview; collapse workspace branches when useful. The selected site has one file-explorer section: Visual Overview, Equipment, VLANs, Networks & Subnets, Connections, Racks, Templates, and Import & Export. **+** beside Workspaces creates a workspace; **+** beside a workspace creates its site. Category labels open their overview, chevrons reveal saved records, and plus buttons open creation forms. Records appear and update directly from the database; no individual ports clutter the tree. **Manage** beside Workspaces or the Site Tools heading opens the relevant list with **Edit** and **Delete** controls. Deleting a workspace or site removes its contents after one impact confirmation. Global Settings also provides organization management and backup guidance. On a small screen, open **Menu**.

1. Choose Equipment **+**, pick Router, Switch, Firewall, Wireless access point, Server or Custom device, and adjust its port groups. Quantities, connector types, modes, front/rear faces and group order are editable. Save creates the device and ports together. Racks, IP addresses and subnets are optional.
2. Define VLANs when needed. In Configure, set native/untagged VLAN, independent PVID and tagged memberships; save, then return to Visual.
3. Select a port for the full inspector or **Configure this port** for the matching table row. Routed/WAN is a first-class mode, and every link state is manually documented.
4. Use Connections to manage physical cables and device-level logical links. Physical endpoints remain exclusive; logical links do not occupy ports. The grid and port inspector show the same physical cable records. Use another browser to verify saved records.
5. Save reusable layouts in Templates; template edits affect future devices, not existing equipment. Download site JSON from **Import & Export**. Preview an import as a new site copy before trying explicit replacement. Keep a SQLite backup before adding valuable records.

To stop this app without deleting its data, use `docker compose stop portfolio`. Follow the backup and recovery steps below before moving or replacing a data directory.

## Information hierarchy

```text
Workspace (Home / Work / Client)
└── Site (Home Network / Trailer 1 / ...)
    ├── Network settings, subnets and DHCP
    ├── VLAN definitions
    ├── Devices (router / switch / other)
    │   └── Ports (typed mode, native/PVID/tagged, connection, notes)
    ├── Connections
    ├── Optional physical racks (grouping devices only)
    └── Visual equipment dashboard (derived from the same records)
```

A **site is not a rack**: a site can contain equipment on a shelf, several physical racks, or no racks. One site's VLAN definitions are shared across that site's devices and optional racks.

Delete a site or workspace directly from its list to remove everything beneath it. One confirmation shows the affected counts, including devices, ports, networks, custom fields and cables. No manual child cleanup is required. Cancelling changes nothing; confirming permanently deletes the selected tree while retaining other sites/workspaces and saved backup files.

## Implementation

- React + TypeScript + Vite (client)
- Node.js + TypeScript + Fastify (API)
- SQLite with versioned migrations (one persistent volume)
- Zod for validation and shared contracts
- Docker multi-stage build, single runtime app container, Compose with loopback-only binding by default
- Vitest unit/API integration tests and Playwright browser workflows; GitHub Actions checks configured

## Privacy and example data

The checked-in example uses **invented network addresses and device identities**. Do not put real home/work topology, serial numbers, MACs, credentials, config exports, or customer information into the Git history. `design-reference/approved-rj45-port-style.png` is a _visual reference_, not a production UI asset.

## Repo structure

```text
AGENTS.md                      Agent-wide rules
agents/ORCHESTRATION.md        Sol 6.1 coordinator, subagent protocol
agents/roles/                 Scoped agent instructions
apps/web/src/                 Visual equipment, Configure and transfer UI
apps/api/src/                 Same-origin authenticated API
packages/shared/src/          Typed schemas and archive graph validation
packages/db/migrations/       Checksummed SQLite migrations
tests/e2e/                    Desktop/mobile browser workflows
docs/                         Complete implementation specification
examples/sample-site.json     Synthetic fixture specification
scripts/                      Tooling scripts (M0 onward)
design-reference/             Approved visual reference screenshot
.github/workflows/            Configured validation and container checks
```

## Local deployment target

Develop/test on **macOS + Docker Desktop**, then allow migration to **TrueNAS SCALE / Docker Compose**. Everything persistent (database, optional uploads, backups) must be mounted under a documented `/data` directory inside the container. Initial exposure: `127.0.0.1` only. No cloud services or telemetry required.

## Run locally

Requires Node.js 24 (see `.node-version`) and pnpm 10.28.2. If using nvm, run `nvm use 24` first; older Node versions do not provide the SQLite runtime.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open [PortFolio](http://127.0.0.1:3088). The API serves the compiled frontend on the same origin. For development, run `PUBLIC_ORIGIN=http://127.0.0.1:5173 pnpm dev` and `pnpm dev:web` in separate terminals, then open [Vite](http://127.0.0.1:5173). The database defaults to `./data/app.sqlite`; override with `DATA_DIR`. All configuration remains server-side.

```bash
docker compose up -d --build
docker compose down
```

Compose builds `ghcr.io/ryanonmars/portfolio:local` locally; it does not publish an image. It binds to loopback and preserves `./data:/data` on recreation. The container runs as UID/GID 1000, drops capabilities, prevents privilege escalation, and uses a read-only root filesystem with temporary `/tmp`. Persistent data and backups stay in `/data`. Do not use `docker compose down --volumes` as a backup strategy. On Linux, create `data` and grant UID/GID 1000 write/traverse access before starting; avoid world-writable data permissions.

## Validation and database maintenance

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm audit --audit-level=moderate
pnpm db:migrate
pnpm db:backup
```

Backups contain private data. Keep them outside source control and restrict access. Use the backup CLI's SQLite-safe snapshot rather than copying an open WAL database. Create the first administrator account, then add workspaces and sites. Authentication and organization records persist on the server. Equipment, ports, VLANs, racks, subnets and DHCP are available through the authenticated API. Site pages show illustrated equipment faceplates. Configure includes equipment entry, inline ports, custom columns, documented connections and Import & export.

Inside a running production container, use the compiled maintenance CLI (no development tooling required):

```bash
docker compose exec portfolio node dist/scripts/database.js migrate
docker compose exec portfolio node dist/scripts/database.js backup
```

If port 3088 is in use, start with `PORT=3090 docker compose up -d --build` and open [PortFolio on port 3090](http://127.0.0.1:3090). This changes only the host binding; the container still listens on port 3088.

For development when the default API port is occupied, use separate terminals:

```bash
PORT=3092 PUBLIC_ORIGIN=http://127.0.0.1:5173 pnpm dev
API_TARGET=http://127.0.0.1:3092 pnpm dev:web
```

The proxy preserves the browser Host and Origin. `PUBLIC_ORIGIN` must match the URL you open. Session cookies are HttpOnly/SameSite Strict, with Secure enabled for an HTTPS origin. The local HTTP default supports Docker Desktop without a TLS proxy.

## Equipment and network data

Authenticated site APIs now support devices, numbered ports, VLANs, optional racks, IPv4 subnets and DHCP scopes. Devices need no rack, subnet, IP address or pre-created VLAN. Port modes include true routed/WAN, optional explicitly documented VLAN encapsulation, and independent PVID. Only documented link state is stored; no devices are contacted.

Changes use version numbers to reject stale edits and transactions to avoid partial port generation or membership updates. VLAN references remain scoped to the site. The site Visual page renders stored records as equipment faceplates; choose Configure for the editing grid.

For a disposable local demo using only the shipped synthetic fixture:

```bash
NODE_ENV=development DATA_DIR=.tmp/demo pnpm db:seed
DATA_DIR=.tmp/demo PORT=3092 PUBLIC_ORIGIN=http://127.0.0.1:5173 pnpm dev
# Separate terminal:
API_TARGET=http://127.0.0.1:3092 pnpm dev:web
```

The seed requires an explicit development/test environment and data directory, refuses an existing workspace inventory, and creates no credentials. Open Vite to set up the administrator normally. It creates the blueprint's reciprocal router-to-switch cable. Never seed your production data directory. The blueprint is a development seed format; use the authenticated site export for portable schemaVersion1 JSON.

M2 IPAM accepts canonical IPv4 CIDRs only (zero host bits); DNS and DHCP are IPv4-only. Device management addresses may be IPv4 or IPv6. Gateways and DHCP ranges must be inside the subnet; network/broadcast endpoints are excluded except for /31 and /32. Sequential port generation accepts up to256 per request. Applying a saved port layout can add mixed connector/front-rear groups atomically; the total remains at most512 ports per device.

## Browse and configure records

Workspaces contain directly linked sites. Below them, expand Equipment, VLANs, Networks & Subnets, Connections, Racks or Templates to reveal real records. Search matches saved names, VLAN IDs and networks; large folders show64items initially with **Show more**. Chevron, category label, record and plus actions stay separate. Expansion choices survive ordinary navigation.

Selecting a device opens its metadata, approved front panel and compact interface/connection summary. **Configure interfaces** opens the editor. Equipment also provides a straightforward inventory; VLAN records show their description, color, related subnets and actual native/tagged members. Networks, racks, templates and connections have focused views.

- The port table starts with seven core columns: Port, Interface type, Mode, Native/Untagged VLAN, Tagged VLANs, Connected to and Documented link state. Cells are readable text until clicked or activated with Enter/F2. Tab/arrows navigate; Enter finishes the local edit; Escape restores the current saved cell without discarding other drafts.
- Select a row for the details inspector, including PVID, speed, face/order, external destination, notes and typed custom fields. Optional columns remain configurable. Secondary row Save/Delete actions live in a small Actions menu.
- **Save all changes** atomically saves all staged core/custom values across64-row pages. Invalid or stale rows leave the whole batch unchanged and retain drafts. Bulk tools and existing header-based TSV preview remain available. Direct rectangular clipboard paste validates every candidate before staging; unsupported cable/custom edits require the inspector rather than silently changing them.
- **Add ports** supports one port, sequential groups and existing built-in/saved layouts with RJ45/SFP/SFP+/other connector types. Applying a layout to the existing device is versioned and atomic; it never creates another device or partially adds groups.
- Structured cable actions remain separate from core saves and require clean row drafts. Exact replacement confirmation protects occupied endpoints; external labels remain annotations. Refresh/site/record navigation protects unsaved changes.

The single runtime remains local at the configured loopback port. No scanning or live device changes occur.

## Equipment faceplates

Open a site to see its stored equipment as stacked front panels. Select a port for its mode, native/tagged VLANs, independent PVID, documented link state, peer, notes and custom values. **Configure this port** opens the same record in the editing grid. Return to **Visual** after saving to see the updated illustration.

RJ45 sockets keep the approved detailed design at every density; larger devices use two rows and internal scrolling. Other connector types have distinct illustrations. Native VLAN borders use the saved VLAN colors; routed/WAN ports are neutral. VLAN color does not indicate an active link. Device move controls save stack order on the server, including for another browser. Racks are optional.

## Site export and import

Select a site, choose **Import & Export**, then **Download site JSON**. The versioned file contains that site's equipment, ports, VLANs, racks, subnets/DHCP, custom fields/values and cables. Accounts, sessions, backups and browser preferences are excluded. Treat exported network documentation as private.

Choose the JSON file or paste its contents, select a policy and **Preview import**. Files are limited to8MiB. **New site copy** is the default and creates a named copy in the current workspace, including when the file came from another workspace or instance. **Replace current site** requires explicit acknowledgement; it keeps the selected site's identity, name and workspace while replacing its description, notes and all child records. Imported child IDs are regenerated with their references preserved.

Preview validates the whole graph without writing. The preview expires after15minutes and is invalid after a server restart, changed import inputs, or changes to the target records. Refresh the preview when prompted. A private SQLite backup must succeed before commit; invalid or stale imports leave current records intact. SQLite backups contain accounts and sessions as well as documentation, so full recovery should be performed only from trusted private snapshots.

## Recover a SQLite snapshot

Recovery restores into an explicitly chosen new data directory. It refuses an existing `app.sqlite` or its journals, validates integrity, foreign keys and migration history, and publishes only a complete private snapshot. Keep the original data and snapshot until the recovered instance is verified.

With Node24 and the repository available:

```bash
DATA_DIR=./recovered-data pnpm db:restore /absolute/path/to/snapshot.sqlite
PORT=3090 DATA_DIR=./recovered-data pnpm start
```

Stop any app already serving that host port before starting the recovered instance. For Docker, first stop this app and restore with the local image into a separate bind mount (replace the snapshot filename):

```bash
docker compose stop portfolio
mkdir -m 700 recovered-data
docker compose run --rm --no-deps -e DATA_DIR=/recovered \
  -v "$PWD/recovered-data:/recovered" portfolio \
  node dist/scripts/database.js restore /data/backups/YOUR-SNAPSHOT.sqlite
```

Then change only this application's Compose data bind from `./data:/data` to `./recovered-data:/data`, ensure it is writable by UID1000, and run `PORT=3090 docker compose up -d --wait` (or your chosen port). Sign in and verify the recovered records before retiring the old data. The restore command does not overwrite the original data or copy a live WAL file directly. On filesystems without hard-link support, atomic recovery publication fails safely; use a local filesystem that supports hard links.

## Logs and troubleshooting

```bash
docker compose ps
docker compose logs --tail=100 portfolio
```

An unhealthy startup usually needs a writable data directory, a free host port, or a matching `PUBLIC_ORIGIN`. Preserve the data directory before investigating migration-history or disk errors; do not reset the database to bypass them. A 409 keeps the current saved records and asks you to reload or preview again. An expired session clears private views and unsaved drafts, so save before leaving the app idle.

## TrueNAS portability

TrueNAS supports custom applications through Compose YAML and persistent host-path datasets. Follow the official [custom app instructions](https://apps.truenas.com/managing-apps/installing-custom-apps/) and [host-path permission guidance](https://apps.truenas.com/getting-started/app-storage/). The local trial was tested on Docker Desktop; no TrueNAS installation is claimed.

- Build this source locally on the destination host, or transfer the locally built image with Docker save/load. The `:local` tag is not available from a published registry.
- Replace `./data:/data` with an absolute path to a dedicated local dataset directory. Grant the container's UID/GID 1000 write/traverse access, including the directory for SQLite journals and private backups. Use a local filesystem with working SQLite locks and hard links; do not place the live database on an SMB/NFS share.
- Keep the nonroot user, read-only root filesystem, `/tmp` temporary mount and capability restrictions. Recovery staging uses temporary space; allow enough memory/temp space for the backup being restored.
- A loopback bind on TrueNAS is reachable only from that host. Keep it for a host-local trial or explicit SSH tunnel. LAN/public exposure requires a deliberate binding/origin/TLS/access-control decision and is outside this local trial; the app does not enable it automatically.
- Move records through a site JSON export or restore a completed SQLite-safe snapshot into a new dataset directory. Verify login, equipment, VLANs and cables before retiring the old instance. Keep independent backups outside the live data dataset.

## Trial boundaries

One local administrator; manual documentation only. Subnets, DNS and DHCP are IPv4-only, while device management addresses also accept IPv6. Ports are capped at 512 per device and portable site JSON at 8 MiB. CSV transfer, discovery, monitoring, router writeback, enterprise permissions and internet hosting are outside this MVP trial. Browser layouts are checked with desktop Chromium and mobile emulation, not every physical browser/device. GitHub Actions is configured but has not run remotely; no commit, tag, push, image publication or release is authorized by preparing this trial.

Reusable device templates belong to the application and can be used across sites. Built-in starters are read-only; save a copy to customize one. A template contains port layout defaults, never site VLAN references or device credentials. Site JSON contains the created equipment snapshot and logical links; global saved templates are included in full SQLite backups. Older site JSON without logical links still imports.
