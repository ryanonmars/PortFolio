# PortFolio MCP adapter

Local stdio MCP tools and a JSON CLI for [PortFolio](https://github.com/ryanonmars/PortFolio), a self-hosted visual network documentation designer.

## Install

Use **Node24**. Verify the release's SHA-256 checksum, extract the archive, then install its locked dependencies:

```sh
cd portfolio-mcp
npm ci --omit=dev --ignore-scripts
```

Keep this directory in a stable location. No source build is needed.

## Offline MCP setup

Configure your MCP client to launch Node24 with this absolute path:

```json
{
  "mcpServers": {
    "portfolio": {
      "command": "/absolute/path/to/node24/bin/node",
      "args": ["/absolute/path/to/portfolio-mcp/bin/portfolio-mcp.js"]
    }
  }
}
```

Adapt the configuration format for your client. No PortFolio server, API URL, token, or Keychain access is required for offline authoring.

Use `portfolio_get_import_schema`, `portfolio_generate_board_json`, and `portfolio_validate_board_json`. The agent reads documents and saves the returned archive with its own authorized file tools. PortFolio does not parse source Excel/PDF files or expose filesystem tools. Import the finished `.json` file manually in PortFolio to preview and create a new board.

## CLI

```sh
# Try the bundled synthetic proposal with a fresh output path.
node bin/portfolio-board-json.js generate --input examples/small-office.proposal.json --output example.portfolio.json
node bin/portfolio-board-json.js validate --file example.portfolio.json

node bin/portfolio-board-json.js generate --input /path/to/proposal.json --output /path/to/board.json
node bin/portfolio-board-json.js validate --file /path/to/board.json
```

Output must be a new file; generation never overwrites an existing path. Exit codes: `0` valid, `1` validation/file error, `2` argument error.

## Connected mode

For existing boards or approved direct writes, create a scoped token in PortFolio's **Settings → API Tokens**. Supply `PORTFOLIO_API_URL` and `PORTFOLIO_API_TOKEN` in the MCP client's environment. HTTPS is the default; intentional private HTTP requires both adapter `PORTFOLIO_ALLOW_PRIVATE_HTTP=true` and server `INTEGRATION_ALLOW_PRIVATE_HTTP=true`.

Validation is not write approval. Review the exact new-board preview or existing-board command batch with the user before applying changes. No live scanning or equipment control is provided.

See the [complete setup and API guide](https://github.com/ryanonmars/PortFolio/blob/v0.4.0/docs/MCP.md) and [security notes](https://github.com/ryanonmars/PortFolio/blob/v0.4.0/docs/SECURITY.md).

## License

No license file is currently included in the PortFolio repository.
