import { describe, expect, it } from 'vitest';
import { boardImportSchema, remapBoardDocument } from './board.js';
import { syntheticBoardProposal } from './integration.js';
import {
  generateBoardJson,
  validateBoardJson,
  getBoardImportSchema,
} from './board-json.js';

describe('offline board JSON', () => {
  it('generates the normal import envelope with complete graph and deterministic layout', () => {
    const proposal = syntheticBoardProposal();
    const before = structuredClone(proposal);
    const result = generateBoardJson(proposal);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.summary).toEqual({
      devices: 9,
      ports: 17,
      networks: 3,
      cables: 8,
      annotations: 2,
      unresolvedConnections: 1,
    });
    expect(Object.keys(result.archive!).sort()).toEqual([
      'document',
      'format',
      'name',
      'schemaVersion',
    ]);
    expect(result.archive!.format).toBe('portfolio-board');
    expect(boardImportSchema.safeParse(result.archive).success).toBe(true);
    expect(result.archive).toEqual(generateBoardJson(proposal).archive);
    expect(proposal).toEqual(before);
    expect(
      result.archive!.document.elements.some((e) =>
        String(e.properties.text).includes(
          'Router WAN destination is undocumented.',
        ),
      ),
    ).toBe(true);
    const validation = validateBoardJson(
      JSON.stringify(result.archive, null, 2),
    );
    expect(validation.valid).toBe(true);
    expect(validation.archive).toEqual(result.archive);
    const imported = remapBoardDocument(result.archive!.document);
    expect(imported.ports.map((p) => p.id)).not.toContain('router-lan');
    const namedPorts = new Map(imported.ports.map((p) => [p.id, p.name]));
    expect(
      imported.cables.map((c) => [
        namedPorts.get(c.sourcePortId),
        namedPorts.get(c.targetPortId),
      ]),
    ).toEqual(
      result.archive!.document.cables.map((c) => [
        result.archive!.document.ports.find((p) => p.id === c.sourcePortId)!
          .name,
        result.archive!.document.ports.find((p) => p.id === c.targetPortId)!
          .name,
      ]),
    );
  });

  it('packs a small topology into a readable footprint instead of an almost single row', () => {
    const result = generateBoardJson(syntheticBoardProposal());
    const elements = result.archive!.document.elements;
    const width =
      Math.max(...elements.map((e) => e.x + e.width)) -
      Math.min(...elements.map((e) => e.x));
    const height =
      Math.max(...elements.map((e) => e.y + e.height)) -
      Math.min(...elements.map((e) => e.y));
    expect(width).toBeLessThanOrEqual(1700);
    expect(height).toBeLessThanOrEqual(1200);
  });

  it('keeps incomplete, contradictory and optional documentation as authored with warnings', () => {
    const result = generateBoardJson({
      name: 'Incomplete',
      devices: [
        {
          id: 'd',
          name: 'Unknown model',
          documentation: {
            serialNumber: 'Documented serial',
            notes: 'Source contradicts address inventory',
          },
        },
      ],
      networks: [
        {
          id: 'n',
          entries: [
            {
              networkEntryId: 'v',
              vlanId: 'ambiguous',
              subnet: 'not recorded',
              gateway: '',
              documentation: { description: 'Check source' },
            },
            {
              networkEntryId: 'v2',
              subnet: '192.0.2.0/24',
              gateway: '198.51.100.1',
              dhcpServer: true,
            },
          ],
        },
      ],
      unresolvedConnections: ['Device A to B; ports not documented'],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/management.*not documented/i);
    expect(result.warnings.join(' ')).toMatch(/model.*not documented/i);
    expect(result.warnings.join(' ')).toMatch(/gateway.*not documented/i);
    expect(result.warnings.join(' ')).toMatch(/outside.*subnet/i);
    expect(result.warnings.join(' ')).toMatch(/unresolved/i);
    const d = result.archive!.document.elements[0]!;
    expect(d.properties.managementAddress).toBeUndefined();
    expect(d.properties.documentation).toMatchObject({
      serialNumber: 'Documented serial',
    });
    const entries = result.archive!.document.elements[1]!.properties
      .entries as Record<string, unknown>[];
    expect(entries[0]).toMatchObject({
      subnet: 'not recorded',
      vlanId: 'ambiguous',
      documentation: { description: 'Check source' },
    });
    expect(entries[1]!.gateway).toBe('198.51.100.1');
  });

  it('handles 36 mixed-size devices and 864 ports without overlaps or changing explicit coordinates', () => {
    const result = generateBoardJson({
      name: 'Large',
      devices: Array.from({ length: 36 }, (_, d) => ({
        id: `d${d}`,
        name: `Device ${d}`,
        ...(d === 0 ? { x: -900, y: -900 } : {}),
        portsPerRow: d % 2 ? 12 : 8,
        ports: Array.from({ length: 24 }, (_, p) => ({
          id: `p${d}-${p}`,
          kind: p % 2 ? 'rj45' : 'sfp_plus',
        })),
      })),
      connections: Array.from({ length: 35 }, (_, i) => ({
        id: `c${i}`,
        sourcePortId: `p${i}-0`,
        targetPortId: `p${i + 1}-1`,
      })),
    });
    expect(result.valid).toBe(true);
    expect(result.summary.ports).toBe(864);
    expect(result.summary.cables).toBe(35);
    const elements = result.archive!.document.elements;
    expect(elements[0]).toMatchObject({ x: -900, y: -900 });
    elements.forEach((a, i) =>
      elements
        .slice(i + 1)
        .forEach((b) =>
          expect(
            a.x + a.width <= b.x ||
              b.x + b.width <= a.x ||
              a.y + a.height <= b.y ||
              b.y + b.height <= a.y,
          ).toBe(true),
        ),
    );
  });

  it('rejects malformed files, versions, unsupported fields and broken graph ownership without an archive', () => {
    const archive = generateBoardJson(syntheticBoardProposal()).archive!;
    for (const input of [
      '{oops',
      { ...archive, schemaVersion: 2 },
      { ...archive, attachments: ['untrusted-file'] },
      {
        ...archive,
        document: {
          ...archive.document,
          ports: archive.document.ports.map((p, i) =>
            i ? p : { ...p, deviceId: 'missing' },
          ),
        },
      },
      {
        ...archive,
        document: {
          ...archive.document,
          cables: archive.document.cables.map((c, i) =>
            i ? c : { ...c, targetPortId: 'missing' },
          ),
        },
      },
      {
        ...archive,
        document: {
          ...archive.document,
          elements: archive.document.elements.map((e, i) =>
            i ? e : { ...e, x: Infinity },
          ),
        },
      },
    ]) {
      const result = validateBoardJson(input);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.archive).toBeUndefined();
    }
  });

  it('bounds file bytes, deep JSON and cycles before recursive parsing', () => {
    expect(validateBoardJson(' '.repeat(8 * 1024 * 1024 + 1)).valid).toBe(
      false,
    );
    const archive = generateBoardJson(syntheticBoardProposal()).archive!;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateBoardJson(cyclic).valid).toBe(false);
    let nested: unknown = 'x';
    for (let i = 0; i < 40; i++) nested = { nested };
    expect(
      validateBoardJson({
        ...archive,
        document: { ...archive.document, legacy: { nested } },
      }).valid,
    ).toBe(false);
    expect(
      generateBoardJson({
        name: 'bad',
        devices: [{ id: 'd', name: 'bad', documentation: { nested } }],
      }).valid,
    ).toBe(false);
    expect(validateBoardJson(undefined).valid).toBe(false);
  });

  it('does not emit files that exceed the importer limit after formatting or UTF-8 encoding', () => {
    const result = generateBoardJson({
      name: 'Large notes',
      devices: Array.from({ length: 9 }, (_, d) => ({
        id: `d${d}`,
        name: `D${d}`,
        ports: Array.from({ length: 100 }, (_, p) => ({
          id: `p${d}-${p}`,
          notes: 'é'.repeat(4500),
        })),
      })),
    });
    expect(result.valid).toBe(false);
    expect(result.archive).toBeUndefined();
    expect(result.errors.some((e) => e.message.includes('8 MiB'))).toBe(true);
    expect(
      validateBoardJson('"' + 'é'.repeat(4 * 1024 * 1024) + '"').errors[0]!
        .message,
    ).toContain('8 MiB');
  });

  it('warns about an incomplete CIDR prefix without inventing it', () => {
    const result = generateBoardJson({
      name: 'Prefix unknown',
      networks: [
        { id: 'n', entries: [{ networkEntryId: 'v', subnet: '192.0.2.0' }] },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/prefix.*not documented/i);
    expect(
      (
        result.archive!.document.elements[0]!.properties.entries as Record<
          string,
          unknown
        >[]
      )[0]!.subnet,
    ).toBe('192.0.2.0');
  });

  it('describes the actual proposal and import schemas without exposing runtime storage', () => {
    const schema = getBoardImportSchema();
    expect(schema).toMatchObject({
      format: 'portfolio-board',
      schemaVersion: 1,
    });
    expect(JSON.stringify(schema)).toContain('sourcePortId');
    expect(JSON.stringify(schema)).toContain('networkEntryId');
    expect(JSON.stringify(schema)).not.toContain('API_TOKEN');
  });
});
