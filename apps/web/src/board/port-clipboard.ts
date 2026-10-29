import { z } from 'zod';
import {
  boardPortSchema,
  type BoardDocument,
  type BoardPort,
  type JsonValue,
} from '../../../../packages/shared/src/board.js';

export const portSettingKeys = [
  'kind',
  'role',
  'speed',
  'linkState',
  'nativeVlan',
  'taggedVlans',
  'pvid',
  'address',
  'externalDestination',
  'color',
  'notes',
  'customFields',
] as const;
export type PortSettingKey = (typeof portSettingKeys)[number];
type ScalarSettingKey = Exclude<PortSettingKey, 'customFields'>;
type FieldClipboard = {
  [Key in ScalarSettingKey]: {
    version: 1;
    type: 'port-field';
    field: Key;
    value: BoardPort[Key];
  };
}[ScalarSettingKey];
export type PortClipboard =
  | {
      version: 1;
      type: 'port-settings';
      settings: Pick<BoardPort, PortSettingKey>;
    }
  | FieldClipboard
  | {
      version: 1;
      type: 'port-field';
      field: 'customFields';
      key: string;
      value: JsonValue;
    };

const settingsSchema = boardPortSchema.pick({
  kind: true,
  role: true,
  speed: true,
  linkState: true,
  nativeVlan: true,
  taggedVlans: true,
  pvid: true,
  address: true,
  externalDestination: true,
  color: true,
  notes: true,
  customFields: true,
});
const scalarFields = portSettingKeys
  .filter((key): key is ScalarSettingKey => key !== 'customFields')
  .map((key) =>
    z
      .object({
        version: z.literal(1),
        type: z.literal('port-field'),
        field: z.literal(key),
        value: boardPortSchema.shape[key],
      })
      .strict(),
  );
const payloadSchema = z.union([
  z
    .object({
      version: z.literal(1),
      type: z.literal('port-settings'),
      settings: settingsSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal('port-field'),
      field: z.literal('customFields'),
      key: boardPortSchema.shape.customFields.keyType.refine(
        (key) => key !== '__proto__',
        'This custom field key is unsupported.',
      ),
      value: boardPortSchema.shape.customFields.valueType,
    })
    .strict(),
  ...scalarFields,
]);

// Zod's record parser intentionally omits __proto__. Reject it beforehand so
// the clipboard never reports success while silently losing authored data.
function safeClipboardTree(value: unknown): boolean {
  const pending: { value: unknown; exit?: boolean }[] = [{ value }];
  const ancestors = new Set<object>();
  while (pending.length) {
    const item = pending.pop()!;
    if (item.value === null || typeof item.value !== 'object') continue;
    const object = item.value;
    if (item.exit) {
      ancestors.delete(object);
      continue;
    }
    const prototype = Object.getPrototypeOf(object);
    if (
      (!Array.isArray(object) &&
        prototype !== Object.prototype &&
        prototype !== null) ||
      ancestors.has(object) ||
      Reflect.ownKeys(object).some(
        (key) => key === '__proto__' || typeof key === 'symbol',
      )
    )
      return false;
    ancestors.add(object);
    pending.push({ value: object, exit: true });
    for (const entry of Object.values(object)) pending.push({ value: entry });
  }
  return true;
}

export const portClipboardSchema: z.ZodType<PortClipboard> = z.preprocess(
  (value, context) => {
    if (!safeClipboardTree(value))
      context.addIssue({
        code: 'custom',
        message:
          'Clipboard settings must contain plain JSON data without reserved keys.',
      });
    return value;
  },
  payloadSchema,
) as z.ZodType<PortClipboard>;

export function copyPortSettings(port: BoardPort): PortClipboard {
  return structuredClone(
    portClipboardSchema.parse({
      version: 1,
      type: 'port-settings',
      settings: Object.fromEntries(
        portSettingKeys.map((key) => [key, port[key]]),
      ),
    }),
  );
}

export function copyPortField(
  port: BoardPort,
  field: PortSettingKey,
  customKey?: string,
): PortClipboard {
  if (field === 'customFields') {
    if (customKey === undefined || !Object.hasOwn(port.customFields, customKey))
      throw new Error('Choose an existing custom field to copy.');
    return structuredClone(
      portClipboardSchema.parse({
        version: 1,
        type: 'port-field',
        field,
        key: customKey,
        value: port.customFields[customKey],
      }),
    );
  }
  if (customKey !== undefined)
    throw new Error('Choose a supported port field.');
  return structuredClone(
    portClipboardSchema.parse({
      version: 1,
      type: 'port-field',
      field,
      value: port[field],
    }),
  );
}

export function pastePortSettings(
  document: BoardDocument,
  payload: unknown,
  ids: string[],
): BoardDocument {
  const clipboard = portClipboardSchema.parse(payload);
  if (!Array.isArray(ids) || !ids.length)
    throw new Error('Select one or more destination ports.');
  const targets = new Set(ids);
  const available = new Set(document.ports.map((port) => port.id));
  if ([...targets].some((id) => !available.has(id)))
    throw new Error(
      'Some selected ports are no longer available. Select them again.',
    );
  return {
    ...document,
    ports: document.ports.map((port) => {
      if (!targets.has(port.id)) return port;
      if (clipboard.type === 'port-settings')
        return { ...port, ...structuredClone(clipboard.settings) };
      if (clipboard.field === 'customFields')
        return {
          ...port,
          customFields: {
            ...port.customFields,
            [clipboard.key]: structuredClone(clipboard.value),
          },
        };
      return { ...port, [clipboard.field]: structuredClone(clipboard.value) };
    }),
  };
}

const labels: Record<PortSettingKey, string> = {
  kind: 'Connector type',
  role: 'Port Purpose',
  speed: 'Speed',
  linkState: 'Link Status',
  nativeVlan: 'Native VLAN',
  taggedVlans: 'Tagged VLANs',
  pvid: 'PVID',
  address: 'Interface IP / Address',
  externalDestination: 'External Connection',
  color: 'Port color',
  notes: 'Port notes',
  customFields: 'Custom fields',
};
export function portClipboardLabel(payload: PortClipboard): string {
  if (payload.type === 'port-settings') return 'Port settings';
  return payload.field === 'customFields' ? payload.key : labels[payload.field];
}

/** Range selection follows logical creation order on one device face. */
export function portSelectionRange(
  document: BoardDocument,
  anchorId: string,
  targetId: string,
): string[] {
  const anchor = document.ports.find((port) => port.id === anchorId);
  const target = document.ports.find((port) => port.id === targetId);
  if (
    !anchor ||
    !target ||
    anchor.deviceId !== target.deviceId ||
    anchor.face !== target.face
  )
    return [];
  const ports = document.ports.filter(
    (port) => port.deviceId === anchor.deviceId && port.face === anchor.face,
  );
  const first = ports.findIndex((port) => port.id === anchorId);
  const last = ports.findIndex((port) => port.id === targetId);
  return ports
    .slice(Math.min(first, last), Math.max(first, last) + 1)
    .map((port) => port.id);
}
