# PortFolio

**Visual Network Documentation**

A self-hosted visual documentation board for network equipment. Create a board, add devices or network containers, arrange them freely, and connect their ports. Changes save to server SQLite automatically. No discovery, monitoring, telemetry, or device configuration writes.

## Run locally

```sh
docker compose up -d --build
```

Open `http://127.0.0.1:3088` and create the administrator account. Compose binds to loopback and stores all persistent data in `./data`. The container runs without root, with a read-only filesystem and dropped capabilities. The image identifier is `ghcr.io/ryanonmars/portfolio`; local builds use the `:local` tag.

## Use the board

- **Boards** are standalone; optional **Groups** are folders. The sidebar supports creation, renaming, duplication, deletion and board reordering. Collapse it for more canvas space.
- **Add → Device** creates an empty router, switch, firewall, access point, server or custom device. No rack, network or address setup is needed.
- Drag a device header to move it. Drag an edge or corner to resize it. Grid, edge, center and spacing guides help alignment; hold Alt/Option to bypass snapping. Resizing retains existing port placement and cannot shrink through occupied slots.
- Use **Pan**, Space-drag, the mouse wheel/trackpad, Ctrl/Command-wheel zoom, pinch or **Fit** to navigate.
- Click a name to edit it inline. Click a container or port for its contextual inspector. All property edits autosave; there is no separate configuration page.
- The device inspector adds RJ45, SFP, SFP+, QSFP and custom ports individually or in bulk. Drag a connector from the picker onto a slot, or use its add button. **Edit port layout** enables relative-slot movement; front/rear faces share the same device. Bulk adds create one horizontal run by default; **Ports per row** optionally chooses an explicit multi-row block. Only new ports can expand the container during insertion. Resizing exposes additional slots without moving ports, and smaller screens use pan/zoom rather than wrapping.
- Port roles, addresses, native VLAN, tagged VLANs and PVID are independent documentation. They do not require definitions or conventional networking combinations. Port names may repeat because connections use stable IDs. Explicit port colors take priority over matching optional Network entry colors.
- **Add → Network** creates an independent information container. Add multiple VLAN/subnet/DHCP entries, choose **Visible fields**, and add arbitrary custom fields. Empty fields stay out of the compact canvas summary. The container title and individual VLAN names are separate. DHCP Server controls only the entry’s optional pool fields; switching it off retains the range. Previous entry names, IP addresses, network-level PVID and DHCP text remain available under **Preserved fields**.
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

Selection is one object at a time. Undo history is bounded and lasts for the open editor session. SVG image export shows the currently selected front/rear faces. Detailed layout work is best on desktop; mobile supports viewing, pan/zoom, inspection and basic editing. Multi-object selection and cable sag/physics are future work.

Keep the existing private repository and local testing workflow. No public release, remote push or image publication is automatic.
