import { z } from 'zod';
import {
  boardDocumentSchema,
  boardPortSchema,
  minimumBoardDeviceSize,
  normalizeNetworkDocument,
  type BoardDocument,
  type BoardElement,
  type JsonValue,
} from './board.js';
import {
  proposalDeviceSchema,
  proposalNetworkSchema,
  proposalNetworkEntrySchema,
  proposalPortSchema,
  proposalConnectionSchema,
  proposalAnnotationSchema,
  validateBoardProposal,
} from './integration.js';

const id = z.string().min(1).max(100);
const text = z.string().max(10000);
const color = z.union([z.literal(''), z.string().regex(/^#[a-f\d]{6}$/i)]);
const devicePatch = z
  .object({
    name: z.string().max(240).optional(),
    manufacturer: text.optional(),
    model: text.optional(),
    managementAddress: text.optional(),
    deviceType: text.optional(),
    notes: text.optional(),
    color: color.optional(),
  })
  .strict();
const portPatch = boardPortSchema
  .omit({ id: true, deviceId: true })
  .partial()
  .strict();
export const integrationCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('update_board'),
      name: z.string().trim().min(1).max(240),
    })
    .strict(),
  z
    .object({
      operation: z.literal('create_device'),
      device: proposalDeviceSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('update_device'),
      deviceId: id,
      patch: devicePatch,
    })
    .strict(),
  z
    .object({
      operation: z.literal('create_port'),
      deviceId: id,
      port: proposalPortSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('update_port'),
      deviceId: id,
      portId: id,
      patch: portPatch,
    })
    .strict(),
  z
    .object({
      operation: z.literal('create_network'),
      network: proposalNetworkSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('add_network_entry'),
      elementId: id,
      entry: proposalNetworkEntrySchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('update_network'),
      elementId: id,
      entryId: id,
      patch: proposalNetworkEntrySchema
        .omit({ networkEntryId: true })
        .partial()
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('connect_ports'),
      connection: proposalConnectionSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('create_annotation'),
      annotation: proposalAnnotationSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('update_layout'),
      elements: z
        .array(
          z
            .object({
              id,
              x: z.number().finite().min(-100000).max(100000).optional(),
              y: z.number().finite().min(-100000).max(100000).optional(),
              width: z.number().finite().min(16).max(20000).optional(),
              height: z.number().finite().min(16).max(20000).optional(),
              z: z.number().int().min(0).max(100000).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(256),
    })
    .strict(),
]);
export type IntegrationCommand = z.input<typeof integrationCommandSchema>;
export const integrationEditSchema = z
  .object({
    rowVersion: z.number().int().positive(),
    commands: z.array(integrationCommandSchema).min(1).max(128),
  })
  .strict();

/** All edits are applied to a copy and the complete canonical graph is validated. */
export function applyIntegrationCommands(
  source: BoardDocument,
  input: unknown,
): BoardDocument {
  const commands = z
    .array(integrationCommandSchema)
    .min(1)
    .max(128)
    .parse(input);
  let document = structuredClone(normalizeNetworkDocument(source));
  const find = (elementId: string, type?: BoardElement['type']) => {
    const element = document.elements.find(
      (e) => e.id === elementId && (!type || e.type === type),
    );
    if (!element)
      throw new Error('The referenced object does not exist on this board');
    return element;
  };
  function append(proposal: unknown, positioned: { x?: number; y?: number }) {
    const result = validateBoardProposal(proposal);
    if (!result.valid || !result.document)
      throw new Error(result.errors.map((e) => e.message).join('; '));
    const elements = result.document.elements;
    for (const element of elements) {
      if (
        positioned.x === undefined &&
        positioned.y === undefined &&
        document.elements.length
      ) {
        element.x =
          Math.max(...document.elements.map((e) => e.x + e.width)) + 100;
        element.y = Math.min(...document.elements.map((e) => e.y));
      }
      if (
        (positioned.x === undefined || positioned.y === undefined) &&
        document.elements.length
      ) {
        for (
          let attempts = 0;
          attempts <= document.elements.length;
          attempts++
        ) {
          const collision = document.elements.find(
            (e) =>
              element.x < e.x + e.width &&
              e.x < element.x + element.width &&
              element.y < e.y + e.height &&
              e.y < element.y + element.height,
          );
          if (!collision) break;
          if (positioned.x !== undefined)
            element.y = collision.y + collision.height + 100;
          else element.x = collision.x + collision.width + 100;
        }
      }
      element.z = Math.min(
        100000,
        Math.max(-1, ...document.elements.map((e) => e.z)) + 1,
      );
    }
    document = {
      ...document,
      elements: [...document.elements, ...elements],
      ports: [...document.ports, ...result.document.ports],
      cables: [...document.cables, ...result.document.cables],
    };
  }
  for (const command of commands) {
    switch (command.operation) {
      case 'update_board':
        break; // Metadata is committed by the same board service transaction.
      case 'create_device':
        append({ name: 'Edit', devices: [command.device] }, command.device);
        break;
      case 'create_network':
        append({ name: 'Edit', networks: [command.network] }, command.network);
        break;
      case 'create_annotation':
        append(
          { name: 'Edit', annotations: [command.annotation] },
          command.annotation,
        );
        break;
      case 'update_device': {
        const element = find(command.deviceId, 'device');
        const { name, color, ...properties } = command.patch;
        if (name !== undefined) element.name = name;
        if (color !== undefined) element.color = color;
        Object.assign(element.properties, properties);
        break;
      }
      case 'create_port': {
        const element = find(command.deviceId, 'device');
        const port = { ...command.port };
        if (port.row === undefined || port.column === undefined) {
          const taken = new Set(
            document.ports
              .filter(
                (p) =>
                  p.deviceId === element.id &&
                  p.face === (port.face ?? 'front'),
              )
              .map((p) => `${p.row}:${p.column}`),
          );
          for (let slot = 0; slot < 4096; slot++) {
            const row =
              port.row ??
              (port.column !== undefined ? slot : Math.floor(slot / 8));
            const column =
              port.column ?? (port.row !== undefined ? slot : slot % 8);
            if (!taken.has(`${row}:${column}`)) {
              port.row = row;
              port.column = column;
              break;
            }
          }
        }
        const result = validateBoardProposal({
          name: 'Port',
          devices: [{ id: element.id, name: element.name, ports: [port] }],
        });
        if (!result.valid || !result.document)
          throw new Error('Invalid port configuration');
        document.ports.push(...result.document.ports);
        const minimum = minimumBoardDeviceSize(element, document.ports);
        element.width = Math.max(element.width, minimum.width);
        element.height = Math.max(element.height, minimum.height);
        break;
      }
      case 'update_port': {
        const element = find(command.deviceId, 'device');
        const port = document.ports.find(
          (p) => p.id === command.portId && p.deviceId === command.deviceId,
        );
        if (!port)
          throw new Error('The referenced port does not belong to this device');
        Object.assign(port, command.patch);
        const minimum = minimumBoardDeviceSize(element, document.ports);
        element.width = Math.max(element.width, minimum.width);
        element.height = Math.max(element.height, minimum.height);
        break;
      }
      case 'add_network_entry':
      case 'update_network': {
        const element = find(command.elementId, 'network');
        const entries = element.properties.entries;
        if (!Array.isArray(entries))
          throw new Error('Network container has no supported entries');
        if (command.operation === 'add_network_entry')
          entries.push({ ...command.entry });
        else {
          const entry = entries.find(
            (e) =>
              e &&
              typeof e === 'object' &&
              !Array.isArray(e) &&
              e.networkEntryId === command.entryId,
          );
          if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            throw new Error(
              'The referenced network does not belong to this container',
            );
          Object.assign(entry, command.patch);
        }
        break;
      }
      case 'connect_ports': {
        // Cable defaults mirror proposal conversion; references are checked on the final graph.
        document.cables.push({
          name: '',
          cableType: '',
          sourceConnector: '',
          targetConnector: '',
          color: '',
          length: '',
          notes: '',
          ...command.connection,
        });
        break;
      }
      case 'update_layout':
        if (
          new Set(command.elements.map((e) => e.id)).size !==
          command.elements.length
        )
          throw new Error('Duplicate layout object ID');
        for (const patch of command.elements)
          Object.assign(find(patch.id), patch);
        break;
    }
  }
  const networkIds = new Set<JsonValue>();
  for (const element of document.elements.filter((e) => e.type === 'network')) {
    const entries = element.properties.entries;
    if (!Array.isArray(entries)) continue;
    const ids = entries
      .map((e) =>
        e && typeof e === 'object' && !Array.isArray(e)
          ? (e as Record<string, JsonValue>).networkEntryId
          : undefined,
      )
      .filter(Boolean);
    for (const id of ids) {
      if (networkIds.has(id!)) throw new Error('Duplicate network entry ID');
      networkIds.add(id!);
    }
  }
  return boardDocumentSchema.parse(document);
}
