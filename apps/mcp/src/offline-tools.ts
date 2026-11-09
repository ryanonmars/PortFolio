import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  generateBoardJson,
  getBoardImportSchema,
  validateBoardJson,
} from '../../../packages/shared/src/board-json.js';

const offline = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
function jsonResult(value: object) {
  const structuredContent = value as Record<string, unknown>;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}
/** Pure offline authoring: no API client, storage, or filesystem access. */
export function registerOfflineTools(server: McpServer) {
  server.registerTool(
    'portfolio_generate_board_json',
    {
      description:
        'Recommended offline workflow: generate a validated portfolio-board import archive from a structured proposal. Returns errors, warnings, summary, unresolvedConnections and an archive only when valid. No API, token or saved board. Save the archive itself as a real .json file using your own authorized file/artifact capabilities; the user manually imports it into PortFolio.',
      // Keep recursive metadata opaque here: the shared builder bounds depth and
      // value count before running the canonical proposal schema.
      inputSchema: z
        .object({
          proposal: z
            .unknown()
            .describe(
              'Structured proposal: name, optional devices with ports, networks with entries, connections by port ID, annotations and unresolvedConnections. Call portfolio_get_import_schema for the complete proposalSchema.',
            ),
        })
        .strict(),
      annotations: offline,
    },
    ({ proposal }) => jsonResult(generateBoardJson(proposal)),
  );
  server.registerTool(
    'portfolio_validate_board_json',
    {
      description:
        'Validate a portfolio-board import archive entirely offline. Accepts a parsed JSON object or JSON string. Returns errors, warnings, summary and the archive only when valid; never saves or imports it. No token required.',
      inputSchema: z
        .object({
          json: z
            .unknown()
            .describe(
              'A parsed portfolio-board archive object or its JSON string',
            ),
        })
        .strict(),
      annotations: offline,
    },
    ({ json }) => jsonResult(validateBoardJson(json)),
  );
  server.registerTool(
    'portfolio_get_import_schema',
    {
      description:
        'Read the canonical board proposal and import archive JSON schemas and limits offline. Use these schemas to author editable PortFolio boards. No API configuration or token required.',
      inputSchema: z.object({}).strict(),
      annotations: offline,
    },
    () => jsonResult(getBoardImportSchema()),
  );
}
