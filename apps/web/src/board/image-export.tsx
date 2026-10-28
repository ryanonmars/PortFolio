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
import {
  deviceHeaderFields,
  fitDeviceHeaderFields,
} from './device-header-fields.js';
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
    svg += `<g><rect x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="9" fill="${element.color || '#24332b'}" stroke="#526358"/>`;
    if (element.type === 'device') {
      const clip = `device-title-${document.elements.indexOf(element)}`;
      const titleWidth = Math.max(0, element.width - 34);
      const limit = Math.max(1, Math.floor(titleWidth / 9));
      const title =
        element.name.length > limit
          ? element.name.slice(0, Math.max(0, limit - 1)) + '…'
          : element.name;
      svg += `<title>${escape(element.name)}</title><defs><clipPath id="${clip}"><rect x="${element.x + 16}" y="${element.y + 8}" width="${titleWidth}" height="26"/></clipPath></defs><text clip-path="url(#${clip})" x="${element.x + 16}" y="${element.y + 30}" fill="#edf1ed" font-family="Arial,sans-serif" font-size="17">${escape(title)}</text>`;
    } else
      svg += `<text x="${element.x + 16}" y="${element.y + 30}" fill="#edf1ed" font-family="Arial,sans-serif" font-size="17">${escape(element.name)}</text>`;
    if (element.type === 'device') {
      const fields = deviceHeaderFields(
        element,
        document.ports.filter((port) => port.deviceId === element.id).length,
      );
      const contentWidth = Math.max(0, element.width - 34);
      const fitted = fitDeviceHeaderFields(
        fields.map((field) => ({
          ideal: (field.label.length + field.value.length) * 5.2 + 17,
          minimum: Math.min(field.label.length * 5.2, 80) + 31,
        })),
        contentWidth,
      );
      for (const placement of fitted) {
        const field = fields[placement.index]!;
        const x = element.x + 16 + placement.x,
          y = element.y + 41 + placement.y;
        const full = `${field.label}: ${field.value}`;
        const maxCharacters = Math.max(
          1,
          Math.floor((placement.width - 12) / 5.2),
        );
        const shown =
          full.length > maxCharacters
            ? full.slice(0, Math.max(0, maxCharacters - 1)) + '…'
            : full;
        const clip = `header-field-${document.elements.indexOf(element)}-${placement.index}`;
        svg += `<g><title>${escape(full)}</title><rect x="${x}" y="${y}" width="${placement.width}" height="16" rx="5" fill="#14221b"/><defs><clipPath id="${clip}"><rect x="${x + 5}" y="${y}" width="${Math.max(0, placement.width - 10)}" height="16"/></clipPath></defs><text clip-path="url(#${clip})" x="${x + 6}" y="${y + 11.5}" fill="#d4e3d9" font-family="Arial,sans-serif" font-size="10">${escape(shown)}</text></g>`;
      }
    }
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
