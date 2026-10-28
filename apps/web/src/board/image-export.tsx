import { renderToStaticMarkup } from 'react-dom/server';
import {
  resolveBoardPortColor,
  type BoardDocument,
} from '../../../../packages/shared/src/board.js';
import {
  networkDisplayValue,
  networkPresentation,
  networkPresentationLines,
} from './network-presentation.js';
import { Connector } from '../visual/Connector.js';
import { activeFace, portRect } from './geometry.js';
import { routeBoardCable } from './cable-routing.js';
import { cableProtectedRegions, cablePaintBounds } from './cable-rendering.js';
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
  const routes = document.showCables
    ? document.cables
        .map((cable) => ({ cable, route: routeBoardCable(document, cable) }))
        .filter((item) => item.route !== null)
    : [];
  const bounds = cablePaintBounds(
    document,
    routes.flatMap(({ route }) => route?.points ?? []),
  );
  const left = bounds.x,
    top = bounds.y;
  const width = Math.max(600, bounds.width),
    height = Math.max(400, bounds.height);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${left} ${top} ${width} ${height}"><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#0d1510"/>`;
  for (const element of [...document.elements].sort((a, b) => a.z - b.z)) {
    svg += `<g><rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="9" fill="${element.color || '#24332b'}" stroke="#526358"/><text x="${element.x + 16}" y="${element.y + 30}" fill="#edf1ed" font-family="Arial,sans-serif" font-size="17">${escape(element.name)}</text>`;
    if (
      element.type === 'network' &&
      Array.isArray(element.properties.entries)
    ) {
      const clipId = `network-summary-${document.elements.indexOf(element)}`;
      const maxColumns = Math.max(1, Math.floor((element.width - 32) / 6.5));
      const lines: string[] = [];
      for (const entry of element.properties.entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          continue;
        const presentation = networkPresentation(element, entry);
        if (!presentation) continue;
        if (lines.length) lines.push('');
        for (const line of networkPresentationLines(presentation))
          for (const paragraph of line.split('\n')) {
            const characters = Array.from(paragraph);
            for (
              let offset = 0;
              offset < characters.length;
              offset += maxColumns
            )
              lines.push(
                characters.slice(offset, offset + maxColumns).join(''),
              );
          }
      }
      const notes = networkDisplayValue(element.properties.notes);
      if (notes)
        for (const paragraph of notes.split('\n')) {
          const characters = Array.from(paragraph);
          for (let offset = 0; offset < characters.length; offset += maxColumns)
            lines.push(characters.slice(offset, offset + maxColumns).join(''));
        }
      svg += `<defs><clipPath id="${clipId}"><rect x="${element.x + 12}" y="${element.y + 48}" width="${element.width - 24}" height="${Math.max(0, element.height - 60)}"/></clipPath></defs><g clip-path="url(#${clipId})">`;
      lines
        .slice(0, Math.max(0, Math.floor((element.height - 60) / 18)))
        .forEach((line, index) => {
          svg += `<text x="${element.x + 16}" y="${element.y + 62 + index * 18}" fill="#c1d1c6" font-family="Arial,sans-serif" font-size="12">${escape(line)}</text>`;
        });
      svg += '</g>';
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
      const labelClip = `port-label-${document.ports.indexOf(port)}`;
      svg += `<g transform="translate(${rect.x} ${rect.y})">${artwork}<defs><clipPath id="${labelClip}"><rect x="0" y="61" width="64" height="31"/></clipPath></defs><text clip-path="url(#${labelClip})" x="32" y="76" fill="#edf1ed" text-anchor="middle" font-family="Arial,sans-serif" font-size="11">${escape(port.name.length > 14 ? port.name.slice(0, 13) + '…' : port.name)}</text></g>`;
    }
    svg += '</g>';
  }
  if (routes.length) {
    svg += `<defs><mask id="portfolio-cable-protection" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" style="mask-type:luminance"><rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="white"/>`;
    for (const region of cableProtectedRegions(document))
      svg += `<rect class="board-cable-protected-${region.kind}" x="${region.x}" y="${region.y}" width="${region.width}" height="${region.height}" fill="black"/>`;
    svg += '</mask></defs><g mask="url(#portfolio-cable-protection)">';
    for (const { cable, route } of routes)
      if (route)
        svg += `<path d="${escape(route.path)}" fill="none" stroke="${escape(cable.color || '#b8c6d0')}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    svg += '</g>';
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
