import { renderToStaticMarkup } from 'react-dom/server';
import {
  resolveBoardPortColor,
  networkEntrySummary,
  type BoardDocument,
} from '../../../../packages/shared/src/board.js';
import { Connector } from '../visual/Connector.js';
import { activeFace, cableCurve, getPortPoint, portRect } from './geometry.js';
const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[character]!,
  );
export function boardImageSvg(document: BoardDocument): string {
  const left = Math.min(0, ...document.elements.map((item) => item.x)) - 24;
  const top = Math.min(0, ...document.elements.map((item) => item.y)) - 24;
  const width =
    Math.max(600, ...document.elements.map((item) => item.x + item.width)) -
    left +
    24;
  const height =
    Math.max(400, ...document.elements.map((item) => item.y + item.height)) -
    top +
    24;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${left} ${top} ${width} ${height}"><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#0d1510"/>`;
  for (const element of [...document.elements].sort((a, b) => a.z - b.z)) {
    svg += `<g><rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="9" fill="${element.color || '#24332b'}" stroke="#526358"/><text x="${element.x + 16}" y="${element.y + 30}" fill="#edf1ed" font-family="Arial,sans-serif" font-size="17">${escape(element.name)}</text>`;
    if (
      element.type === 'network' &&
      Array.isArray(element.properties.entries)
    ) {
      element.properties.entries
        .slice(0, Math.max(0, Math.floor((element.height - 60) / 24)))
        .forEach((entry, index) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return;
          const line = networkEntrySummary(element, entry);
          svg += `<text x="${element.x + 16}" y="${element.y + 62 + index * 24}" fill="#c1d1c6" font-family="Arial,sans-serif" font-size="13">${escape(line)}</text>`;
        });
    }
    for (const port of document.ports.filter(
      (item) =>
        item.deviceId === element.id && item.face === activeFace(element),
    )) {
      const rect = portRect(element, port);
      const artwork = renderToStaticMarkup(
        <Connector
          kind={port.kind}
          color={resolveBoardPortColor(document, port)}
        />,
      ).replace('<svg ', '<svg width="64" height="60" ');
      svg += `<g transform="translate(${rect.x} ${rect.y})">${artwork}<text x="32" y="76" fill="#edf1ed" text-anchor="middle" font-family="Arial,sans-serif" font-size="11">${escape(port.name.length > 14 ? port.name.slice(0, 13) + '…' : port.name)}</text></g>`;
    }
    svg += '</g>';
  }
  if (document.showCables)
    for (const cable of document.cables) {
      const a = getPortPoint(document, cable.sourcePortId),
        b = getPortPoint(document, cable.targetPortId);
      if (a && b)
        svg += `<path d="${cableCurve(a, b)}" fill="none" stroke="${cable.color || '#b8c6d0'}" stroke-width="3" stroke-linecap="round"/>`;
    }
  return svg + '</svg>';
}
export function downloadBoardImage(document: BoardDocument, name: string) {
  const url = URL.createObjectURL(
    new Blob([boardImageSvg(document)], { type: 'image/svg+xml' }),
  );
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = `${name.replace(/[^a-z0-9_-]/gi, '-') || 'board'}.svg`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
