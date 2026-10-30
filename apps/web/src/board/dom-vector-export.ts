/** Convert the already laid-out board into portable, native SVG primitives.
 * Layout, wrapping and visible-field fitting come from the live renderer.
 */
export interface VectorExportOptions {
  padding?: number;
}
export function xml(value: string): string {
  // XML 1.0 excludes these control characters from text and attributes.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(
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
}
export function cssShadow(value: string): {
  color: string;
  x: number;
  y: number;
  blur: number;
  spread: number;
} | null {
  // Computed styles normalize the single outer shadow used by board containers.
  const match = value.match(
    /^(rgba?\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px(?:\s+(-?[\d.]+)px)?$/,
  );
  if (!match) return null;
  return {
    color: match[1]!,
    x: Number(match[2]),
    y: Number(match[3]),
    blur: Number(match[4]),
    spread: Number(match[5] ?? 0),
  };
}
const number = (value: number) => String(Math.round(value * 1000) / 1000);
const transparent = (value: string) =>
  !value || value === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(value);
const omitted =
  '.board-annotation-hit,.board-arrow-endpoint,.board-device-info-measure,.board-guide-layer,.board-cable-hit,.board-resize-handle,.board-port-grip,.board-port-layout-grid,.board-slot-grid,.board-slot,.board-port-summary,input,textarea,select';
const svgTags = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'title',
  'desc',
  'defs',
  'clipPath',
  'linearGradient',
  'radialGradient',
  'stop',
]);
const svgAttributes = new Set([
  'd',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'width',
  'height',
  'viewBox',
  'preserveAspectRatio',
  'points',
  'transform',
  'offset',
  'gradientUnits',
  'gradientTransform',
]);
const svgProperties = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'vector-effect',
  'paint-order',
  'stop-color',
  'stop-opacity',
] as const;

export function renderedBoardSvg(
  canvas: HTMLElement,
  options: VectorExportOptions = {},
): string {
  const world = canvas.querySelector<HTMLElement>('.board-world');
  if (!world) throw new Error('Board renderer is unavailable.');
  const origin = world.getBoundingClientRect();
  const scale = origin.width || 1;
  const position = (rect: DOMRect) => ({
    x: (rect.left - origin.left) / scale,
    y: (rect.top - origin.top) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  });
  const elements = [
    ...world.querySelectorAll<HTMLElement>('[data-board-element-id]'),
  ];
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  const include = (x: number, y: number, width: number, height: number) => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  };
  for (const element of elements) {
    const box = position(element.getBoundingClientRect());
    include(box.x, box.y, box.width, box.height);
    const shadow = cssShadow(getComputedStyle(element).boxShadow);
    if (shadow) {
      const extent = shadow.blur * 1.5 + shadow.spread;
      include(
        box.x + shadow.x - extent,
        box.y + shadow.y - extent,
        box.width + extent * 2,
        box.height + extent * 2,
      );
    }
  }
  for (const path of world.querySelectorAll<SVGGraphicsElement>(
    '.board-cable-line,.board-summary-link-line,.board-summary-link-head',
  )) {
    const rect = position(path.getBoundingClientRect());
    include(rect.x - 3, rect.y - 3, rect.width + 6, rect.height + 6);
  }
  for (const label of world.querySelectorAll<HTMLElement>(
    '.board-annotation-arrow .board-annotation-label',
  )) {
    const rect = position(label.getBoundingClientRect());
    include(rect.x, rect.y, rect.width, rect.height);
  }
  if (!Number.isFinite(left)) {
    left = 0;
    top = 0;
    right = 320;
    bottom = 200;
  }
  const padding = Math.max(0, options.padding ?? 24);
  left -= padding;
  top -= padding;
  right += padding;
  bottom += padding;
  const defs: string[] = [];
  let id = 0;
  const rectSvg = (
    x: number,
    y: number,
    width: number,
    height: number,
    extra = '',
  ) =>
    `<rect x="${number(x)}" y="${number(y)}" width="${number(Math.max(0, width))}" height="${number(Math.max(0, height))}" ${extra}/>`;
  const clip = (
    box: { x: number; y: number; width: number; height: number },
    radius = 0,
  ) => {
    const name = `board-export-clip-${++id}`;
    defs.push(
      `<clipPath id="${name}" clipPathUnits="userSpaceOnUse">${rectSvg(box.x, box.y, box.width, box.height, `rx="${number(radius)}"`)}</clipPath>`,
    );
    return name;
  };
  const measuringCanvas = document.createElement('canvas');
  const context = measuringCanvas.getContext('2d');
  function textNode(
    node: Text,
    parent: HTMLElement,
    style: CSSStyleDeclaration,
  ): string {
    if (!node.textContent?.trim()) return '';
    const range = document.createRange();
    const content = node.textContent;
    const fontSize = parseFloat(style.fontSize);
    const parentBox = position(parent.getBoundingClientRect());
    const lines: {
      text: string;
      x: number;
      y: number;
      right: number;
      height: number;
    }[] = [];
    if (style.whiteSpace === 'nowrap') {
      range.selectNodeContents(node);
      const box = position(range.getBoundingClientRect());
      if (box.width && box.height)
        lines.push({
          text: content,
          x: box.x,
          y: box.y,
          right: box.x + box.width,
          height: box.height,
        });
    } else {
      for (let index = 0; index < content.length; index++) {
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const box = position(rect);
        const last = lines.at(-1);
        if (last && Math.abs(last.y - box.y) < 0.5) {
          last.text += content[index];
          last.right = box.x + box.width;
        } else
          lines.push({
            text: content[index]!,
            x: box.x,
            y: box.y,
            right: box.x + box.width,
            height: box.height,
          });
      }
    }
    if (context)
      context.font = `${style.fontStyle} ${style.fontWeight} ${fontSize}px ${style.fontFamily}`;
    return lines
      .map((line) => {
        let value = line.text;
        if (
          style.display !== 'contents' &&
          style.textOverflow === 'ellipsis' &&
          (line.right > parentBox.x + parentBox.width + 0.5 ||
            parent.scrollWidth > parent.clientWidth) &&
          context
        ) {
          const available = Math.max(0, parentBox.x + parentBox.width - line.x);
          // Avoid repeated shaping of successively shorter long authored values.
          let low = 0,
            high = value.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            let prefixWidth = context.measureText(value.slice(0, middle)).width;
            if (style.whiteSpace === 'nowrap') {
              range.setStart(node, 0);
              range.setEnd(node, middle);
              prefixWidth = range.getBoundingClientRect().width / scale;
            }
            if (prefixWidth + context.measureText('…').width <= available)
              low = middle;
            else high = middle - 1;
          }
          value = value.slice(0, low) + '…';
        }
        const metrics = context?.measureText(value);
        const ascent =
          metrics && Number.isFinite(metrics.fontBoundingBoxAscent)
            ? metrics.fontBoundingBoxAscent
            : line.height * 0.8;
        return `<text x="${number(line.x)}" y="${number(line.y + ascent)}" fill="${xml(style.color)}" font-family="${xml(style.fontFamily)}" font-size="${number(fontSize)}" font-weight="${xml(style.fontWeight)}" font-style="${xml(style.fontStyle)}" letter-spacing="${xml(style.letterSpacing)}" xml:space="preserve">${xml(value)}</text>`;
      })
      .join('');
  }
  function nativeSvg(element: Element): string {
    if (!svgTags.has(element.tagName) || element.matches(omitted)) return '';
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return '';
    const attributes = [...element.attributes]
      .filter(
        (attribute) =>
          svgAttributes.has(attribute.name) &&
          !/url\(|javascript:|https?:/i.test(attribute.value),
      )
      .map((attribute) => `${attribute.name}="${xml(attribute.value)}"`);
    for (const property of svgProperties) {
      const value = style.getPropertyValue(property);
      if (value && !/url\(|javascript:|https?:/i.test(value))
        attributes.push(`${property}="${xml(value)}"`);
    }
    const children = [...element.childNodes]
      .map((child) =>
        child instanceof Element
          ? nativeSvg(child)
          : xml(child.textContent ?? ''),
      )
      .join('');
    return `<${element.tagName} ${attributes.join(' ')}>${children}</${element.tagName}>`;
  }
  function render(element: HTMLElement | SVGElement): string {
    if (element.matches(omitted)) return '';
    const style = getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    )
      return '';
    const box = position(element.getBoundingClientRect());
    if (element instanceof SVGElement) {
      const clone = nativeSvg(element);
      // A root SVG's own CSS supplies its placement and used dimensions.
      return `<svg x="${number(box.x)}" y="${number(box.y)}" width="${number(box.width)}" height="${number(box.height)}" overflow="visible"${element.hasAttribute('viewBox') ? ` viewBox="${xml(element.getAttribute('viewBox')!)}"` : ''}>${clone.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</svg>`;
    }
    // Boxless layout wrappers still have visible children (notably compact headers).
    const boxless = style.display === 'contents';
    if (!boxless && (!box.width || !box.height)) return '';
    let output = '';
    const radius = parseFloat(style.borderTopLeftRadius) || 0;
    if (!boxless) {
      const shadow = cssShadow(style.boxShadow);
      if (shadow && element.matches('[data-board-element-id]')) {
        const name = `board-export-shadow-${++id}`;
        const extent = shadow.blur * 1.5 + Math.abs(shadow.spread);
        defs.push(
          `<filter id="${name}" filterUnits="userSpaceOnUse" x="${number(box.x + Math.min(0, shadow.x) - extent)}" y="${number(box.y + Math.min(0, shadow.y) - extent)}" width="${number(box.width + Math.abs(shadow.x) + extent * 2)}" height="${number(box.height + Math.abs(shadow.y) + extent * 2)}"><feDropShadow dx="${number(shadow.x)}" dy="${number(shadow.y)}" stdDeviation="${number(shadow.blur / 2)}" flood-color="${xml(shadow.color)}"/></filter>`,
        );
        output += rectSvg(
          box.x,
          box.y,
          box.width,
          box.height,
          `rx="${radius}" fill="${xml(style.backgroundColor)}" filter="url(#${name})"`,
        );
      }
      if (!transparent(style.backgroundColor))
        output += rectSvg(
          box.x,
          box.y,
          box.width,
          box.height,
          `rx="${radius}" fill="${xml(style.backgroundColor)}"`,
        );
      const borders = ['Top', 'Right', 'Bottom', 'Left'] as const;
      const widths = borders.map(
        (side) => parseFloat(style[`border${side}Width`]) || 0,
      );
      const colors = borders.map((side) => style[`border${side}Color`]);
      if (
        widths.every((width) => width === widths[0]) &&
        colors.every((color) => color === colors[0]) &&
        widths[0]
      ) {
        const inset = widths[0] / 2;
        output += rectSvg(
          box.x + inset,
          box.y + inset,
          box.width - widths[0],
          box.height - widths[0],
          `rx="${Math.max(0, radius - inset)}" fill="none" stroke="${xml(colors[0]!)}" stroke-width="${widths[0]}"`,
        );
      } else
        borders.forEach((_, index) => {
          if (!widths[index] || transparent(colors[index]!)) return;
          const w = widths[index];
          const dimensions =
            index === 0
              ? [box.x, box.y, box.width, w]
              : index === 1
                ? [box.x + box.width - w, box.y, w, box.height]
                : index === 2
                  ? [box.x, box.y + box.height - w, box.width, w]
                  : [box.x, box.y, w, box.height];
          output += rectSvg(
            dimensions[0]!,
            dimensions[1]!,
            dimensions[2]!,
            dimensions[3]!,
            `fill="${xml(colors[index]!)}"`,
          );
        });
    }
    const children = [...element.childNodes];
    // CSS positioned stacking order matters, particularly the cable layer.
    const ordered = children
      .map((node, index) => ({
        node,
        index,
        z:
          node instanceof Element
            ? parseInt(getComputedStyle(node).zIndex) || 0
            : 0,
      }))
      .sort((a, b) => a.z - b.z || a.index - b.index);
    let contents = ordered
      .map(({ node }) =>
        node instanceof HTMLElement || node instanceof SVGElement
          ? render(node)
          : node instanceof Text
            ? textNode(node, element, style)
            : '',
      )
      .join('');
    if (
      !boxless &&
      (['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowX) ||
        ['hidden', 'auto', 'scroll', 'clip'].includes(style.overflowY))
    )
      contents = `<g clip-path="url(#${clip(box, radius)})">${contents}</g>`;
    const title = element.getAttribute('title');
    return `<g${style.opacity !== '1' ? ` opacity="${xml(style.opacity)}"` : ''}>${title ? `<title>${xml(title)}</title>` : ''}${output}${contents}</g>`;
  }
  const body = [...world.children]
    .sort(
      (a, b) =>
        (parseInt(getComputedStyle(a).zIndex) || 0) -
        (parseInt(getComputedStyle(b).zIndex) || 0),
    )
    .map((element) => render(element as HTMLElement))
    .join('');
  const backgroundElement = canvas.querySelector<HTMLElement>(
    '.board-canvas-background',
  );
  const backgroundStyle = getComputedStyle(backgroundElement ?? canvas);
  const background = backgroundStyle.backgroundColor;
  let grid = '';
  if (backgroundElement?.dataset.grid === 'true') {
    // The live CSS uses a radial dot centered in each world-space tile.
    const color = backgroundStyle.backgroundImage.match(/rgba?\([^)]+\)/)?.[0];
    const tile = parseFloat(backgroundStyle.backgroundSize) / scale;
    if (color && Number.isFinite(tile) && tile > 0) {
      defs.push(
        `<radialGradient id="board-export-dot"><stop offset="80%" stop-color="${xml(color)}"/><stop offset="100%" stop-color="${xml(color)}" stop-opacity="0"/></radialGradient><pattern id="board-export-grid" width="${number(tile)}" height="${number(tile)}" patternUnits="userSpaceOnUse"><circle cx="${number(tile / 2)}" cy="${number(tile / 2)}" r="1" fill="url(#board-export-dot)"/></pattern>`,
      );
      grid = rectSvg(
        left,
        top,
        right - left,
        bottom - top,
        'fill="url(#board-export-grid)"',
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${number(right - left)}" height="${number(bottom - top)}" viewBox="${number(left)} ${number(top)} ${number(right - left)} ${number(bottom - top)}" role="img" aria-label="PortFolio board" style="font-synthesis:none;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased"><defs>${defs.join('')}</defs>${rectSvg(left, top, right - left, bottom - top, `fill="${xml(background)}"`)}${grid}${body}</svg>`;
}
