import { z } from 'zod';
import {
  boardImportSchema,
  type BoardDocument,
  type JsonValue,
} from './board.js';
import {
  boardProposalSchema,
  networkWarnings,
  validateBoardProposal,
  type BoardProposalValidation,
} from './integration.js';

/** Matches the ordinary browser file picker and board import route. */
export const BOARD_JSON_MAX_BYTES = 8 * 1024 * 1024;
export type BoardArchive = z.infer<typeof boardImportSchema>;
export interface BoardJsonValidation {
  valid: boolean;
  errors: { path: string; message: string }[];
  warnings: string[];
  summary: BoardProposalValidation['summary'];
  unresolvedConnections: string[];
  archive?: BoardArchive;
}
const emptyResult = (): BoardJsonValidation => ({
  valid: false,
  errors: [],
  warnings: [],
  summary: {
    devices: 0,
    networks: 0,
    ports: 0,
    cables: 0,
    annotations: 0,
    unresolvedConnections: 0,
  },
  unresolvedConnections: [],
});
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** Check complexity before Zod's recursive property schema or JSON serialization. */
function boundedJson(value: unknown): string | undefined {
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  let textBytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++visited > 200000 || item.depth > 32)
      return 'The document exceeds the supported nesting or value count (32 levels, 200000 values).';
    if (typeof item.value === 'string') {
      if (item.value.length > BOARD_JSON_MAX_BYTES)
        return 'Board JSON exceeds the 8 MiB import limit.';
      textBytes += bytes(item.value);
      if (textBytes > BOARD_JSON_MAX_BYTES)
        return 'Board JSON exceeds the 8 MiB import limit.';
    }
    if (typeof item.value === 'number' && !Number.isFinite(item.value))
      return 'JSON numbers must be finite.';
    if (
      item.value === null ||
      ['string', 'number', 'boolean'].includes(typeof item.value)
    )
      continue;
    if (!item.value || typeof item.value !== 'object')
      return 'Only JSON objects, arrays, strings, finite numbers, booleans and null are supported.';
    if (!Array.isArray(item.value)) {
      for (const key of Object.keys(item.value)) {
        if (key.length > BOARD_JSON_MAX_BYTES)
          return 'Board JSON exceeds the 8 MiB import limit.';
        textBytes += bytes(key);
        if (textBytes > BOARD_JSON_MAX_BYTES)
          return 'Board JSON exceeds the 8 MiB import limit.';
      }
    }
    const children = Object.values(item.value);
    if (pending.length + children.length + visited > 200000)
      return 'The document exceeds the supported nesting or value count (32 levels, 200000 values).';
    for (const child of children)
      pending.push({ value: child, depth: item.depth + 1 });
  }
  return undefined;
}
const string = (record: Record<string, JsonValue>, key: string) =>
  typeof record[key] === 'string' ? (record[key] as string) : '';
const networkEntries = (document: BoardDocument) =>
  document.elements
    .filter((e) => e.type === 'network')
    .flatMap((e) =>
      Array.isArray(e.properties.entries) ? e.properties.entries : [],
    )
    .filter(
      (entry): entry is Record<string, JsonValue> =>
        !!entry && typeof entry === 'object' && !Array.isArray(entry),
    );

/** Warnings describe gaps; no authored value is changed or made mandatory. */
function documentationWarnings(document: BoardDocument): string[] {
  const warnings: string[] = [];
  for (const device of document.elements.filter((e) => e.type === 'device')) {
    if (!string(device.properties, 'managementAddress'))
      warnings.push(
        `Device ${device.id}: management address is not documented.`,
      );
    if (!string(device.properties, 'model'))
      warnings.push(`Device ${device.id}: model is not documented.`);
  }
  for (const entry of networkEntries(document)) {
    const context = `Network entry ${string(entry, 'networkEntryId') || '(legacy entry)'}`;
    if (!string(entry, 'subnet') && !string(entry, 'cidr'))
      warnings.push(`${context}: subnet is not documented.`);
    const subnet = string(entry, 'subnet') || string(entry, 'cidr');
    if (subnet && !subnet.includes('/'))
      warnings.push(
        `${context}: CIDR prefix is not documented; no subnet size was assumed.`,
      );
    if (!string(entry, 'gateway'))
      warnings.push(`${context}: gateway is not documented.`);
    if (
      entry.dhcpServer === true &&
      (!string(entry, 'dhcpStart') || !string(entry, 'dhcpEnd'))
    )
      warnings.push(
        `${context}: DHCP is enabled but its complete pool is not documented.`,
      );
    if (
      string(entry, 'subnet') &&
      string(entry, 'cidr') &&
      entry.subnet !== entry.cidr
    )
      warnings.push(
        `${context}: subnet and legacy CIDR values conflict; both are preserved.`,
      );
    warnings.push(
      ...networkWarnings({
        networkEntryId: string(entry, 'networkEntryId') || '(legacy entry)',
        subnet: string(entry, 'subnet'),
        cidr: string(entry, 'cidr'),
        gateway: string(entry, 'gateway'),
        dhcpStart: string(entry, 'dhcpStart'),
        dhcpEnd: string(entry, 'dhcpEnd'),
      }),
    );
  }
  return warnings;
}

/** Validate the same one-board envelope used by Import JSON, without any I/O. */
export function validateBoardJson(input: unknown): BoardJsonValidation {
  const result = emptyResult();
  const fail = (message: string) => {
    result.errors.push({ path: '', message });
    return result;
  };
  if (typeof input === 'string') {
    if (bytes(input) > BOARD_JSON_MAX_BYTES)
      return fail('Board JSON exceeds the 8 MiB import limit.');
    try {
      input = JSON.parse(input);
    } catch {
      return fail(
        'Invalid JSON. Supply the complete PortFolio JSON file contents or a parsed board archive.',
      );
    }
  }
  const issue = boundedJson(input);
  if (issue) return fail(issue);
  if (bytes(JSON.stringify(input)) > BOARD_JSON_MAX_BYTES)
    return fail('Board JSON exceeds the 8 MiB import limit.');
  const parsed = boardImportSchema.safeParse(input);
  if (!parsed.success) {
    result.errors = parsed.error.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    return result;
  }
  const archive = parsed.data;
  const document = archive.document;
  result.summary = {
    devices: document.elements.filter((e) => e.type === 'device').length,
    networks: networkEntries(document).length,
    ports: document.ports.length,
    cables: document.cables.length,
    annotations: document.elements.filter((e) =>
      ['text', 'arrow', 'rectangle', 'highlight'].includes(e.type),
    ).length,
    unresolvedConnections: 0,
  };
  // Generated unresolved notes are regular editable annotations, never cable guesses.
  for (const element of document.elements) {
    if (
      element.type === 'text' &&
      typeof element.properties.text === 'string' &&
      element.properties.text.startsWith('Unresolved connections\n')
    )
      result.unresolvedConnections.push(
        ...element.properties.text
          .split('\n')
          .slice(1)
          .filter((line) => line.startsWith('• '))
          .map((line) => line.slice(2)),
      );
  }
  result.summary.unresolvedConnections = result.unresolvedConnections.length;
  result.warnings = documentationWarnings(document);
  if (result.unresolvedConnections.length)
    result.warnings.push(
      `${result.unresolvedConnections.length} unresolved connection(s) are preserved as notes; no cable endpoints were invented.`,
    );
  result.valid = true;
  result.archive = archive;
  return result;
}

/** Shared online proposal builder -> ordinary export envelope. No live apply. */
export function generateBoardJson(proposal: unknown): BoardJsonValidation {
  const issue = boundedJson(proposal);
  if (issue) {
    const invalid = emptyResult();
    invalid.errors.push({ path: '', message: issue });
    return invalid;
  }
  const preview = validateBoardProposal(proposal);
  const result: BoardJsonValidation = {
    valid: false,
    errors: preview.errors,
    warnings: preview.warnings,
    summary: preview.summary,
    unresolvedConnections: preview.unresolvedConnections,
  };
  if (!preview.valid || !preview.document) return result;
  const checked = validateBoardJson({
    format: 'portfolio-board',
    schemaVersion: 1,
    name: preview.name,
    document: preview.document,
  });
  result.errors = checked.errors;
  result.warnings = [...new Set([...preview.warnings, ...checked.warnings])];
  if (!checked.valid || !checked.archive) return result;
  // Agents and the CLI write readable JSON; enforce that file's actual UTF-8 size.
  if (bytes(JSON.stringify(checked.archive, null, 2)) > BOARD_JSON_MAX_BYTES) {
    result.errors.push({
      path: '',
      message:
        'Formatted board JSON exceeds the 8 MiB import limit; split the documentation into smaller boards.',
    });
    return result;
  }
  result.valid = true;
  result.archive = checked.archive;
  return result;
}

/** JSON Schema describes structure; runtime validation also checks graph/geometry. */
export function getBoardImportSchema() {
  return {
    format: 'portfolio-board',
    schemaVersion: 1,
    proposalSchema: z.toJSONSchema(boardProposalSchema, { io: 'input' }),
    importSchema: z.toJSONSchema(boardImportSchema, { io: 'input' }),
    limits: {
      maxFileBytes: BOARD_JSON_MAX_BYTES,
      elements: 256,
      ports: 4096,
      portsPerDevice: 512,
      cables: 2048,
      maxDepth: 32,
      maxValues: 200000,
    },
    instructions:
      'Use portfolio_generate_board_json with the simpler proposal. Save only the returned archive as UTF-8 JSON. Validate the exact saved file. Runtime validation additionally checks unique object IDs, device ownership, occupied slots, device geometry and cable endpoints. The user imports through Import JSON; this tool never imports or accesses live data. Attachments are not portable in board JSON.',
  };
}
