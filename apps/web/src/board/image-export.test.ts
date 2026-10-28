import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  emptyBoardDocument,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import { RJ45_SOCKET_PATH } from '../visual/Connector.js';
import { addPorts } from './commands.js';
import { exportSnapshot } from './image-export.js';
import { BoardCanvas } from './BoardCanvas.js';

describe('shared board image presentation', () => {
  it('freezes a logical-scale snapshot without changing saved layout or preferences', () => {
    const document = emptyBoardDocument();
    document.viewport = { x: 123, y: -700, zoom: 0.2 };
    document.elements.push({
      id: 'network',
      type: 'network',
      name: 'Network',
      x: -200,
      y: -100,
      width: 320,
      height: 220,
      z: 0,
      color: '',
      properties: {
        displayFields: ['name'],
        entries: [{ name: 'Servers', vlanId: '20' }],
      },
    });
    const before = JSON.stringify(document);
    const snapshot = exportSnapshot(document);
    expect(snapshot.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(snapshot.elements).toEqual(document.elements);
    snapshot.elements[0]!.name = 'Changed';
    expect(JSON.stringify(document)).toBe(before);
    expect(exportSnapshot(emptyBoardDocument()).elements).toEqual([]);
  });

  it('uses approved artwork and escaped labels from the actual board components', () => {
    const element: BoardElement = {
      id: 'device',
      type: 'device',
      name: '<script>alert(1)</script>',
      x: 100,
      y: 100,
      width: 320,
      height: 220,
      z: 0,
      color: '',
      properties: {},
    };
    const document = addPorts(
      { ...emptyBoardDocument(), elements: [element] },
      element.id,
      'rj45',
      1,
      'front',
    );
    document.ports[0]!.role = 'Router uplink';
    const html = renderToStaticMarkup(
      createElement(BoardCanvas, {
        document: exportSnapshot(document),
        selection: null,
        tool: 'select',
        disabled: false,
        onChange: () => {
          throw new Error('Export must not mutate the board');
        },
        onSelect: () => {},
      }),
    );
    expect(html).toContain(RJ45_SOCKET_PATH);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('Router uplink');
    expect(html).toContain('Front');
    expect(html).toContain('Rear');
    expect(html).not.toContain('board-resize-handle');
    expect(html).not.toContain('foreignObject');
  });
});
