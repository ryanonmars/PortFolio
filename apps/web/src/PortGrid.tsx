import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  portRecordSchema,
  createPortSchema,
  generatePortsSchema,
  createVlanSchema,
  type DeviceTemplate,
  type Device,
  type Port,
  type Vlan,
  type PortField,
  type PortCustomValues,
  type CustomValue,
  type Connection,
  type BulkPortEdit,
} from '../../../packages/shared/src/index.js';
import { api, ApiError } from './api.js';
import { CustomFields, CustomInput } from './grid/CustomFields.js';
import {
  columnsFromPreferences,
  portPage,
  portTargetPage,
  parsePortPaste,
  portTSV,
  rowErrors,
  pasteHeaders,
  type ColumnPreference,
} from './grid/helpers.js';
import { compactCellText, parseCellMatrix } from './grid/compact.js';
import './grid/grid.css';

export interface PortGridProps {
  siteId: string;
  userId: string;
  device: Device;
  devices: Device[];
  vlans: Vlan[];
  onVlansChange: (vlans: Vlan[]) => void;
  onDeviceChange: (device: Device) => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved?: () => void;
  onBusyChange?: (busy: boolean) => void;
  focusPortId?: string;
}
type Snapshot = {
  ports: Port[];
  peers: Port[];
  fields: PortField[];
  customValues: PortCustomValues;
  connections: Connection[];
  device: Device;
};
type Draft = { port: Port; customValues: Record<string, CustomValue> };
const labels: Record<string, string> = {
  name: 'Port',
  kind: 'Interface type',
  speed: 'Speed',
  mode: 'Mode',
  nativeVlanRef: 'Native/Untagged VLAN',
  pvid: 'PVID',
  taggedVlanRefs: 'Tagged VLANs',
  connectedTo: 'Connected to',
  documentedLinkState: 'Documented link state',
  externalDestinationLabel: 'External destination',
  description: 'Description/Notes',
  face: 'Face',
  orderIndex: 'Order',
};
const modes: [Port['mode'], string][] = [
  ['access', 'Access'],
  ['trunk', 'Trunk'],
  ['routed', 'Routed/WAN'],
  ['disabled', 'Disabled'],
  ['other', 'Other'],
];
const kinds: [Port['kind'], string][] = [
  ['rj45', 'RJ45'],
  ['sfp', 'SFP'],
  ['sfp_plus', 'SFP+'],
  ['qsfp', 'QSFP'],
  ['other', 'Other'],
];
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : 'The request could not be completed.';

async function fetchSnapshot(
  siteId: string,
  deviceId: string,
  devices: Device[],
): Promise<Snapshot> {
  const [ports, fields, custom, cables, current] = await Promise.all([
    api<{ ports: Port[] }>(`/sites/${siteId}/devices/${deviceId}/ports`),
    api<{ fields: PortField[] }>(`/sites/${siteId}/port-fields`),
    api<{ customValues: PortCustomValues }>(
      `/sites/${siteId}/devices/${deviceId}/port-values`,
    ),
    api<{ connections: Connection[] }>(`/sites/${siteId}/connections`),
    api<{ device: Device }>(`/sites/${siteId}/devices/${deviceId}`),
  ]);
  const otherPorts = await Promise.all(
    devices
      .filter((item) => item.id !== deviceId)
      .map((item) =>
        api<{ ports: Port[] }>(`/sites/${siteId}/devices/${item.id}/ports`),
      ),
  );
  return {
    ports: ports.ports,
    peers: [...ports.ports, ...otherPorts.flatMap((result) => result.ports)],
    fields: fields.fields,
    customValues: custom.customValues,
    connections: cables.connections,
    device: current.device,
  };
}

export function PortGrid({
  siteId,
  userId,
  device,
  devices,
  vlans,
  onVlansChange,
  onDeviceChange,
  onDirtyChange,
  onSaved,
  onBusyChange,
  focusPortId,
}: PortGridProps) {
  const [inspectedId, setInspectedId] = useState<string | null>(
    focusPortId ?? null,
  );
  const [editingCell, setEditingCell] = useState<{
    portId: string;
    column: string;
  } | null>(null);
  const [templates, setTemplates] = useState<DeviceTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  useEffect(() => {
    let active = true;
    void api<{ templates: DeviceTemplate[] }>('/device-templates')
      .then((result) => {
        if (active) setTemplates(result.templates);
      })
      .catch(() => {
        /* Template loading has its own retry action. */
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!editingCell) return;
    const frame = requestAnimationFrame(() => {
      const cell = gridRoot.current?.querySelector<HTMLElement>(
        `td[data-port-cell="${CSS.escape(editingCell.portId + ':' + editingCell.column)}"]`,
      );
      // A later pointer/keyboard choice wins over deferred editor autofocus.
      const active = document.activeElement;
      if (active && active !== document.body && !cell?.contains(active)) return;
      cell?.querySelector<HTMLElement>('input,select,textarea')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [editingCell]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [serverErrors, setServerErrors] = useState<
    Record<string, Record<string, string>>
  >({});
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('order');
  const [page, setPage] = useState(0);
  const [connectionEditorPortId, setConnectionEditorPortId] = useState<
    string | null
  >(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [columns, setColumns] = useState<ColumnPreference[]>([]);
  const [fieldDirty, setFieldDirty] = useState(false);
  const [fieldBusy, setFieldBusy] = useState(false);
  const [auxiliaryDirty, setAuxiliaryDirty] = useState<Record<string, boolean>>(
    {},
  );
  const toolDirty = Object.values(auxiliaryDirty).some(Boolean);
  const hasCableDraft = Object.entries(auxiliaryDirty).some(
    ([key, value]) => key.startsWith('cable:') && value,
  );
  const [activeCablePortId, setActiveCablePortId] = useState<string | null>(
    null,
  );
  function setToolDirty(value: boolean, key = 'ports') {
    setAuxiliaryDirty((previous) => ({ ...previous, [key]: value }));
  }
  const gridRoot = useRef<HTMLElement>(null);
  const focusedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (!snapshot || !focusPortId || focusedTarget.current === focusPortId)
      return;
    const row = gridRoot.current?.querySelector<HTMLTableRowElement>(
      `tr[data-port-id="${CSS.escape(focusPortId)}"]`,
    );
    const control = row?.querySelector<HTMLElement>(
      'td[data-column="name"] button',
    );
    if (!row) {
      const targetPage = portTargetPage(snapshot.ports, focusPortId);
      if (targetPage !== null && targetPage !== page) {
        const frame = requestAnimationFrame(() => setPage(targetPage));
        return () => cancelAnimationFrame(frame);
      }
    }
    if (row && control) {
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      control.focus();
      focusedTarget.current = focusPortId;
    }
  }, [snapshot, focusPortId, page]);
  const [peerSelection, setPeerSelection] = useState<Record<string, string>>(
    {},
  );
  const [paste, setPaste] = useState('');
  const [pastePreview, setPastePreview] = useState<Port[] | null>(null);
  const mounted = useRef(false);
  const preferenceKey = `portfolio:columns:v1:${userId}:${siteId}`;
  const dirty = Object.keys(drafts).length > 0;
  const onSnapshot = useEffectEvent((result: Snapshot) => {
    setSnapshot(result);
    setLoading(false);
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(preferenceKey);
    } catch {
      /* Layout storage is optional. */
    }
    setColumns(columnsFromPreferences(stored, result.fields));
    if (result.device.rowVersion !== device.rowVersion)
      onDeviceChange(result.device);
  });
  const initialDevices = useEffectEvent(() => devices);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void fetchSnapshot(siteId, device.id, initialDevices())
      .then((result) => {
        if (active) onSnapshot(result);
      })
      .catch((error: unknown) => {
        if (active) {
          setError(message(error));
          setLoading(false);
        }
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [siteId, device.id]);
  const reportDirty = useEffectEvent(onDirtyChange);
  useEffect(() => {
    reportDirty(
      dirty ||
        fieldDirty ||
        toolDirty ||
        paste.length > 0 ||
        Object.values(peerSelection).some(Boolean),
    );
  }, [dirty, fieldDirty, toolDirty, paste, peerSelection]);
  useEffect(() => () => reportDirty(false), []);
  const reportBusy = useEffectEvent((busy: boolean) => onBusyChange?.(busy));
  useEffect(() => {
    reportBusy(pending || fieldBusy);
  }, [pending, fieldBusy]);
  useEffect(() => () => reportBusy(false), []);

  async function reload(discard = false) {
    if (!mounted.current) return;
    if (
      discard &&
      !window.confirm(
        'Discard all staged port changes and load current server records?',
      )
    )
      return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const result = await fetchSnapshot(siteId, device.id, devices);
      if (!mounted.current) return;
      setSnapshot(result);
      setColumns((previous) =>
        columnsFromPreferences(JSON.stringify(previous), result.fields),
      );
      if (discard) {
        setDrafts({});
        setConflict(false);
        setServerErrors({});
        setAuxiliaryDirty({});
        setActiveCablePortId(null);
        setPeerSelection({});
        setSelected([]);
        setPaste('');
        setPastePreview(null);
        gridRoot.current
          ?.querySelectorAll<HTMLFormElement>('form[data-tool]')
          .forEach((form) => form.reset());
      } else {
        setSelected((previous) =>
          previous.filter((id) => result.ports.some((port) => port.id === id)),
        );
      }
      onDeviceChange(result.device);
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  function setPreferences(next: ColumnPreference[]) {
    if (hasCableDraft) return;
    setColumns(next);
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(next));
    } catch {
      setNotice(
        'Column layout is available for this visit; browser storage is unavailable.',
      );
    }
  }
  function stage(port: Port, changes: Partial<Port>) {
    if (hasCableDraft) return;
    setServerErrors({});
    setPastePreview(null);
    setDrafts((previous) => {
      const next = { ...previous };
      const candidate = {
        port: { ...(previous[port.id]?.port ?? port), ...changes },
        customValues: previous[port.id]?.customValues ?? {},
      };
      const baseline = snapshot?.ports.find((item) => item.id === port.id);
      if (
        baseline &&
        JSON.stringify(candidate.port) === JSON.stringify(baseline) &&
        Object.keys(candidate.customValues).length === 0
      )
        delete next[port.id];
      else next[port.id] = candidate;
      return next;
    });
    setNotice('');
  }
  function stageCustom(port: Port, fieldId: string, value: CustomValue) {
    if (hasCableDraft) return;
    setServerErrors({});
    setPastePreview(null);
    setDrafts((previous) => ({
      ...previous,
      [port.id]: {
        port: previous[port.id]?.port ?? port,
        customValues: { ...previous[port.id]?.customValues, [fieldId]: value },
      },
    }));
    setNotice('');
  }
  const errors = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(drafts).map(([id, draft]) => [
          id,
          {
            ...rowErrors(
              draft.port,
              draft.customValues,
              snapshot?.fields ?? [],
            ),
            ...serverErrors[id],
          },
        ]),
      ),
    [drafts, snapshot?.fields, serverErrors],
  );
  async function save(portIds = Object.keys(drafts)) {
    if (pending || fieldBusy || fieldDirty || hasCableDraft) return;
    if (conflict) {
      setError(
        'Server records changed. Reload and discard drafts before saving.',
      );
      return;
    }
    const updates: BulkPortEdit['updates'] = [];
    for (const id of portIds) {
      const draft = drafts[id];
      if (!draft) continue;
      const validationErrors = rowErrors(
        draft.port,
        draft.customValues,
        snapshot?.fields ?? [],
      );
      if (Object.keys(validationErrors).length) {
        setColumns((previous) =>
          previous.map((column) =>
            Object.hasOwn(validationErrors, column.id)
              ? { ...column, visible: true }
              : column,
          ),
        );
        setError(
          `${draft.port.name}: ${Object.entries(validationErrors)
            .map(
              ([field, text]) =>
                `${labels[field] ?? snapshot?.fields.find((item) => `custom:${item.id}` === field)?.title ?? field}: ${text}`,
            )
            .join(' ')} No ports were saved.`,
        );
        return;
      }
      const rowVersion = draft.port.rowVersion;
      const changes = Object.fromEntries(
        Object.entries(draft.port).filter(
          ([key]) => !['id', 'deviceId', 'siteId', 'rowVersion'].includes(key),
        ),
      ) as BulkPortEdit['updates'][number]['changes'];
      updates.push({
        portId: id,
        rowVersion,
        changes,
        customValues: draft.customValues,
      });
    }
    if (!updates.length) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{
        ports: Port[];
        customValues: PortCustomValues;
        devices: Device[];
      }>(`/sites/${siteId}/ports/bulk-edit`, 'POST', { updates });
      if (!mounted.current) return;
      const saved = new Map(result.ports.map((port) => [port.id, port]));
      setSnapshot((previous) =>
        previous
          ? {
              ...previous,
              ports: previous.ports.map((port) => saved.get(port.id) ?? port),
              peers: previous.peers.map((port) => saved.get(port.id) ?? port),
              customValues: {
                ...previous.customValues,
                ...result.customValues,
              },
            }
          : previous,
      );
      setDrafts((previous) =>
        Object.fromEntries(
          Object.entries(previous).filter(([id]) => !saved.has(id)),
        ),
      );
      const updatedDevice = result.devices.find(
        (item) => item.id === device.id,
      );
      if (updatedDevice) onDeviceChange(updatedDevice);
      setConflict(false);
      setNotice(
        `${result.ports.length} port${result.ports.length === 1 ? '' : 's'} saved.`,
      );
      if (mounted.current) onSaved?.();
    } catch (error) {
      if (mounted.current) {
        setError(message(error) + ' Your staged changes are preserved.');
        if (error instanceof ApiError && error.fieldErrors) {
          const mapped: Record<string, Record<string, string>> = {};
          for (const [path, messages] of Object.entries(error.fieldErrors)) {
            const match = /^updates\.(\d+)\.(?:changes\.)?(.+)$/.exec(path);
            if (!match) continue;
            const update = updates[Number(match[1])];
            if (!update) continue;
            const field = match[2]!.startsWith('customValues.')
              ? `custom:${match[2]!.slice(13)}`
              : match[2]!.split('.')[0]!;
            mapped[update.portId] = {
              ...mapped[update.portId],
              [field]: messages.join(' '),
            };
          }
          setServerErrors(mapped);
        }

        if (error instanceof ApiError && error.status === 409)
          setConflict(true);
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  function escapeCell(
    port: Port,
    column: string,
    event: KeyboardEvent<HTMLElement>,
  ) {
    if (column === 'connectedTo') return;
    if (hasCableDraft) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setServerErrors({});
      const original = snapshot?.ports.find((item) => item.id === port.id);
      if (!original) return;
      if (column.startsWith('custom:')) {
        const fieldId = column.slice(7);
        setDrafts((previous) => {
          const current = previous[port.id];
          if (!current) return previous;
          const customValues = { ...current.customValues };
          delete customValues[fieldId];
          const next = { ...previous };
          if (
            JSON.stringify(current.port) === JSON.stringify(original) &&
            !Object.keys(customValues).length
          )
            delete next[port.id];
          else next[port.id] = { ...current, customValues };
          return next;
        });
      } else if (column !== 'connectedTo')
        stage(original, { [column]: original[column as keyof Port] });
    }
    if (
      event.key === 'Enter' &&
      !(event.target instanceof HTMLTextAreaElement) &&
      !(event.target instanceof HTMLSelectElement) &&
      !(event.target instanceof HTMLButtonElement)
    ) {
      event.preventDefault();
      void save([port.id]);
    }
  }

  async function generate(event: FormEvent<HTMLFormElement>, single = false) {
    event.preventDefault();
    if (hasCableDraft) {
      setError('Save or explicitly discard cable details before adding ports.');
      return;
    }
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setError('');
    const parsed = single
      ? createPortSchema.safeParse({
          name: String(form.get('name')),
          kind: String(form.get('kind')),
        })
      : generatePortsSchema.safeParse({
          count: Number(form.get('count')),
          startNumber: Number(form.get('startNumber')),
          namePrefix: String(form.get('prefix')),
          kind: String(form.get('kind')),
          rowVersion: device.rowVersion,
        });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    setPending(true);
    try {
      await api(
        `/sites/${siteId}/devices/${device.id}/ports${single ? '' : '/generate'}`,
        'POST',
        parsed.data,
      );
      if (!mounted.current) return;
      setToolDirty(false, formElement.dataset.tool);
      formElement.reset();
      await reload();
      if (mounted.current) onSaved?.();
    } catch (error) {
      setError(message(error));
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  async function deletePort(port: Port) {
    if (hasCableDraft) {
      setError(
        'Save or explicitly discard cable details before deleting ports.',
      );
      return;
    }
    if (
      !window.confirm(
        `Delete ${port.name}? Stored custom values will also be deleted. Disconnect cables first.`,
      )
    )
      return;
    setPending(true);
    setError('');
    try {
      await api(`/sites/${siteId}/ports/${port.id}`, 'DELETE', {
        rowVersion: port.rowVersion,
      });
      await reload();
      if (mounted.current) onSaved?.();
    } catch (error) {
      setError(message(error));
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  async function quickVlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(event.currentTarget);
    const parsed = createVlanSchema.safeParse({
      vlanId: Number(form.get('vlanId')),
      name: String(form.get('vlanName')),
      color: String(form.get('color')),
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(' '));
      return;
    }
    setPending(true);
    setError('');
    try {
      const { vlan } = await api<{ vlan: Vlan }>(
        `/sites/${siteId}/vlans`,
        'POST',
        parsed.data,
      );
      if (!mounted.current) return;
      onVlansChange([...vlans, vlan].sort((a, b) => a.vlanId - b.vlanId));
      setToolDirty(false, 'vlan');
      formElement.reset();
      setNotice(`VLAN ${vlan.vlanId} created.`);
    } catch (error) {
      setError(message(error));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  const peerPortsById = useMemo(
    () => new Map(snapshot?.peers.map((port) => [port.id, port]) ?? []),
    [snapshot?.peers],
  );
  const devicesById = useMemo(
    () => new Map(devices.map((device) => [device.id, device])),
    [devices],
  );
  const connectionsByPort = useMemo(() => {
    const map = new Map<string, Connection>();
    for (const cable of snapshot?.connections ?? []) {
      map.set(cable.endpointAPortId, cable);
      map.set(cable.endpointBPortId, cable);
    }
    return map;
  }, [snapshot?.connections]);
  const peerLabel = (portId: string) => {
    const port = peerPortsById.get(portId);
    const peerDevice = port ? devicesById.get(port.deviceId) : undefined;
    return port
      ? `${peerDevice?.displayName ?? 'Device'} / ${port.name}`
      : 'Unavailable endpoint';
  };
  const cablesFor = (portId: string) => {
    const cable = connectionsByPort.get(portId);
    return cable ? [cable] : [];
  };
  async function connect(port: Port) {
    if (hasCableDraft) {
      setError(
        'Save or explicitly discard cable details before changing connections.',
      );
      return;
    }
    const target = snapshot?.peers.find(
      (item) => item.id === peerSelection[port.id],
    );
    if (!target) return;
    const occupied = [
      ...new Map(
        [...cablesFor(port.id), ...cablesFor(target.id)].map((cable) => [
          cable.id,
          cable,
        ]),
      ).values(),
    ];
    if (
      occupied.length &&
      !window.confirm(
        `Replace these documented cables?\n${occupied.map((cable) => `${peerLabel(cable.endpointAPortId)} ↔ ${peerLabel(cable.endpointBPortId)}`).join('\n')}\nNew cable: ${peerLabel(port.id)} ↔ ${peerLabel(target.id)}`,
      )
    )
      return;
    setPending(true);
    setError('');
    try {
      await api(`/sites/${siteId}/connections`, 'POST', {
        endpointAPortId: port.id,
        endpointBPortId: target.id,
        endpointARowVersion: port.rowVersion,
        endpointBRowVersion: target.rowVersion,
        replaceConnections: occupied.map(({ id, rowVersion }) => ({
          id,
          rowVersion,
        })),
      });
      await reload();
      if (mounted.current) onSaved?.();
      if (mounted.current)
        setPeerSelection((previous) => {
          const next = { ...previous };
          delete next[port.id];
          return next;
        });
      setNotice('Connection saved at both endpoints.');
    } catch (error) {
      setError(message(error));
    } finally {
      if (mounted.current) setPending(false);
    }
  }
  async function disconnect(cable: Connection) {
    if (hasCableDraft) {
      setError(
        'Save or explicitly discard cable details before changing connections.',
      );
      return;
    }
    if (
      !window.confirm(
        `Disconnect ${peerLabel(cable.endpointAPortId)} ↔ ${peerLabel(cable.endpointBPortId)}?`,
      )
    )
      return;
    setPending(true);
    setError('');
    try {
      await api(`/sites/${siteId}/connections/${cable.id}`, 'DELETE', {
        rowVersion: cable.rowVersion,
      });
      await reload();
      if (mounted.current) onSaved?.();
      setNotice('Connection removed at both endpoints.');
    } catch (error) {
      setError(message(error));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  async function saveCableMetadata(
    event: FormEvent<HTMLFormElement>,
    cable: Connection,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError('');
    try {
      await api(`/sites/${siteId}/connections/${cable.id}`, 'PATCH', {
        rowVersion: cable.rowVersion,
        cableType: String(form.get('cableType')),
        notes: String(form.get('notes')),
      });
      if (!mounted.current) return;
      setToolDirty(false, `cable:${cable.id}`);
      setActiveCablePortId(null);
      await reload();
      if (mounted.current) onSaved?.();
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  function applySelected(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (hasCableDraft) {
      setError(
        'Save or explicitly discard cable details before staging port edits.',
      );
      return;
    }
    if (!snapshot) return;
    const form = new FormData(event.currentTarget);
    const changes: Partial<Port> = {};
    const mode = String(form.get('mode'));
    const native = String(form.get('native'));
    if (mode) changes.mode = mode as Port['mode'];
    if (native !== 'keep') changes.nativeVlanRef = native || null;
    if (!Object.keys(changes).length) {
      setError('Choose a mode or native VLAN to apply.');
      return;
    }
    const candidates = selected.map((id) => {
      const original = snapshot.ports.find((item) => item.id === id)!;
      return { ...(drafts[id]?.port ?? original), ...changes };
    });
    if (candidates.some((port) => !portRecordSchema.safeParse(port).success)) {
      setError(
        'The selected rows would contain invalid VLAN/mode combinations. Nothing was staged.',
      );
      return;
    }
    setDrafts((previous) => {
      const next = { ...previous };
      for (const port of candidates) {
        const customValues = previous[port.id]?.customValues ?? {};
        const baseline = snapshot.ports.find((item) => item.id === port.id);
        if (
          JSON.stringify(port) === JSON.stringify(baseline) &&
          !Object.keys(customValues).length
        )
          delete next[port.id];
        else next[port.id] = { port, customValues };
      }
      return next;
    });
    setNotice(`${candidates.length} rows staged. Review and save all changes.`);
    setToolDirty(false, 'bulk');
    event.currentTarget.reset();
  }

  if (loading) return <p role="status">Loading ports…</p>;
  if (!snapshot)
    return (
      <section className="port-grid">
        <p className="error-message" role="alert">
          {error}
        </p>
        <button
          onClick={() => {
            setLoading(true);
            void fetchSnapshot(siteId, device.id, devices)
              .then((result) => {
                if (mounted.current) {
                  setSnapshot(result);
                  setLoading(false);
                  setColumns(columnsFromPreferences(null, result.fields));
                  onDeviceChange(result.device);
                }
              })
              .catch((error: unknown) => {
                if (mounted.current) {
                  setError(message(error));
                  setLoading(false);
                }
              });
          }}
        >
          Retry loading ports
        </button>
      </section>
    );
  const optionalBusy =
    pending ||
    fieldBusy ||
    dirty ||
    fieldDirty ||
    toolDirty ||
    paste.length > 0;
  const currentPorts = snapshot.ports.map(
    (port) => drafts[port.id]?.port ?? port,
  );
  const matchingPorts = currentPorts
    .filter((port) =>
      `${port.name} ${port.description} ${port.mode} ${port.externalDestinationLabel}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, undefined, { numeric: true })
        : sort === 'mode'
          ? a.mode.localeCompare(b.mode) || a.orderIndex - b.orderIndex
          : a.orderIndex - b.orderIndex,
    );
  const pagination = portPage(matchingPorts, page);
  const visiblePorts = pagination.items;
  const lazyConnections = snapshot.peers.length > 64;
  const visibleColumns = columns.filter((column) => column.visible);
  const inspectedPort = currentPorts.find((port) => port.id === inspectedId);
  function focusCell(portId: string, column: string) {
    requestAnimationFrame(() =>
      gridRoot.current
        ?.querySelector<HTMLElement>(
          `td[data-port-cell="${CSS.escape(portId + ':' + column)}"] button.compact-cell`,
        )
        ?.focus(),
    );
  }
  function openCell(port: Port, column: string) {
    if (hasCableDraft || pending || fieldBusy || fieldDirty) return;
    setInspectedId(port.id);
    if (column !== 'connectedTo') setEditingCell({ portId: port.id, column });
    else setEditingCell(null);
  }
  function cellKey(
    port: Port,
    column: string,
    event: KeyboardEvent<HTMLTableCellElement>,
  ) {
    const editing =
      editingCell?.portId === port.id && editingCell.column === column;
    if (event.key === 'Escape' && editing) {
      escapeCell(port, column, event);
      setEditingCell(null);
      focusCell(port.id, column);
      return;
    }
    if (!editing && ['Enter', 'F2'].includes(event.key)) {
      event.preventDefault();
      openCell(port, column);
      return;
    }
    if (
      editing &&
      event.key === 'Enter' &&
      !(event.target instanceof HTMLTextAreaElement)
    ) {
      event.preventDefault();
      setEditingCell(null);
      focusCell(port.id, column);
      return;
    }
    if (
      event.key === 'Tab' ||
      (!editing &&
        ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key))
    ) {
      const row = visiblePorts.findIndex((item) => item.id === port.id);
      const col = visibleColumns.findIndex((item) => item.id === column);
      let index = row * visibleColumns.length + col;
      index +=
        event.key === 'ArrowUp'
          ? -visibleColumns.length
          : event.key === 'ArrowDown'
            ? visibleColumns.length
            : event.key === 'ArrowLeft' ||
                (event.key === 'Tab' && event.shiftKey)
              ? -1
              : 1;
      if (index >= 0 && index < visiblePorts.length * visibleColumns.length) {
        event.preventDefault();
        setEditingCell(null);
        focusCell(
          visiblePorts[Math.floor(index / visibleColumns.length)]!.id,
          visibleColumns[index % visibleColumns.length]!.id,
        );
      } else if (editing) setEditingCell(null);
    }
  }
  function renderCell(
    port: Port,
    column: string,
    view: 'table' | 'inspector' = 'table',
  ): ReactNode {
    const label = `${port.name} ${labels[column] ?? snapshot!.fields.find((field) => `custom:${field.id}` === column)?.title ?? column}`;
    const disabled = pending || fieldBusy || fieldDirty || hasCableDraft;
    const invalid = Boolean(errors[port.id]?.[column]);
    const errorId = `port-error-${view}-${port.id}-${column}`;
    if (column.startsWith('custom:')) {
      const field = snapshot!.fields.find(
        (item) => `custom:${item.id}` === column,
      );
      if (!field) return null;
      const draftValue = drafts[port.id]?.customValues;
      const stored = snapshot!.customValues[port.id];
      const value =
        draftValue && Object.hasOwn(draftValue, field.id)
          ? draftValue[field.id]!
          : stored && Object.hasOwn(stored, field.id)
            ? stored[field.id]!
            : field.defaultValue;
      return (
        <CustomInput
          label={label}
          invalid={invalid}
          errorId={invalid ? errorId : undefined}
          field={field}
          value={value}
          disabled={disabled}
          onChange={(value) => stageCustom(port, field.id, value)}
        />
      );
    }
    if (column === 'kind')
      return (
        <select
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          value={port.kind}
          onChange={(event) =>
            stage(port, { kind: event.target.value as Port['kind'] })
          }
        >
          {kinds.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      );
    if (column === 'mode')
      return (
        <select
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          value={port.mode}
          onChange={(event) =>
            stage(port, { mode: event.target.value as Port['mode'] })
          }
        >
          {modes.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      );
    if (column === 'nativeVlanRef')
      return (
        <select
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          value={port.nativeVlanRef ?? ''}
          onChange={(event) =>
            stage(port, { nativeVlanRef: event.target.value || null })
          }
        >
          <option value="">None</option>
          {vlans.map((vlan) => (
            <option key={vlan.id} value={vlan.id}>
              {vlan.vlanId} · {vlan.name || 'Unnamed'}
            </option>
          ))}
        </select>
      );
    if (column === 'taggedVlanRefs')
      return (
        <select
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          multiple
          size={Math.min(3, Math.max(2, vlans.length))}
          value={port.taggedVlanRefs}
          onChange={(event) =>
            stage(port, {
              taggedVlanRefs: Array.from(event.target.selectedOptions).map(
                (option) => option.value,
              ),
            })
          }
        >
          {vlans.map((vlan) => (
            <option key={vlan.id} value={vlan.id}>
              {vlan.vlanId} · {vlan.name || 'Unnamed'}
            </option>
          ))}
        </select>
      );
    if (column === 'documentedLinkState')
      return (
        <select
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          value={port.documentedLinkState}
          onChange={(event) =>
            stage(port, {
              documentedLinkState: event.target
                .value as Port['documentedLinkState'],
            })
          }
        >
          <option value="unknown">Unknown</option>
          <option value="up">Documented up</option>
          <option value="down">Documented down</option>
        </select>
      );
    if (column === 'face')
      return (
        <select
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          value={port.face}
          onChange={(event) =>
            stage(port, { face: event.target.value as Port['face'] })
          }
        >
          <option value="front">Front</option>
          <option value="rear">Rear</option>
        </select>
      );
    if (column === 'connectedTo') {
      const cableBlocked =
        activeCablePortId !== null && activeCablePortId !== port.id;
      const cable = cablesFor(port.id)[0];
      return (
        <div className="connection-cell">
          {cable && (
            <>
              <span>
                {peerLabel(
                  cable.endpointAPortId === port.id
                    ? cable.endpointBPortId
                    : cable.endpointAPortId,
                )}
              </span>
              <button
                type="button"
                disabled={optionalBusy}
                onClick={() => void disconnect(cable)}
                aria-label={`Disconnect ${port.name}`}
              >
                Disconnect
              </button>
              <details>
                <summary>Cable details</summary>
                <form
                  key={`${cable.id}:${cable.rowVersion}`}
                  data-tool={`cable:${cable.id}`}
                  onChange={() => {
                    setActiveCablePortId(port.id);
                    setToolDirty(true, `cable:${cable.id}`);
                  }}
                  onSubmit={(event) => void saveCableMetadata(event, cable)}
                >
                  <label>
                    Cable type
                    <input
                      name="cableType"
                      maxLength={120}
                      aria-label={`${port.name} Cable type`}
                      defaultValue={cable.cableType}
                      disabled={
                        pending ||
                        fieldBusy ||
                        dirty ||
                        fieldDirty ||
                        cableBlocked
                      }
                    />
                  </label>
                  <label>
                    Cable notes
                    <textarea
                      name="notes"
                      maxLength={2000}
                      aria-label={`${port.name} Cable notes`}
                      defaultValue={cable.notes}
                      disabled={
                        pending ||
                        fieldBusy ||
                        dirty ||
                        fieldDirty ||
                        cableBlocked
                      }
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={
                      pending ||
                      fieldBusy ||
                      dirty ||
                      fieldDirty ||
                      cableBlocked
                    }
                  >
                    Save cable details
                  </button>
                </form>
              </details>
            </>
          )}
          {lazyConnections && (
            <button
              type="button"
              disabled={optionalBusy}
              aria-label={`Choose connection for ${port.name}`}
              onClick={() => setConnectionEditorPortId(port.id)}
            >
              {connectionEditorPortId === port.id
                ? 'Connection picker open'
                : 'Choose connection'}
            </button>
          )}
          {(!lazyConnections || connectionEditorPortId === port.id) && (
            <>
              <select
                aria-label={`${port.name} Connection peer`}
                disabled={optionalBusy}
                value={peerSelection[port.id] ?? ''}
                onChange={(event) =>
                  setPeerSelection((previous) => ({
                    ...previous,
                    [port.id]: event.target.value,
                  }))
                }
              >
                <option value="">Choose a peer port</option>
                {snapshot!.peers
                  .filter(
                    (peer) => peer.id !== port.id && peer.siteId === siteId,
                  )
                  .map((peer) => (
                    <option key={peer.id} value={peer.id}>
                      {peerLabel(peer.id)}
                      {cablesFor(peer.id).length ? ' (connected)' : ''}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                disabled={optionalBusy || !peerSelection[port.id]}
                onClick={() => void connect(port)}
                aria-label={`Connect ${port.name}`}
              >
                Connect
              </button>
            </>
          )}
        </div>
      );
    }
    if (column === 'description')
      return (
        <textarea
          aria-label={label}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          disabled={disabled}
          rows={2}
          maxLength={10000}
          value={port.description}
          onChange={(event) => stage(port, { description: event.target.value })}
        />
      );
    const numeric = column === 'pvid' || column === 'orderIndex';
    const value = port[column as keyof Port];
    return (
      <input
        aria-label={label}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        disabled={disabled}
        type={numeric ? 'number' : 'text'}
        min={column === 'pvid' ? 1 : column === 'orderIndex' ? 0 : undefined}
        max={
          column === 'pvid' ? 4094 : column === 'orderIndex' ? 65535 : undefined
        }
        step={numeric ? 1 : undefined}
        value={
          typeof value === 'number' && Number.isNaN(value)
            ? ''
            : value === null
              ? ''
              : String(value)
        }
        onChange={(event) =>
          stage(port, {
            [column]: numeric
              ? event.target.value === ''
                ? column === 'pvid'
                  ? null
                  : Number.NaN
                : Number(event.target.value)
              : event.target.value,
          })
        }
      />
    );
  }

  return (
    <section
      ref={gridRoot}
      className="port-grid"
      aria-labelledby="ports-heading"
    >
      <div className="grid-header">
        <div>
          <h2 id="ports-heading">Ports · {device.displayName}</h2>
          <p className="grid-help">Edits stay staged until Save all changes.</p>
        </div>
        <div className="grid-actions">
          <button
            type="button"
            disabled={
              !dirty ||
              pending ||
              fieldBusy ||
              fieldDirty ||
              hasCableDraft ||
              conflict
            }
            onClick={() => void save()}
          >
            Save all changes
          </button>
          <button
            type="button"
            disabled={pending || fieldBusy || fieldDirty}
            onClick={() =>
              void reload(
                dirty ||
                  toolDirty ||
                  paste.length > 0 ||
                  Object.values(peerSelection).some(Boolean),
              )
            }
          >
            {dirty ? 'Reload and discard drafts' : 'Refresh ports'}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {focusPortId &&
        !snapshot.ports.some((port) => port.id === focusPortId) && (
          <p role="alert" className="error-message">
            The requested port is unavailable on this device.
          </p>
        )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {conflict && (
        <p className="grid-help">
          Server records changed. All drafts are preserved; reload and discard
          them only after reviewing your edits. Saving is blocked until reload.
        </p>
      )}
      <div className="grid-tools">
        <details className="grid-tool">
          <summary>Add ports</summary>
          <p className="grid-help">
            Save or discard grid edits before adding ports. Port numbering must
            be unique.
          </p>
          {hasCableDraft && (
            <p className="grid-help">
              Save or explicitly discard your cable details before adding or
              deleting ports. Other cable forms are locked until these edits are
              resolved.
            </p>
          )}
          <form
            className="grid-tool-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const template = templates.find((item) => item.id === templateId);
              if (!template || optionalBusy) return;
              setPending(true);
              setError('');
              try {
                await api(
                  `/sites/${siteId}/devices/${device.id}/ports/from-template`,
                  'POST',
                  {
                    rowVersion: snapshot.device.rowVersion,
                    groups: template.groups,
                  },
                );
                await reload();
                if (mounted.current) {
                  setTemplateId('');
                  onSaved?.();
                }
              } catch (error) {
                if (mounted.current) setError(message(error));
              } finally {
                if (mounted.current) setPending(false);
              }
            }}
          >
            <label>
              Port template
              <select
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
                disabled={optionalBusy}
              >
                <option value="">Choose a template</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={optionalBusy || !templateId}>
              Add template ports
            </button>
            {!templates.length && (
              <button
                type="button"
                onClick={() => {
                  void api<{ templates: DeviceTemplate[] }>('/device-templates')
                    .then((result) => {
                      if (mounted.current) setTemplates(result.templates);
                    })
                    .catch((error) => {
                      if (mounted.current) setError(message(error));
                    });
                }}
              >
                Load port templates
              </button>
            )}
          </form>
          <div className="grid-presets">
            {[8, 24, 48].map((count) => (
              <button
                type="button"
                key={count}
                disabled={optionalBusy}
                onClick={async () => {
                  if (hasCableDraft) {
                    setError(
                      'Save or explicitly discard cable details before adding ports.',
                    );
                    return;
                  }
                  setPending(true);
                  setError('');
                  try {
                    await api(
                      `/sites/${siteId}/devices/${device.id}/ports/generate`,
                      'POST',
                      {
                        count,
                        startNumber: snapshot.ports.length + 1,
                        rowVersion: device.rowVersion,
                      },
                    );
                    await reload();
                    if (mounted.current) onSaved?.();
                  } catch (error) {
                    setError(message(error));
                  } finally {
                    if (mounted.current) setPending(false);
                  }
                }}
              >
                Add {count} ports
              </button>
            ))}
          </div>
          <form
            className="grid-tool-form"
            data-tool="generate"
            onChange={() => setToolDirty(true, 'generate')}
            onSubmit={(event) => void generate(event)}
          >
            <label>
              Port count
              <input
                name="count"
                type="number"
                min={1}
                max={256}
                defaultValue={8}
                required
              />
            </label>
            <label>
              Start number
              <input
                name="startNumber"
                type="number"
                min={1}
                max={65535}
                defaultValue={snapshot.ports.length + 1}
                required
              />
            </label>
            <label>
              Name prefix
              <input name="prefix" maxLength={80} defaultValue="Port " />
            </label>
            <label>
              Connector kind
              <select name="kind">
                {kinds.map(([value, text]) => (
                  <option value={value} key={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={
                pending || fieldBusy || dirty || fieldDirty || hasCableDraft
              }
              type="submit"
            >
              Generate ports
            </button>
          </form>
          <form
            className="grid-tool-form"
            data-tool="single"
            onChange={() => setToolDirty(true, 'single')}
            onSubmit={(event) => void generate(event, true)}
          >
            <label>
              New port name
              <input name="name" required maxLength={120} />
            </label>
            <label>
              Single port kind
              <select name="kind">
                {kinds.map(([value, text]) => (
                  <option value={value} key={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={
                pending || fieldBusy || dirty || fieldDirty || hasCableDraft
              }
              type="submit"
            >
              Add single port
            </button>
          </form>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (
                !window.confirm(
                  'Discard all auxiliary port, VLAN, and cable form changes?',
                )
              )
                return;
              gridRoot.current
                ?.querySelectorAll<HTMLFormElement>('form[data-tool]')
                .forEach((form) => form.reset());
              setAuxiliaryDirty({});
              setActiveCablePortId(null);
              setNotice('Auxiliary form changes discarded.');
            }}
          >
            Discard auxiliary form changes
          </button>
        </details>
        <details className="grid-tool">
          <summary>Quick-add VLAN</summary>
          <form
            className="grid-tool-form"
            data-tool="vlan"
            onChange={() => setToolDirty(true, 'vlan')}
            onSubmit={(event) => void quickVlan(event)}
          >
            <label>
              VLAN ID
              <input name="vlanId" type="number" min={1} max={4094} required />
            </label>
            <label>
              VLAN name
              <input name="vlanName" maxLength={120} />
            </label>
            <label>
              VLAN color
              <input name="color" type="color" defaultValue="#428deb" />
            </label>
            <button type="submit" disabled={pending || fieldBusy || fieldDirty}>
              Create VLAN
            </button>
          </form>
        </details>
        <details className="grid-tool">
          <summary>Columns</summary>
          <p className="grid-help">
            Only this layout preference is saved in this browser. Port records
            stay on the server.
          </p>
          {columns.map((column, index) => (
            <div className="column-row" key={column.id}>
              <label>
                <input
                  type="checkbox"
                  disabled={column.id === 'name' || hasCableDraft}
                  checked={column.visible}
                  onChange={(event) =>
                    setPreferences(
                      columns.map((item) =>
                        item.id === column.id
                          ? { ...item, visible: event.target.checked }
                          : item,
                      ),
                    )
                  }
                />
                {labels[column.id] ??
                  snapshot.fields.find(
                    (field) => `custom:${field.id}` === column.id,
                  )?.title ??
                  column.id}
              </label>
              <button
                type="button"
                disabled={index === 0 || hasCableDraft}
                aria-label={`Move ${labels[column.id] ?? column.id} column up`}
                onClick={() => {
                  const next = [...columns];
                  [next[index - 1], next[index]] = [
                    next[index]!,
                    next[index - 1]!,
                  ];
                  setPreferences(next);
                }}
              >
                ↑
              </button>
              <button
                type="button"
                disabled={index === columns.length - 1 || hasCableDraft}
                aria-label={`Move ${labels[column.id] ?? column.id} column down`}
                onClick={() => {
                  const next = [...columns];
                  [next[index], next[index + 1]] = [
                    next[index + 1]!,
                    next[index]!,
                  ];
                  setPreferences(next);
                }}
              >
                ↓
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={hasCableDraft}
            onClick={() =>
              setPreferences(columnsFromPreferences(null, snapshot.fields))
            }
          >
            Reset column layout
          </button>
        </details>
        <CustomFields
          onBusyChange={setFieldBusy}
          siteId={siteId}
          fields={snapshot.fields}
          disabled={
            dirty ||
            pending ||
            toolDirty ||
            paste.length > 0 ||
            Object.values(peerSelection).some(Boolean)
          }
          onDirtyChange={setFieldDirty}
          onChange={(fields) => {
            if (!mounted.current) return;
            setSnapshot((previous) =>
              previous ? { ...previous, fields } : previous,
            );
            setPreferences(
              columnsFromPreferences(JSON.stringify(columns), fields),
            );
            void reload();
            if (mounted.current) onSaved?.();
          }}
        />
        <details className="grid-tool">
          <summary>Spreadsheet copy/paste</summary>
          <p className="grid-help">
            Paste tab-separated rows with exact headers below. Empty VLAN/PVID
            cells clear that field. Mode uses access, trunk, routed, disabled,
            or other. All rows validate before staging.
          </p>
          <code>{pasteHeaders.join(' · ')}</code>
          <label className="grid-textarea-label">
            Port table TSV
            <textarea
              rows={5}
              value={paste}
              onChange={(event) => {
                setPaste(event.target.value);
                setPastePreview(null);
              }}
            />
          </label>
          <div className="grid-actions">
            <button
              type="button"
              disabled={pending || fieldBusy || fieldDirty}
              onClick={() => {
                setError('');
                try {
                  setPastePreview(parsePortPaste(paste, currentPorts, vlans));
                } catch (error) {
                  setError(message(error));
                }
              }}
            >
              Preview paste
            </button>
            <button
              type="button"
              disabled={!pastePreview || pending || fieldDirty || hasCableDraft}
              onClick={() => {
                if (!pastePreview || hasCableDraft) return;
                setDrafts((previous) => ({
                  ...previous,
                  ...Object.fromEntries(
                    pastePreview.map((port) => [
                      port.id,
                      {
                        port,
                        customValues: previous[port.id]?.customValues ?? {},
                      },
                    ]),
                  ),
                }));
                setNotice(
                  `${pastePreview.length} pasted rows staged. Review and save all changes.`,
                );
                setPaste('');
                setPastePreview(null);
              }}
            >
              Stage paste
            </button>
            <button
              type="button"
              onClick={() => {
                setPaste(portTSV(currentPorts, vlans));
                setPastePreview(null);
                setNotice(
                  'Current rows copied into the TSV field. Select the text to copy.',
                );
              }}
            >
              Copy rows to TSV field
            </button>
            <button
              type="button"
              onClick={() => {
                setPaste('');
                setPastePreview(null);
              }}
            >
              Clear paste
            </button>
          </div>
          {pastePreview && (
            <p role="status">
              {pastePreview.length} valid rows ready to stage. Nothing has been
              saved.
            </p>
          )}
        </details>
      </div>
      <div className="grid-filter">
        <label>
          Search ports
          <input
            type="search"
            disabled={hasCableDraft}
            value={search}
            onChange={(event) => {
              if (!hasCableDraft) {
                setSearch(event.target.value);
                setPage(0);
              }
            }}
          />
        </label>
        <label>
          Sort ports
          <select
            value={sort}
            disabled={hasCableDraft}
            onChange={(event) => {
              if (!hasCableDraft) {
                setSort(event.target.value);
                setPage(0);
              }
            }}
          >
            <option value="order">Physical order</option>
            <option value="name">Port name</option>
            <option value="mode">Mode</option>
          </select>
        </label>
        <span>
          {selected.length} selected · {Object.keys(drafts).length} staged
        </span>
      </div>
      <details className="compact-bulk">
        <summary>Bulk actions · {selected.length} selected</summary>
        <form
          className="grid-bulk"
          data-tool="bulk"
          onChange={() => setToolDirty(true, 'bulk')}
          onSubmit={applySelected}
        >
          <label>
            Selected rows mode
            <select name="mode" disabled={hasCableDraft}>
              <option value="">Keep mode</option>
              {modes.map(([value, text]) => (
                <option value={value} key={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label>
            Selected rows native VLAN
            <select name="native" disabled={hasCableDraft}>
              <option value="keep">Keep native VLAN</option>
              <option value="">None</option>
              {vlans.map((vlan) => (
                <option key={vlan.id} value={vlan.id}>
                  {vlan.vlanId} · {vlan.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={
              !selected.length ||
              pending ||
              fieldBusy ||
              fieldDirty ||
              hasCableDraft
            }
          >
            Apply to selected
          </button>
        </form>
      </details>
      {snapshot.ports.length > 64 && (
        <nav className="grid-pagination" aria-label="Port pages">
          <p aria-live="polite">
            Showing {pagination.start}–{pagination.end} of{' '}
            {matchingPorts.length} {search ? 'matching ' : ''}ports
          </p>
          <div className="grid-actions">
            <button
              type="button"
              aria-label="Previous port page"
              disabled={
                pending || fieldBusy || hasCableDraft || pagination.page === 0
              }
              onClick={() => {
                if (!hasCableDraft) setPage(pagination.page - 1);
              }}
            >
              Previous
            </button>
            <label>
              Port page
              <select
                aria-label="Port page"
                value={pagination.page}
                disabled={pending || fieldBusy || hasCableDraft}
                onChange={(event) => {
                  if (!hasCableDraft) setPage(Number(event.target.value));
                }}
              >
                {Array.from({ length: pagination.pageCount }, (_, index) => (
                  <option key={index} value={index}>
                    Page {index + 1} of {pagination.pageCount}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              aria-label="Next port page"
              disabled={
                pending ||
                fieldBusy ||
                hasCableDraft ||
                pagination.page === pagination.pageCount - 1
              }
              onClick={() => {
                if (!hasCableDraft) setPage(pagination.page + 1);
              }}
            >
              Next
            </button>
          </div>
          <p className="grid-help">
            Selection and staged edits are retained across pages. Save all
            changes commits every staged row. Spreadsheet copy includes all
            device rows.
          </p>
        </nav>
      )}
      <div className="compact-port-workspace">
        {snapshot.ports.length === 0 ? (
          <p className="grid-help">
            No ports yet. Use Add ports to generate physical interfaces.
          </p>
        ) : (
          <div
            className="port-table-scroll"
            tabIndex={0}
            aria-label="Scrollable port table"
          >
            <table aria-label={`${device.displayName} ports`}>
              <thead>
                <tr>
                  <th>
                    <input
                      aria-label="Select all visible ports"
                      type="checkbox"
                      checked={
                        visiblePorts.length > 0 &&
                        visiblePorts.every((port) => selected.includes(port.id))
                      }
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [
                                ...new Set([
                                  ...selected,
                                  ...visiblePorts.map((port) => port.id),
                                ]),
                              ]
                            : selected.filter(
                                (id) =>
                                  !visiblePorts.some((port) => port.id === id),
                              ),
                        )
                      }
                    />
                  </th>
                  {visibleColumns.map((column) => (
                    <th key={column.id} scope="col">
                      {labels[column.id] ??
                        snapshot.fields.find(
                          (field) => `custom:${field.id}` === column.id,
                        )?.title ??
                        column.id}
                    </th>
                  ))}
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visiblePorts.map((port) => (
                  <tr
                    key={port.id}
                    data-port-id={port.id}
                    data-dirty={Boolean(drafts[port.id])}
                    data-inspected={inspectedId === port.id}
                    onClick={() => {
                      if (!hasCableDraft) setInspectedId(port.id);
                    }}
                  >
                    <td>
                      <input
                        aria-label={`Select ${port.name}`}
                        type="checkbox"
                        checked={selected.includes(port.id)}
                        onChange={(event) =>
                          setSelected((previous) =>
                            event.target.checked
                              ? [...previous, port.id]
                              : previous.filter((id) => id !== port.id),
                          )
                        }
                      />
                    </td>
                    {visibleColumns.map((column) => (
                      <td
                        key={column.id}
                        data-column={column.id}
                        data-port-cell={`${port.id}:${column.id}`}
                        onKeyDown={(event) => cellKey(port, column.id, event)}
                        onPaste={(event) => {
                          const text =
                            event.clipboardData.getData('text/plain');
                          if (!text.includes('\t') && !text.includes('\n'))
                            return;
                          event.preventDefault();
                          if (
                            pending ||
                            fieldBusy ||
                            fieldDirty ||
                            hasCableDraft
                          )
                            return;
                          try {
                            const candidates = parseCellMatrix(
                              text,
                              matchingPorts,
                              port.id,
                              visibleColumns.map((item) => item.id),
                              column.id,
                              vlans,
                            );
                            setDrafts((previous) => ({
                              ...previous,
                              ...Object.fromEntries(
                                candidates.map((candidate) => [
                                  candidate.id,
                                  {
                                    port: candidate,
                                    customValues:
                                      previous[candidate.id]?.customValues ??
                                      {},
                                  },
                                ]),
                              ),
                            }));
                            setEditingCell(null);
                            setNotice(
                              `${candidates.length} pasted rows staged. Save all changes to commit.`,
                            );
                          } catch (error) {
                            setError(message(error));
                          }
                        }}
                        onCopy={(event) => {
                          if (editingCell) return;
                          const rows = selected.length
                            ? matchingPorts.filter((item) =>
                                selected.includes(item.id),
                              )
                            : [port];
                          event.clipboardData.setData(
                            'text/plain',
                            rows
                              .map((item) =>
                                visibleColumns
                                  .map((col) =>
                                    compactCellText(
                                      item,
                                      col.id,
                                      vlans,
                                      snapshot.fields,
                                      snapshot.customValues,
                                      drafts[item.id]?.customValues,
                                    ),
                                  )
                                  .join('\t'),
                              )
                              .join('\n'),
                          );
                          event.preventDefault();
                        }}
                      >
                        {editingCell?.portId === port.id &&
                        editingCell.column === column.id &&
                        column.id !== 'connectedTo' ? (
                          renderCell(port, column.id)
                        ) : (
                          <button
                            type="button"
                            className="compact-cell"
                            aria-invalid={
                              Boolean(errors[port.id]?.[column.id]) || undefined
                            }
                            aria-describedby={
                              errors[port.id]?.[column.id]
                                ? `port-error-table-${port.id}-${column.id}`
                                : undefined
                            }
                            aria-label={`${port.name} ${labels[column.id] ?? column.id}`}
                            disabled={
                              pending ||
                              fieldBusy ||
                              fieldDirty ||
                              hasCableDraft
                            }
                            onClick={() => openCell(port, column.id)}
                          >
                            {column.id === 'connectedTo'
                              ? cablesFor(port.id)[0]
                                ? peerLabel(
                                    cablesFor(port.id)[0]!.endpointAPortId ===
                                      port.id
                                      ? cablesFor(port.id)[0]!.endpointBPortId
                                      : cablesFor(port.id)[0]!.endpointAPortId,
                                  )
                                : '—'
                              : compactCellText(
                                  port,
                                  column.id,
                                  vlans,
                                  snapshot.fields,
                                  snapshot.customValues,
                                  drafts[port.id]?.customValues,
                                ) || '—'}
                          </button>
                        )}
                        {errors[port.id]?.[column.id] && (
                          <p
                            id={`port-error-table-${port.id}-${column.id}`}
                            className="grid-cell-error"
                            role="alert"
                          >
                            {errors[port.id]?.[column.id]}
                          </p>
                        )}
                      </td>
                    ))}
                    <td>
                      <details className="port-row-menu">
                        <summary aria-label={`Actions for ${port.name}`}>
                          •••
                        </summary>
                        <button
                          type="button"
                          disabled={
                            !drafts[port.id] ||
                            pending ||
                            fieldDirty ||
                            conflict
                          }
                          onClick={() => void save([port.id])}
                          aria-label={`Save ${port.name}`}
                        >
                          Save row
                        </button>
                        <button
                          type="button"
                          disabled={
                            optionalBusy || cablesFor(port.id).length > 0
                          }
                          onClick={() => void deletePort(port)}
                          aria-label={`Delete ${port.name}`}
                        >
                          Delete
                        </button>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {inspectedPort && (
          <aside className="port-details-inspector" aria-label="Port details">
            <div className="grid-header">
              <h3>{inspectedPort.name}</h3>
              <button
                type="button"
                disabled={hasCableDraft}
                aria-label="Close port details"
                onClick={() => setInspectedId(null)}
              >
                ×
              </button>
            </div>
            <p className="grid-help">
              Advanced properties · edits are staged until Save all.
            </p>
            {[
              'pvid',
              'speed',
              'externalDestinationLabel',
              'description',
              'face',
              'orderIndex',
              ...snapshot.fields.map((field) => `custom:${field.id}`),
            ].map((column) => (
              <div
                className="inspector-property"
                key={column}
                onKeyDown={(event) => {
                  if (event.key === 'Escape')
                    escapeCell(inspectedPort, column, event);
                }}
              >
                <label>
                  {labels[column] ??
                    snapshot.fields.find(
                      (field) => `custom:${field.id}` === column,
                    )?.title}
                </label>
                {renderCell(inspectedPort, column, 'inspector')}
                {errors[inspectedPort.id]?.[column] && (
                  <p
                    role="alert"
                    id={`port-error-inspector-${inspectedPort.id}-${column}`}
                    className="grid-cell-error"
                  >
                    {errors[inspectedPort.id]?.[column]}
                  </p>
                )}
              </div>
            ))}
            <h4>Connection</h4>
            {renderCell(inspectedPort, 'connectedTo', 'inspector')}
          </aside>
        )}
      </div>
    </section>
  );
}
