import { describe, expect, it } from 'vitest';
import {
  emptyBoardDocument,
  type BoardElement,
} from '../../../../packages/shared/src/board.js';
import { RJ45_SOCKET_PATH } from '../visual/Connector.js';
import { addPorts } from './commands.js';
import { boardImageSvg } from './image-export.js';
describe('clean board image export', () => {
  it('exports approved socket geometry and escaped authored labels without editing controls', () => {
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
    const svg = boardImageSvg(document);
    expect(svg).toContain(RJ45_SOCKET_PATH);
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('<script>');
    expect(svg).not.toContain('Resize');
    expect(svg).not.toContain('Object inspector');
    expect(svg).not.toContain('foreignObject');
  });
  it('uses only chosen network summary fields and preserves empty-board export', () => {
    const document = emptyBoardDocument();
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
    const svg = boardImageSvg(document);
    expect(svg).toContain('Servers');
    expect(svg).not.toContain('VLAN 20');
    expect(boardImageSvg(emptyBoardDocument())).toContain('<svg');
  });
});
