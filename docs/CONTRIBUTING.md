# Contributing

PortFolio is a board-first, offline/manual network documentation designer. Keep changes focused, preserve existing conventions, and use synthetic examples rather than personal network data. Read the repository's [AGENTS.md](../AGENTS.md) before making changes.

For a large feature or design change, discuss the intended behavior in an issue first. Bug reports should include the version, deployment method, browser, expected behavior, and a minimal synthetic reproduction. Redact credentials, private addresses, logs, and uploaded content. Follow [security reporting guidance](SECURITY.md#reporting-a-security-issue) for vulnerabilities.

## Local development

Use Node24 and pnpm10.28.2:

```sh
npm install --global pnpm@10.28.2
pnpm install --frozen-lockfile
pnpm dev
```

In a second terminal:

```sh
pnpm dev:web
```

Use the browser URL printed by Vite. The API defaults to `127.0.0.1:3088`; local source data defaults to `./data`. Keep test/development data separate from an existing deployment. Source processes read shell environment variables; `.env` is for Compose interpolation.

## Validate changes

Run the relevant focused tests while developing, then the project checks before submitting:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

The browser suite needs Playwright browsers installed:

```sh
pnpm exec playwright install --with-deps
```

Tests use isolated synthetic databases. Production serves board APIs; legacy API regression tests explicitly enable compatibility mode. Do not weaken security, reset user data, change immutable migrations, or bypass checks to make tests pass. Schema changes need forward migrations and recovery coverage.

For MCP changes:

```sh
pnpm exec vitest run apps/mcp/src apps/api/src/integration.test.ts
pnpm package:mcp
MCP_VERSION="$(node -p "require('./package.json').version")"
PORTFOLIO_MCP_ARCHIVE="$PWD/dist/release/portfolio-mcp-v$MCP_VERSION.tar.gz" pnpm test:package:mcp
```

Use [MCP.md](MCP.md) to exercise offline generation and connected review/apply behavior. No automated test should use a real network device or private user data. Backup/restore changes must use isolated synthetic data directories; see [backup and recovery behavior](BACKUP_RESTORE.md) for the operational contract.

The Docker backup matrix checks both runtime identities, complete restore, attachment bytes, and container recreation using new temporary volumes. To include the v0.4.0 upgrade path:

```sh
docker compose build
PORTFOLIO_TEST_IMAGE=ghcr.io/ryanonmars/portfolio:local PORTFOLIO_TEST_UPGRADE_IMAGE=ghcr.io/ryanonmars/portfolio:v0.4.0 pnpm exec tsx scripts/test-settings-backup-container.ts
```

## Changes and pull requests

Include a concise explanation of the problem, resulting behavior, and validation. Add screenshots for visible UI changes using synthetic content. Include appropriate tests for changed behavior, including failures and persistence where relevant. Keep generated builds, dependencies, local databases, backups, tokens, and private configuration out of commits.

Use focused Conventional Commit messages such as `fix(web): preserve port selection` or `feat(mcp): add board authoring tool`. Do not publish an image or release as part of an ordinary contribution.

## License status

No license file is currently included in this repository.
