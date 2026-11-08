import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  boardImportSchema,
  emptyBoardDocument,
  remapBoardDocument,
} from '../../../../packages/shared/src/board.js';
import { BoardInspector } from './BoardInspector.js';
import { NetworkSummary } from './NetworkSummary.js';

function fixture() {
  const document = emptyBoardDocument();
  document.elements.push({
    id: 'network',
    type: 'network',
    name: 'Network',
    x: 13,
    y: -20,
    width: 760,
    height: 240,
    z: 0,
    color: '',
    properties: {
      displayFields: ['vlanId', 'vlanName', 'subnet', 'gateway'],
      entries: [
        {
          vlanId: '20',
          vlanName: 'Servers',
          subnet: '192.0.2.0/25',
          gateway: 'authored gateway',
        },
      ],
    },
  });
  return document;
}
it('offers only layout controls in the existing container inspector without adding entry navigation', () => {
  const document = fixture();
  const html = renderToStaticMarkup(
    createElement(BoardInspector, {
      document,
      selection: { type: 'element', id: 'network' },
      onChange: () => {},
      onClose: () => {},
      onDelete: () => {},
      onDuplicate: () => {},
    }),
  );
  expect(html).toContain('aria-label="Network display mode"');
  expect(html).toContain('value="compact" selected=""');
  expect(html).toContain('Network container name');
  expect(html).not.toContain('Back to container');
  expect(html).not.toContain('Show network summary');
});
it('exposes the optional detailed summary without changing existing editing controls', () => {
  const document = fixture();
  document.elements[0]!.properties.displayMode = 'detailed';
  const html = renderToStaticMarkup(
    createElement(BoardInspector, {
      document,
      selection: { type: 'element', id: 'network' },
      onChange: () => {},
      onClose: () => {},
      onDelete: () => {},
      onDuplicate: () => {},
    }),
  );
  expect(html).toContain('value="detailed" selected=""');
  expect(html).toContain('aria-label="Show network summary"');
  expect(html).toContain('aria-label="Gateway"');
  expect(html).toContain('Visible fields');
  expect(html).not.toContain('Back to container');
});
it('keeps absent, compact and unknown layout preferences identical without row controls', () => {
  const element = fixture().elements[0]!;
  const render = () =>
    renderToStaticMarkup(createElement(NetworkSummary, { element }));
  const before = render();
  for (const displayMode of ['compact', 'unknown']) {
    element.properties.displayMode = displayMode;
    expect(render()).toBe(before);
  }
  expect(before).not.toContain('role="button"');
  expect(before).not.toContain('<details');
});
it('preserves selected layout and authored values through JSON import/remapping without changing dimensions', () => {
  const document = fixture();
  document.elements[0]!.properties.displayMode = 'detailed';
  document.elements[0]!.properties.showNetworkSummary = false;
  const imported = boardImportSchema.parse(
    JSON.parse(
      JSON.stringify({
        format: 'portfolio-board',
        schemaVersion: 1,
        name: 'Imported',
        document,
      }),
    ),
  );
  const remapped = remapBoardDocument(imported.document);
  expect(remapped.elements[0]!.properties).toEqual(
    document.elements[0]!.properties,
  );
  expect(remapped.elements[0]!.width).toBe(760);
  expect(remapped.elements[0]!.height).toBe(240);
  expect(remapped.ports).toEqual(document.ports);
  expect(remapped.cables).toEqual(document.cables);
});
