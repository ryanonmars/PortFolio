import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { boardProposalSchema } from '../../../packages/shared/src/integration.js';
import { integrationEditSchema } from '../../../packages/shared/src/integration-commands.js';
import { PortfolioClient } from './http-client.js';
import { authoringGuide } from './guide.js';
import { registerOfflineTools } from './offline-tools.js';

const id = z
  .string()
  .min(1)
  .max(100)
  .describe('Stored stable ID, obtained from PortFolio; never a display name');
const segment = (value: string) => encodeURIComponent(value);
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
export function createMcpServer(client?: PortfolioClient) {
  const server = new McpServer(
    { name: 'portfolio', version: '0.4.1' },
    { instructions: authoringGuide },
  );
  registerOfflineTools(server);
  async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
    try {
      if (!client)
        throw new Error(
          'Online tools require valid PORTFOLIO_API_URL and PORTFOLIO_API_TOKEN configuration. Check HTTPS/private HTTP and timeout settings, then restart the MCP server. Offline generate, validate and schema tools need no API configuration or token.',
        );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(await client.request(method, path, body)),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text:
              error instanceof Error
                ? error.message
                : 'PortFolio request failed',
          },
        ],
      };
    }
  }
  server.registerTool(
    'portfolio_list_boards',
    {
      description: 'List boards and optional groups visible to this token.',
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    () => call('GET', '/boards'),
  );
  server.registerTool(
    'portfolio_get_board',
    {
      description:
        'Read the complete board document and rowVersion before editing.',
      inputSchema: z.object({ boardId: id }).strict(),
      annotations: readOnly,
    },
    ({ boardId }) => call('GET', `/boards/${segment(boardId)}`),
  );
  server.registerTool(
    'portfolio_list_devices',
    {
      description: 'List device containers on a board.',
      inputSchema: z.object({ boardId: id }).strict(),
      annotations: readOnly,
    },
    ({ boardId }) => call('GET', `/boards/${segment(boardId)}/devices`),
  );
  server.registerTool(
    'portfolio_get_device',
    {
      description:
        'Read a device, its front/rear ports and cables, preserving stored stable IDs.',
      inputSchema: z.object({ boardId: id, deviceId: id }).strict(),
      annotations: readOnly,
    },
    ({ boardId, deviceId }) =>
      call('GET', `/boards/${segment(boardId)}/devices/${segment(deviceId)}`),
  );
  server.registerTool(
    'portfolio_list_networks',
    {
      description: 'Read independent authored network annotations on a board.',
      inputSchema: z.object({ boardId: id }).strict(),
      annotations: readOnly,
    },
    ({ boardId }) => call('GET', `/boards/${segment(boardId)}/networks`),
  );
  server.registerTool(
    'portfolio_get_network',
    {
      description:
        'Read a network annotation row by container and stable entry ID.',
      inputSchema: z
        .object({ boardId: id, elementId: id, entryId: id })
        .strict(),
      annotations: readOnly,
    },
    ({ boardId, elementId, entryId }) =>
      call(
        'GET',
        `/boards/${segment(boardId)}/networks/${segment(elementId)}/${segment(entryId)}`,
      ),
  );
  server.registerTool(
    'portfolio_list_connections',
    {
      description: 'Read documented cables and their stable port endpoints.',
      inputSchema: z.object({ boardId: id }).strict(),
      annotations: readOnly,
    },
    ({ boardId }) => call('GET', `/boards/${segment(boardId)}/connections`),
  );
  server.registerTool(
    'portfolio_get_layout',
    {
      description: 'Read board element geometry and viewport.',
      inputSchema: z.object({ boardId: id }).strict(),
      annotations: readOnly,
    },
    ({ boardId }) => call('GET', `/boards/${segment(boardId)}/layout`),
  );
  server.registerTool(
    'portfolio_validate_proposal',
    {
      description:
        'Validate a new board proposal without saving a board. Returns errors, warnings, summary, normalized preview document and an expiring proposalId/digest when valid. Show these to the user; validation is never approval to apply.',
      inputSchema: z.object({ proposal: boardProposalSchema }).strict(),
      annotations: write,
    },
    ({ proposal }) => call('POST', '/proposals/validate', { proposal }),
  );
  server.registerTool(
    'portfolio_apply_proposal',
    {
      description:
        'Create a board from the exact validated proposal ONLY after explicit user approval of its preview/summary. Validation cannot authorize this call. Pass its proposalId/digest, approved:true and a unique idempotencyKey. Reuse that key only for the identical approved operation after an uncertain response.',
      inputSchema: z
        .object({
          proposalId: id,
          digest: z.string().regex(/^[a-f0-9]{64}$/),
          idempotencyKey: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[\w.-]+$/),
          approved: z.literal(true),
        })
        .strict(),
      annotations: { ...write, idempotentHint: true },
    },
    ({ proposalId, ...body }) =>
      call('POST', `/proposals/${segment(proposalId)}/apply`, body),
  );
  server.registerTool(
    'portfolio_edit_board',
    {
      description:
        'Apply one reviewed atomic command batch to an existing board, after explicit user approval. Read the current rowVersion first. Supports board/device/port/network/annotation creation or updates, stable-ID cables and layout. On a version conflict reread and review instead of blindly retrying.',
      inputSchema: integrationEditSchema
        .extend({ boardId: id, approved: z.literal(true) })
        .strict(),
      annotations: write,
    },
    ({ boardId, approved: _approved, ...body }) =>
      call('POST', `/boards/${segment(boardId)}/commands`, body),
  );
  server.registerResource(
    'portfolio-authoring-guide',
    'portfolio://guide',
    {
      description:
        'Board-first authoring model, uncertainty handling and required explicit apply approval',
      mimeType: 'text/plain',
    },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'text/plain', text: authoringGuide },
      ],
    }),
  );
  server.registerPrompt(
    'portfolio-author-board',
    {
      description:
        'Guide structured board proposals and reviewed edits without invented facts',
    },
    () => ({
      messages: [
        { role: 'user', content: { type: 'text', text: authoringGuide } },
      ],
    }),
  );
  return server;
}
