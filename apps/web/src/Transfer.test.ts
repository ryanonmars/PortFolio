import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_MAX_BYTES,
  type SiteArchive,
} from '../../../packages/shared/src/index.js';
import {
  downloadFilename,
  parseImportText,
  suggestedImportName,
} from './Transfer.js';

const document: SiteArchive = {
  schemaVersion: 1,
  application: 'PortFolio',
  workspace: {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'Synthetic workspace',
    description: '',
  },
  site: {
    id: '10000000-0000-4000-8000-000000000002',
    workspaceId: '10000000-0000-4000-8000-000000000001',
    name: 'Example lab',
    description: '',
    notes: '',
    rowVersion: 1,
  },
  racks: [],
  vlans: [],
  subnets: [],
  dhcpScopes: [],
  devices: [],
  ports: [],
  fields: [],
  connections: [],
  logicalConnections: [],
  customValues: [],
};

describe('site transfer input handling', () => {
  it('accepts a valid empty site without requiring racks or network inventory, including UTF-8 BOM files', () => {
    expect(parseImportText(JSON.stringify(document))).toEqual(document);
    expect(parseImportText('\uFEFF' + JSON.stringify(document))).toEqual(
      document,
    );
  });
  it('rejects malformed, empty and unsupported documents before preview', () => {
    expect(() => parseImportText(' ')).toThrow('Choose a JSON');
    expect(() => parseImportText('{broken')).toThrow('not valid JSON');
    expect(() =>
      parseImportText(JSON.stringify({ ...document, schemaVersion: 2 })),
    ).toThrow();
    expect(() =>
      parseImportText(
        JSON.stringify({
          ...document,
          users: [{ password: 'never import authentication data' }],
        }),
      ),
    ).toThrow();
  });
  it('bounds actual UTF-8 bytes rather than only textarea character count', () => {
    expect(() =>
      parseImportText('"' + 'é'.repeat(ARCHIVE_MAX_BYTES / 2) + '"'),
    ).toThrow('8 MiB');
  });
  it('validates site ownership of every imported record', () => {
    const foreignVlan = {
      id: '10000000-0000-4000-8000-000000000003',
      siteId: '10000000-0000-4000-8000-000000000004',
      vlanId: 20,
      name: 'Servers',
      color: null,
      description: '',
      rowVersion: 1,
    };
    expect(() =>
      parseImportText(JSON.stringify({ ...document, vlans: [foreignVlan] })),
    ).toThrow('exported site');
  });
  it('prefills a bounded copy name without splitting Unicode surrogate pairs', () => {
    expect(suggestedImportName(document)).toBe('Example lab (imported)');
    const result = suggestedImportName({
      ...document,
      site: { ...document.site, name: '🖧'.repeat(60) },
    });
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result).toMatch(/ \(imported\)$/);
    expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});

describe('site export filename handling', () => {
  it('uses server filenames with a safe JSON fallback', () => {
    expect(downloadFilename('attachment; filename="portfolio-site.json"')).toBe(
      'portfolio-site.json',
    );
    expect(
      downloadFilename("attachment; filename*=UTF-8''PortFolio%20Lab.json"),
    ).toBe('PortFolio Lab.json');
    expect(downloadFilename(null)).toBe('PortFolio-site.json');
    expect(downloadFilename("attachment; filename*=UTF-8''%invalid")).toBe(
      'PortFolio-site.json',
    );
  });
  it('removes path prefixes and control characters and always downloads a JSON name', () => {
    expect(
      downloadFilename('attachment; filename="../../network-export"'),
    ).toBe('network-export.json');
    expect(
      downloadFilename('attachment; filename="C:\\data\\network.json"'),
    ).toBe('network.json');
    expect(
      downloadFilename('attachment; filename="unsafe\u0000name.json"'),
    ).toBe('unsafename.json');
  });
});
