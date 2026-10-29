# PortFolio

**Visual Network Documentation**

A self-hosted visual documentation board for network equipment. Create a board, add devices or network containers, arrange them freely, and connect their ports. Changes save to server SQLite automatically. No discovery, monitoring, telemetry, or device configuration writes.

## Run locally

```sh
docker compose up -d --build
```

Open `http://localhost:3088`, the server's private IP address, or a local hostname such as `http://dockge.truenas:3088`. Create the administrator account; there are no default credentials. Direct HTTP LAN access needs no origin configuration. Compose publishes port 3088 on all host interfaces and stores persistent data in `./data`. Set `BIND_ADDRESS=127.0.0.1` for loopback-only publishing. The container runs without root, with a read-only filesystem and dropped capabilities. Local builds use `ghcr.io/ryanonmars/portfolio:local`.

The default runtime identity is `1000:1000`. Set optional `PUID` and `PGID` in Compose’s `.env` to use different numeric IDs. Use positive, nonzero IDs; no matching named user or group is needed on the host. Direct `docker run` deployments can use the standard `--user UID:GID` option.

On Linux, create the data directory before startup with ownership for the selected UID/GID (default shown):

```sh
sudo install -d -m 0700 -o 1000 -g 1000 data
```

## TrueNAS SCALE / Dockge

Use [deployment/compose.yaml](deployment/compose.yaml) and [deployment/.env.example](deployment/.env.example); this deployment pulls the published image and requires no source checkout or GitHub credentials once the package is public. Put the Compose stack and its `.env` in `/mnt/tank/stacks/portfolio`. In Dockge, paste that Compose file and set the environment values. For the TrueNAS `apps` identity, set `PUID=568` and `PGID=568` in `.env`, then create the persistent directory with those IDs:

```sh
sudo install -d -m 0700 -o 568 -g 568 /mnt/tank/configs/portfolio
```

On TrueNAS datasets with managed ACLs, grant the selected UID/GID access through the dataset ACL instead of replacing existing permissions. Keep application data separate from the stack folder. The bind mount deliberately refuses to create a missing data directory.

Open the server's LAN IP or local hostname and create the administrator account. No `PUBLIC_ORIGIN` setting or reverse proxy is required for basic HTTP LAN access. Docker listens on internal port 3088 and persists SQLite and backups under `/data`.

The persistent directory and existing database, journal/WAL and backup files must be readable and writable by the selected identity. Before changing an existing deployment’s IDs, stop the application, back up its data and arrange the required ownership or ACL access yourself. The container never changes ownership or broadens permissions automatically; incorrect access causes startup or recovery to fail. Application files remain read-only, and the read-only root filesystem, dropped capabilities and `no-new-privileges` protections apply to every identity. Existing deployments that omit these settings retain `1000:1000`.

| Variable          | Default                       | Purpose                                                                                                      |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `IMAGE_TAG`       | `v0.1.1`                      | Published version; pin production deployments. `latest` follows stable releases.                             |
| `PUID`            | `1000`                        | Non-root numeric runtime user ID; use `568` for the TrueNAS apps identity.                                   |
| `PGID`            | `1000`                        | Non-root numeric runtime group ID; use `568` with TrueNAS apps.                                              |
| `PORT`            | `3088`                        | Published host port; internal port remains 3088.                                                             |
| `BIND_ADDRESS`    | `0.0.0.0`                     | Host interfaces; use `127.0.0.1` for local access only.                                                      |
| `DATA_PATH`       | `/mnt/tank/configs/portfolio` | Existing writable host directory mounted at `/data`.                                                         |
| `PUBLIC_ORIGIN`   | optional                      | Exact HTTPS reverse-proxy URL or explicitly trusted public-domain origin.                                    |
| `ALLOWED_ORIGINS` | empty                         | Optional additional exact HTTP(S) origins, separated by commas.                                              |
| `TRUSTED_HOSTS`   | empty                         | Optional strict hostnames/IPs, separated by commas; a port restricts that entry. Blank keeps automatic mode. |

The default Host policy accepts loopback, RFC1918, link-local, Tailscale/CGNAT IPv4 addresses, local IPv6 addresses, and local DNS namespaces such as `.local`, `.internal`, `.home.arpa`, or `.truenas`. It uses a bundled [IANA root-zone snapshot](https://data.iana.org/TLD/tlds-alpha-by-domain.txt) to distinguish local suffixes from delegated public DNS namespaces. It makes no DNS lookups or external requests at runtime. Public-domain names remain blocked unless explicitly trusted, even when they resolve to a private address; this prevents the usual public-domain DNS-rebinding attack. `.onion` and `.alt` are not automatically trusted.

Custom local suffixes rely on the snapshot remaining current: a newly delegated public TLD needs a snapshot update in a future release. Refresh the snapshot and its integrity test when releasing. Deployments that need an enduring fixed Host boundary can set `TRUSTED_HOSTS`, for example `dockge.truenas,192.0.2.10:3088,localhost`. This replaces automatic LAN acceptance; configured origins must also fit that strict list. Entries without ports allow any valid port for that exact hostname; wildcards are unsupported. Malformed nonblank settings fail startup.

Each API request validates its Host. Any supplied Origin must exactly match the request's expected origin, including scheme and port; writes also require the existing session CSRF token. Cookies remain host-only, HttpOnly and SameSite=Strict. Secure is enabled for actual TLS or an exact configured HTTPS proxy authority, never from untrusted forwarded headers. For an HTTPS reverse proxy or public Tailscale hostname, preserve the browser's Host and set `PUBLIC_ORIGIN=https://your-hostname`. Additional exact public origins can go in `ALLOWED_ORIGINS`. These settings augment automatic LAN access unless strict hosts are enabled. Split-DNS names under public TLDs need explicit trust as well. `LOCAL_ORIGIN` remains an optional compatibility setting; localhost needs no registration in automatic mode. Compose leaves optional origin variables unset unless configured; strict hosts therefore need no hidden loopback exceptions.

Keep Docker binding or firewall restrictions appropriate to the network. No tunnel, router port forwarding or public DNS setup is created by this stack.

To upgrade, back up the data, change `IMAGE_TAG` to a new stable version, then use Dockge's pull/recreate actions or:

```sh
docker compose pull
docker compose up -d --wait
```

Migrations run at startup. Keep the previous image tag and backup; rolling back a database upgrade means restoring the matching backup into a new empty directory, rather than replacing a live database.

The published image supports Linux amd64 and arm64. Verify public pulls without cached Docker credentials:

```sh
docker --config /path/to/empty-docker-config pull ghcr.io/ryanonmars/portfolio:v0.1.1
docker buildx imagetools inspect ghcr.io/ryanonmars/portfolio:v0.1.1
```

The source repository remains private. If package visibility needs setup, open the `portfolio` package under the GitHub account's Packages, choose Package settings, remove inherited repository access if required while retaining the repository under Manage Actions access, and change the package visibility to Public. Public visibility must be verified with an anonymous pull, not assumed from an authenticated one.

## Use the board

- **Boards** are standalone; optional **Groups** are folders. The sidebar supports creation, renaming, duplication, deletion and board reordering. Collapse it for more canvas space.
- **Add → Device** creates an empty router, switch, firewall, access point, server or custom device. No rack, network or address setup is needed.
- The Device inspector’s **Visible Fields** controls choose and order header information. Manufacturer, Model and Management Address appear by default when populated. The header stays 80 pixels high; values truncate and lower-priority pills hide as needed, with full values in tooltips and the inspector. Device dimensions, port positions and cables never change to fit this content.
- On desktop, drag empty canvas to select enclosed containers. Shift-click adds to the selection; Command/Ctrl-click toggles an object. Drag a selected device’s title, header or empty body to move the selection together with shared snapping; Escape cancels movement. Space-drag or middle-drag pans.
- On touchscreens, tap a container to select it without opening configuration. Drag its move handle to reposition it, or tap its settings action to open the inspector. Closing the inspector keeps the container selected. On desktop, drag a device title, header or empty body to move it; clicking a selected member keeps the group selected. Drag an edge or corner to resize it. Grid, edge, center and spacing guides help alignment; hold Alt/Option to bypass snapping. Resizing retains existing port placement and cannot shrink through occupied slots.
- Use **Pan**, Space-drag, the mouse wheel/trackpad, Ctrl/Command-wheel zoom, pinch or **Fit** to navigate.
- Click a name to edit it inline on desktop. Desktop container clicks and individual port taps open the contextual inspector. Mobile inspectors use a bottom sheet with a compact header: tap or drag its handle to expand/collapse, drag down to dismiss, or use Close. Fields and secondary actions scroll inside the sheet; focusing a field expands the editing area and adapts it to the visible keyboard area. All property edits autosave; there is no separate configuration page.
- The mobile header keeps Explorer available while using the Equipment Dock. Explorer opens as a drawer; selecting a board closes it. Creation dialogs fit the visible screen, with reachable close and action controls. Mobile inputs use 16px text while preserving browser pinch zoom.
- The device inspector adds RJ45, SFP, SFP+, QSFP and custom ports individually or in bulk. Drag a connector from the picker onto a slot, or use its add button. **Edit port layout** enables relative-slot movement; front/rear faces share the same device. Bulk adds create one horizontal run by default; **Ports per row** optionally chooses an explicit multi-row block. Only new ports can expand the container during insertion. Resizing exposes additional slots without moving ports, and smaller screens use pan/zoom rather than wrapping.
- **Layout preset** in the device's Ports inspector offers Single row, Stacked — Odd on top, Stacked — Odd on bottom, and Sequential rows, with a live connector preview. **Bank placement** sets a label prefix, starting number and grid offsets for each new batch. Creating a port layout grows the device only as needed to fit the new ports; existing port positions and larger custom dimensions are retained. **Arrange existing ports → Apply layout** changes only current-face positions in creation order, preserving names, configuration and cables. Undo/Redo works, and every port remains freely editable afterward.
- Port Purpose, Interface IP / Address, Native VLAN, Tagged VLANs and PVID are independent documentation. Help icons support hover, focus, click and touch. Link Status is manually documented as Unknown, Up or Down; existing unsupported text stays available as a saved value until explicitly replaced. They do not require definitions or conventional networking combinations. Port names may repeat because connections use stable IDs. Explicit port colors take priority over matching optional Network entry colors.
- Hover or keyboard-focus a port for a compact, read-only summary with labeled configuration pills, documented link status and the connected device/port. The card stays within the viewport at any board zoom, wraps long values and scrolls when needed. Escape dismisses it. Touch long-press retains the existing Copy/Paste menu and its summary.
- Right-click a port (or hold it on touch) for **Copy Port Settings** and **Paste Settings**. Command/Ctrl-click toggles ports; Shift-click selects a range on one device face. Touch users can choose **Select Multiple Ports** in the menu and tap destinations. Click a configuration heading or its copy icon to copy just that field; help icons stay separate. Paste changes settings in one undoable action while preserving names, slots, faces, devices and cables. Empty settings intentionally clear destination values. The structured application clipboard lasts for the signed-in session, works across boards, and clears on logout or expiry; ordinary text-field copy/paste is unchanged.
- **Add → Network** creates an independent information container. Add multiple VLAN/subnet/DHCP entries, choose **Visible fields**, and add arbitrary custom fields. Enable **Custom fields** under **Visible fields** to include them in the summary. Selected values appear as labeled chips with VLAN color accents; notes remain readable text. Long values wrap within the saved container size, with internal scrolling when needed. Empty fields stay out of the compact canvas summary. The container title and individual VLAN names are separate. DHCP Server controls only the entry’s optional pool fields; switching it off retains the range. Previous entry names, IP addresses, network-level PVID and DHCP text remain available under **Preserved fields**.
- **Add → Cable**, then choose two ports. Escape cancels. Curved cables follow devices and relative port positions. Select a cable for its name, endpoints, connector metadata, color, length and notes. **Cables** hides/shows the layer.
- Undo/Redo and Ctrl/Command-Z apply to significant board changes. Delete removes the selected object; attached cable removal asks once. Ctrl/Command-D or the inspector duplicates a container.

The approved detailed connector artwork is retained at every zoom. Link states are manually documented; VLAN and cable colors do not indicate live status.

## Autosave and recovery

Autosave is debounced and serialized. Each write includes the board version; concurrent changes cannot silently overwrite one another. **Saved** means the submitted revision was acknowledged. Failed edits remain in the current editor. Retry temporary failures, download an unsaved draft, or explicitly load the saved board after reviewing a conflict. Board switching and logout wait for pending saves.

The board menu exports versioned JSON and a clean SVG image. Import previews a new board and remaps object IDs; it never replaces an existing board. JSON preserves layouts, port identity relationships, cables and authored custom data.

```sh
docker compose exec portfolio node dist/scripts/database.js backup
# Restore into a NEW empty data directory, never over the running database:
DATA_DIR=/path/to/new-empty-data pnpm db:restore /path/to/snapshot.sqlite
```

Backups contain private documentation and account/session data. Keep them private.

For production, copy backups out of `/data/backups` to a separate protected location. To restore on Docker, stop the service, prepare a new empty host directory writable by the configured `PUID`/`PGID` (default `1000:1000`), and run the same pinned image against that directory:

```sh
docker compose stop
docker compose run --rm --no-deps \
  -e DATA_DIR=/restore \
  -v /path/to/new-empty-data:/restore \
  -v /path/to/private-backups:/snapshots:ro \
  portfolio node dist/scripts/database.js restore /snapshots/snapshot.sqlite
```

Then set `DATA_PATH` to the restored directory in the production `.env` and start the stack. Keep the original directory until recovery has been verified. Never copy a live SQLite file as a substitute for the backup command.

## Existing data

Migration007 adds board/group storage without editing earlier migrations or deleting relational data. Existing Sites become Boards and Workspaces become optional Groups. Equipment, ports and physical cable IDs remain stable. VLANs, subnets and DHCP scopes become editable Network entries. Original rows, custom definitions, templates, racks and unsupported logical links remain in a recoverable legacy payload and the original tables. Conditional **Migration notes** identify records retained for recovery rather than active board objects. Conversion is idempotent; deleting a migrated board does not recreate it on restart.

Production exposes board, authentication and health APIs. Old editing routes are retired. Explicit compatibility registration exists only for the legacy regression suite.

The pre-redesign code checkpoint is local commit `3dd2fbf`. For rollback, use that checkpoint in a separate checkout with its pre-upgrade backup restored into a new data directory. Do not replace a live SQLite file or destructively rewrite Git history.

## Development

Node24 and pnpm10.28.2 are pinned. React/TypeScript, Fastify and SQLite remain the only application stack; the HTML/SVG canvas adds no diagramming dependency.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm dev:web
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

The browser suite covers the board product on desktop and mobile with isolated synthetic databases. Legacy domain API/security/migration tests remain active in explicit compatibility mode. No automated tests use live network devices or the user's data.

## Current limits

Undo history is bounded and lasts for the open editor session. SVG image export shows the currently selected front/rear faces. Wide physical layouts remain identical on every screen; use pan/zoom on phones. Mobile supports deliberate selection, handle movement, bottom-sheet configuration and creation through the Equipment Dock. Real iPhone Safari keyboard/focus behavior should be checked on the target device in addition to automated WebKit coverage. Cable sag/physics is future work.

CI checks pull requests and pushes to `main`. Stable `vX.Y.Z` tags require successful CI for the exact tagged commit on `main` before publishing versioned, `latest`, and commit image tags to GHCR. Publishing uses GitHub Actions' scoped token; ordinary development pushes do not publish images. Tags must match `package.json` and belong to `main`. Do not reuse release tags.
