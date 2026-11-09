# Installation and operations

PortFolio is intended for private, self-hosted use. It runs on a single server with persistent local storage; browsers connect to that server. No external service is required for normal board editing.

## Published Docker image

Use Docker Engine and Compose v2. The image supports Linux amd64 and arm64. The [release Compose file](../deployment/compose.yaml) pulls the image; the [repository-root Compose file](../compose.yaml) builds it from source.

```sh
mkdir portfolio && cd portfolio
curl -fsSLO https://raw.githubusercontent.com/ryanonmars/PortFolio/v0.4.1/deployment/compose.yaml
curl -fsSL https://raw.githubusercontent.com/ryanonmars/PortFolio/v0.4.1/deployment/.env.example -o .env
```

Edit `.env`. Pin `IMAGE_TAG=v0.4.1` and choose an absolute `DATA_PATH`. Create that directory before starting. On Linux, the default runtime identity is `1000:1000`:

```sh
sudo install -d -m 0700 -o 1000 -g 1000 /absolute/path/to/portfolio-data
docker compose pull
docker compose up -d --wait
```

Visit `http://localhost:3088` on the host, or the server's private address/local hostname from another device. Create the administrator account immediately on first startup. No default credentials exist.

The container runs as a non-root numeric UID/GID with a read-only root filesystem, dropped capabilities, and `no-new-privileges`. Its writable application data lives at `/data`. The deployment mount refuses to create a missing host directory.

| Setting                          | Default                       | Purpose                                                               |
| -------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `IMAGE_TAG`                      | `v0.4.1`                      | Pinned release. `latest` follows stable releases.                     |
| `DATA_PATH`                      | `/mnt/tank/configs/portfolio` | Existing writable directory mounted at `/data`. Change for your host. |
| `PUID`, `PGID`                   | `1000`, `1000`                | Positive, nonzero numeric runtime IDs.                                |
| `PORT`                           | `3088`                        | Published host port; container port remains 3088.                     |
| `BIND_ADDRESS`                   | `0.0.0.0`                     | Set `127.0.0.1` for host-only access.                                 |
| `PUBLIC_ORIGIN`                  | unset                         | Exact HTTPS origin when using a reverse proxy.                        |
| `ALLOWED_ORIGINS`                | empty                         | Additional exact HTTP(S) origins, comma-separated.                    |
| `TRUSTED_HOSTS`                  | empty                         | Optional strict list of exact hostnames/IPs, with optional ports.     |
| `ATTACHMENT_MAX_BYTES`           | `20971520`                    | Per-file attachment limit, 20 MiB.                                    |
| `ATTACHMENT_STORAGE_MAX_BYTES`   | `2147483648`                  | Retained attachment storage limit, 2 GiB.                             |
| `INTEGRATION_ALLOW_PRIVATE_HTTP` | `false`                       | Explicit server opt-in for bearer API use over private HTTP.          |

No matching named user/group is required on the host. Existing databases, WAL/journal files, backups, and attachments must all be accessible to the selected identity. Before changing IDs, stop the service, back up, and arrange ownership or ACL access. The container never changes host ownership or broadens permissions automatically.

### TrueNAS SCALE and Dockge

Keep the stack, `.env`, and application data in separate directories, for example `/mnt/tank/stacks/portfolio` and `/mnt/tank/configs/portfolio`. In Dockge, use [deployment/compose.yaml](../deployment/compose.yaml) and its [environment example](../deployment/.env.example).

For the TrueNAS `apps` identity, set `PUID=568`, `PGID=568`, and create the data directory with those IDs:

```sh
sudo install -d -m 0700 -o 568 -g 568 /mnt/tank/configs/portfolio
```

For datasets with managed ACLs, grant the selected UID/GID access through the dataset ACL rather than replacing existing permissions. Pull and start the stack, then open `http://your-server:3088`.

## Private access and HTTPS

Direct HTTP access on a trusted LAN requires no origin configuration. HTTP carries credentials and documentation without transport encryption; use HTTPS when the connection needs protection. Keep the service bound or firewalled to the intended private network. PortFolio creates no tunnel, router forwarding rule, or public DNS entry.

For an HTTPS reverse proxy, preserve the original browser `Host`, set `PUBLIC_ORIGIN=https://your-exact-hostname`, and restrict direct backend access to the proxy. This setting is the explicit TLS-termination trust boundary. Arbitrary forwarded-protocol headers are not trusted.

A Tailscale connection remains a private deployment. Prefer an HTTPS origin such as `https://portfolio.example.ts.net`, set the exact `PUBLIC_ORIGIN` on the server, and configure the MCP adapter with that URL. Tailscale and proxy configuration are managed separately; PortFolio does not set them up.

Automatic Host validation accepts loopback, private/local addresses, Tailscale/CGNAT IPv4, and local DNS namespaces. Public-domain hostnames require explicit trust, even when split DNS resolves them to a private address. `PUBLIC_ORIGIN` and `ALLOWED_ORIGINS` add exact trusted origins. A bundled IANA root-zone snapshot distinguishes local suffixes without runtime DNS queries. `.onion` and `.alt` are not automatically trusted.

Set `TRUSTED_HOSTS` for a fixed boundary, for example `portfolio.local,localhost:3088`. This replaces automatic LAN acceptance; configured origins must also match the list. Entries without ports accept any valid port for that exact host. Wildcards are unsupported. Malformed nonblank origin/host settings fail startup. Any supplied request Origin must match the expected origin, including scheme and port.

## Persistent data and backups

Preserve the entire `/data` mount across container replacement. SQLite holds boards, accounts, sessions, attachment metadata, integration token digests, and proposal/retry records. Files live under `/data/attachments`; backups default to `/data/backups`.

### Browser backup and restore

Open **Settings → Backup & Restore → Download Backup** to save a complete ZIP outside the server. The full-page Settings also includes General, API Tokens, and About; About shows the actual running application, SQLite migration, and Node versions.

To restore, upload the complete ZIP under **Restore backup**, review its verified version, date, board and attachment counts, type **RESTORE**, and confirm. This replaces the installation's persistent application state. A verified recovery ZIP is created first; the latest three are retained on the server. Normal activation requires no process or Docker restart. All browser sessions are signed out; sign in using an account/password from the backup.

Backups are unencrypted and contain private documentation, account password hashes, and API token digests. Protect them. Deployment environment variables and `.env` are excluded. Restore previews expire after 15 minutes; the default archive and expanded-data limit is 4 GiB. Run only one PortFolio server per `DATA_DIR`.

See [complete browser backups and restoration](BACKUP_RESTORE.md) for compatibility, storage requirements, recovery, and failure handling. Board JSON/SVG exports are separate and omit attachment binaries.

### Advanced CLI snapshot backups

The CLI remains available for scripted backups and recovery into a new directory. Its SQLite-plus-attachments pair is a different format from the browser ZIP; existing v0.4.0 CLI backups cannot be uploaded to browser restore.

Create a consistent CLI application backup:

```sh
docker compose exec portfolio node dist/scripts/database.js backup
```

The command prints the snapshot path. Each backup consists of **both** `snapshot.sqlite` and its adjacent **`snapshot.sqlite.attachments/` directory**, containing a manifest, original files, and existing image previews. Keep both parts together and copy them to a separate protected location. Never copy a live SQLite file as a substitute for this command.

Backups contain private documentation, files, account/session data, and integration credential state. Protect access and retention accordingly. Ordinary board JSON/SVG exports and duplication exclude attachment binaries and are not complete application backups.

### CLI restore into a new directory

Keep the original data directory. Prepare a new, empty directory writable by the configured runtime UID/GID and use the same pinned image:

```sh
docker compose stop
docker compose run --rm --no-deps \
  -e DATA_DIR=/restore \
  -v /absolute/path/to/new-empty-data:/restore \
  -v /absolute/path/to/private-backups:/snapshots:ro \
  portfolio node dist/scripts/database.js restore /snapshots/snapshot.sqlite
```

Restore verifies attachment sizes and hashes before publishing the restored database. Missing originals fail explicitly. Older database-only backups without attachment records remain supported. Set `DATA_PATH` to the restored directory in `.env`, start the stack, and verify your boards and attachments before retiring the old data. Review integration tokens after recovery: an older backup also restores its earlier expiration/revocation state.

For source installations, the equivalent commands are:

```sh
pnpm db:backup /absolute/path/to/private-backups/snapshot.sqlite
DATA_DIR=/absolute/path/to/new-empty-data pnpm db:restore /absolute/path/to/private-backups/snapshot.sqlite
```

Set `DATA_DIR` for the backup command too if the running source installation uses a nondefault directory.

## Update

1. Download a complete browser ZIP and keep it outside the application data directory, or create a CLI snapshot and copy both parts off-server.
2. Read the target release notes and retain the previous image tag.
3. Change `IMAGE_TAG` in `.env`, then pull and recreate:

```sh
docker compose pull
docker compose up -d --wait
docker compose logs --tail=100 portfolio
```

Supported migrations run automatically at startup. v0.4.1 introduces no SQL migration; existing board, attachment, and integration records remain compatible with v0.4.0. Keep the prior image and a matching backup. For CLI recovery, restore into a new empty directory rather than overwriting a live database.

## Run from source

Use Node **24.x** and pnpm **10.28.2**, matching `.node-version` and `package.json`.

```sh
git clone https://github.com/ryanonmars/PortFolio.git
cd PortFolio
git checkout v0.4.1
npm install --global pnpm@10.28.2
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Database creation and supported schema migrations run automatically at startup; no seed command is required.

Open `http://127.0.0.1:3088`. Source startup binds loopback by default and stores data in `./data`; configure shell variables such as `HOST`, `PORT`, and `DATA_DIR` as needed. A root `.env` is used by Compose interpolation; source development reads the process environment.

To build and run the local Docker image from the checkout:

```sh
sudo install -d -m 0700 -o 1000 -g 1000 data
docker compose up -d --build --wait
```

This uses `ghcr.io/ryanonmars/portfolio:local`. Run these commands from the source checkout, not the downloaded deployment stack.

## Troubleshooting

| Symptom                                                  | Check                                                                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container fails with a missing mount or permission error | Confirm `DATA_PATH` exists and the chosen `PUID:PGID` can read/write all data. Check dataset ACLs.                                                               |
| Browser cannot reach the service                         | Check `docker compose ps`, published port, `BIND_ADDRESS`, host firewall, and private network reachability.                                                      |
| Host or Origin is rejected                               | Use the exact scheme/host/port. Explicitly trust public-domain proxy names; check strict `TRUSTED_HOSTS` entries.                                                |
| Sign-in fails through HTTPS proxy                        | Preserve Host, set exact `PUBLIC_ORIGIN`, and use the same origin consistently. Check proxy cookie handling.                                                     |
| Image pull is denied or tag is missing                   | Confirm the tag exists on the release page and use `ghcr.io/ryanonmars/portfolio`. Public pulls need no login.                                                   |
| Attachment upload is rejected                            | Check supported type, per-file and retained-storage limits. Deleted retained files still count until cleanup.                                                    |
| Autosave reports a conflict                              | Keep the current draft, review it, then reload saved state. Another writer changed the board; do not blindly overwrite.                                          |
| Browser restore fails or its preview expires             | Check free disk space, data-directory access, and the verified error. Re-upload expired previews; see [backup recovery](BACKUP_RESTORE.md#storage-and-recovery). |
| MCP cannot connect or write                              | See [MCP troubleshooting](MCP.md#limits-and-troubleshooting), including both private-HTTP switches and token scope.                                              |

Use `docker compose logs --tail=100 portfolio` for startup diagnostics. Redact credentials, network details, and attachment content before sharing logs.
