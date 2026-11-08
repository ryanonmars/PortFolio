import { useState } from 'react';
import type { BoardDocument } from '../../../../packages/shared/src/board.js';
import { deviceItems, networkItems, type BoardPage } from './detail-model.js';
import './detail-pages.css';
interface Props {
  document: BoardDocument;
  page: BoardPage;
  onNavigate: (page: BoardPage) => void;
  disabled?: boolean;
}
export function BoardObjectTree({
  document,
  page,
  onNavigate,
  disabled,
}: Props) {
  const networks = networkItems(document);
  const devices = deviceItems(document);
  const [open, setOpen] = useState<{
    networks: boolean | null;
    devices: boolean | null;
  }>({ networks: null, devices: null });
  const [limit, setLimit] = useState({ networks: 32, devices: 32 });
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const categories = [
    {
      kind: 'networks' as const,
      title: 'Networks',
      items: networks.map((item) => ({
        key: JSON.stringify([item.container.id, item.entryId]),
        name: item.label,
        page: {
          kind: 'network',
          containerId: item.container.id,
          entryId: item.entryId,
        } as BoardPage,
        selected:
          page.kind === 'network' &&
          page.containerId === item.container.id &&
          page.entryId === item.entryId,
      })),
    },
    {
      kind: 'devices' as const,
      title: 'Devices',
      items: devices.map((item) => ({
        key: item.id,
        name: item.name || 'Unnamed device',
        page: { kind: 'device', deviceId: item.id } as BoardPage,
        selected: page.kind === 'device' && page.deviceId === item.id,
      })),
    },
  ];
  return (
    <div className="board-object-tree">
      {networks.length + devices.length > 32 && (
        <input
          type="search"
          className="object-tree-filter"
          aria-label="Filter board objects"
          placeholder="Filter objects…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={disabled}
        />
      )}
      {categories
        .filter((category) => category.items.length)
        .map((category) => {
          const items = category.items.filter(
            (item) => !query || item.name.toLowerCase().includes(query),
          );
          const visible = items.slice(0, limit[category.kind]);
          const selected = items.find((item) => item.selected);
          if (selected && !visible.some((item) => item.key === selected.key))
            visible.push(selected);
          const expanded =
            !!query ||
            (open[category.kind] ??
              (page.kind === category.kind ||
                category.items.some((item) => item.selected)));
          return (
            <section className="object-tree-category" key={category.kind}>
              <div className="object-tree-category-row">
                <button
                  className="object-tree-disclosure"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${category.kind}`}
                  aria-expanded={expanded}
                  onClick={() =>
                    setOpen((previous) => ({
                      ...previous,
                      [category.kind]: !expanded,
                    }))
                  }
                  disabled={disabled}
                >
                  <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                </button>
                <button
                  className="object-tree-category-link"
                  aria-label={category.title}
                  aria-current={
                    page.kind === category.kind ? 'page' : undefined
                  }
                  onClick={() => onNavigate({ kind: category.kind })}
                  disabled={disabled}
                >
                  {category.title}
                  <span>{category.items.length}</span>
                </button>
              </div>
              {expanded && (
                <ul>
                  {visible.map((item) => (
                    <li key={item.key}>
                      <button
                        title={item.name}
                        aria-current={item.selected ? 'page' : undefined}
                        onClick={() => onNavigate(item.page)}
                        disabled={disabled}
                      >
                        {item.name}
                      </button>
                    </li>
                  ))}
                  {items.length > limit[category.kind] && (
                    <li>
                      <button
                        className="object-tree-more"
                        onClick={() =>
                          setLimit((previous) => ({
                            ...previous,
                            [category.kind]: previous[category.kind] + 32,
                          }))
                        }
                        disabled={disabled}
                      >
                        Show more {category.kind}
                      </button>
                    </li>
                  )}
                  {!items.length && (
                    <li className="object-tree-empty">No matches</li>
                  )}
                </ul>
              )}
            </section>
          );
        })}
    </div>
  );
}
