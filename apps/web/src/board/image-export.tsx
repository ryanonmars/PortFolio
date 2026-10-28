import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { BoardDocument } from '../../../../packages/shared/src/board.js';
import { BoardCanvas } from './BoardCanvas.js';
import { renderedBoardSvg } from './dom-vector-export.js';
import './studio.css';

/** Export uses the same components, CSS and logical coordinates as the live board. */
export function exportSnapshot(document: BoardDocument): BoardDocument {
  return { ...structuredClone(document), viewport: { x: 0, y: 0, zoom: 1 } };
}

export async function boardImageSvg(document: BoardDocument): Promise<string> {
  const snapshot = exportSnapshot(document);
  const host = window.document.createElement('div');
  host.className = 'board-studio';
  host.inert = true;
  host.setAttribute('aria-hidden', 'true');
  // Keep layout measurable without covering the application or inheriting hidden styles.
  Object.assign(host.style, {
    position: 'fixed',
    left: '-1000000px',
    top: '0',
    width: '1000px',
    height: '800px',
    pointerEvents: 'none',
  });
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => {
      root.render(
        <BoardCanvas
          document={snapshot}
          selection={null}
          tool="select"
          disabled={false}
          onChange={() => {}}
          onSelect={() => {}}
        />,
      );
    });
    await window.document.fonts.ready;
    // Header fitting runs in a ResizeObserver and React's layout effects.
    // Wait for consecutive identical layouts, rather than guessing chip dimensions.
    let previous = '';
    let stable = 0;
    for (let frame = 0; frame < 12 && stable < 2; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const layout = host.innerHTML;
      stable = layout === previous ? stable + 1 : 0;
      previous = layout;
    }
    const canvas = host.querySelector<HTMLElement>('.board-canvas');
    if (!canvas) throw new Error('Unable to render the board for export.');
    return renderedBoardSvg(canvas);
  } finally {
    root.unmount();
    host.remove();
  }
}

export async function downloadBoardImage(
  document: BoardDocument,
  name: string,
  canDownload: () => boolean = () => true,
): Promise<void> {
  const svg = await boardImageSvg(document);
  if (!canDownload()) return;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${name.replace(/[^a-z0-9_-]/gi, '-') || 'board'}.svg`;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
