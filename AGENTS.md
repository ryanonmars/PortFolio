# AGENTS.md — Repository-wide instructions

## Active product direction — Board-first redesign

The user's complete board-first redesign brief (2026-10-28) supersedes inherited Workspace/Site, vertical-stacking, spreadsheet-first configuration, explicit field-save and networking-validation requirements below. The product is now a freeform documentation designer: standalone Boards, optional Groups, movable/resizable Device and Network containers, device-relative front/rear port slots, direct names, independent freeform network annotations, contextual autosaving inspectors, stable-ID cables, pan/zoom/snapping and bounded undo/redo. Preserve the exact approved Connector artwork, authentication, CSRF/security, SQLite recovery and private/local deployment requirements.

Production serves board APIs only. Legacy relational tables and immutable migrations remain archival recovery sources; compatibility API registration is explicitly test-only. New saves validate identity/geometry/graph integrity, not whether authored network values are conventional or have prior VLAN/subnet definitions. Read README.md and the current shared board schema before extending the editor. Local architectural notes remain in ignored docs/BOARD_REDESIGN_PLAN.md and docs/HANDOFF.md.

The redesign brief explicitly authorizes a dedicated local redesign branch and tested milestone commits. Do not push, publish images/releases, or alter remotes without a new direct instruction.

## Orchestrator and delegation

- **Requested orchestrator: Sol 6.1.** Use Sol 6.1 for planning, coordination, code review, integration and final acceptance **when available in the active Codex environment**. Do not pretend a different model is Sol 6.1. If no exact mapping/model is available, tell the user and ask which approved replacement to use rather than silently substituting.
- Delegate independent, meaningful streams to subagents for efficiency (e.g. UI components, API/schema, tests/audit). Subagents get scoped deliverables, owned files, acceptance checks and a deadline/return format; see `agents/ORCHESTRATION.md`.
- Avoid delegation overhead for tiny tasks. Orchestrator owns interfaces, migrations, integration, end-to-end quality and all merges.
- Never allow two agents to concurrently edit the same file without explicit ownership/handoff. No destructive parallel git operations.

## Source of truth and design constraints

- Read `docs/MASTER_BUILD_PROMPT.md`, `PRODUCT_SPEC.md`, `UX_SPEC.md`, `DATA_MODEL.md`, `ARCHITECTURE.md`, `TEST_PLAN.md`, `SECURITY.md`, and `DECISIONS.md` before the first implementation.
- This is **general-purpose** network documentation. The user's home router and event trailers are inspiration, **not hardcoded business logic**.
- The **site visual equipment layout is the default**. It shows stacked physical front panels; topology is optional/secondary. A **Configure** action exposes the spreadsheet-style editor.
- The user-approved RJ45 illustration is in `design-reference/approved-rj45-port-style.png`: preserve its recognizably detailed RJ45 socket, strong rounded VLAN-colored border and clear port number at every density. SCALE the same design for high port counts. Do not swap in a generic glyph on 24/48-port devices.
- Data model is the single source of truth. Front panel, port inspector, VLAN memberships, and connections all derive from stored records. No duplicate editable diagram data.
- A site need not contain racks or IP subnets to add devices. No forced inventory ceremony or cross-screen setup chain.
- Support a **routed/WAN** interface type directly: never mislabel as Access to fit a limited editor.
- No unverified live status claims: manually entered link status must be labeled "documented", and VLAN color must not imply active link state.

## Execution and quality

- Ship real, incremental, locally runnable slices. Begin with the runnable foundation before feature work.
- Required gates before each milestone completes: install, format, lint, typecheck, unit/integration tests, production build; E2E/browser tests once UI is available. Investigate failures rather than bypassing checks.
- Add/update tests with each behavior or bug fix. Cover negative cases, boundaries, persistence after restart, workspace/site isolation, import rollback, cross-device data access, and port/VLAN rules.
- Database schema changes require forward migrations and migration tests; no destructive manual DB resets to make tests green.
- Document decisions as ADR entries or `docs/DECISIONS.md` updates. Update `docs/HANDOFF.md` at each milestone.
- Build accessibility in (keyboard interaction, visible focus, contrast, labels) and responsive behavior, including 48-port horizontal scrolling/zoom without swapping icon style.

## Branding

- Application: **PortFolio**. Tagline: **Visual Network Documentation**.
- Private GitHub destination: `ryanonmars/portfolio`. Docker image: `ghcr.io/ryanonmars/portfolio`.
- Intended development directory: `~/VS_Code/PortFolio`.

## Git/commits

- Start a new local git repository if one is not already present. Default branch: `main`.
- **Conventional Commits**, small atomic commits: `chore(scaffold): ...`, `feat(api): ...`, `feat(web): ...`, `test(...): ...`, `fix(...): ...`, `docs(...): ...`, `refactor(...): ...`.
- Prepare coherent slices with passing checks. Commit only when the user explicitly requests it; do not push, create remotes, or publish images without explicit authorization.
- Do not commit `.env`, local databases, backups, node_modules, generated build output, user network details or tokens. Never force-push or rewrite shared history. Do not add a public license or change visibility without user instruction.
- Respect unrelated changes and avoid blanket `git add .` where untracked files might contain secrets. Report SHA + tests when handing off.
- **GitHub repo must be private.** Creation/push timing and auth checks follow `docs/GITHUB_POLICY.md`.

## Safety and scope

- Offline/manual documentation only in MVP. No scanning, SNMP, SSH, API writeback, router configuration changes or unrequested outbound connections.
- Passwords are hashed (Argon2id or a justified equivalent). Use secure, HttpOnly, SameSite session cookies, CSRF protections, origin checks, input validation, rate limiting, and no default credentials.
- Scope every API query and mutation to authorized workspace/site IDs; prevent cross-site references.
- Use persistent bind-mounted `/data` and tested SQLite backup/restore. Never silently overwrite existing imported data.
- Prefer simple, understandable code. No large framework/plugin ecosystem, global wizard, forced racks, fake green tests, or speculative extra features.

## Reporting

- State what was built, what was tested (exact commands/results), what remains, blocked decisions, commit SHA, and whether anything was pushed.
- If an assumption is needed, use product-preserving defaults, record them and proceed; ask only for decisions that materially block implementation or could cause destructive consequences.
