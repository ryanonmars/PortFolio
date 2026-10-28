import { describe, it, expect } from 'vitest';
import { BoardSession } from './session.js';
import {
  emptyBoardDocument,
  type BoardRecord,
} from '../../../../packages/shared/src/board.js';
const board = (): BoardRecord => ({
  id: 'board',
  name: 'Lab',
  groupId: null,
  order: 0,
  rowVersion: 1,
  document: emptyBoardDocument(),
});
describe('board autosave queue', () => {
  it('serializes saves and acknowledges the submitted revision without losing later edits', async () => {
    let release!: (saved: BoardRecord) => void;
    const writes: number[] = [];
    const item = board();
    const session = new BoardSession(
      item.id,
      item,
      async (_id, document, version) => {
        writes.push(document.viewport.x);
        if (writes.length === 1)
          return new Promise((resolve) => {
            release = resolve;
          });
        return { ...item, document, rowVersion: version + 1 };
      },
      () => {},
      100000,
    );
    session.update(
      { ...session.document, viewport: { x: 10, y: 0, zoom: 1 } },
      'Viewport',
    );
    const saving = session.flush();
    session.update(
      { ...session.document, viewport: { x: 20, y: 0, zoom: 1 } },
      'Viewport',
    );
    release({ ...item, rowVersion: 2 });
    await saving;
    expect(writes).toEqual([10, 20]);
    expect(session.document.viewport.x).toBe(20);
    expect(session.rowVersion).toBe(3);
    expect(session.dirty).toBe(false);
    session.dispose();
  });
  it('retains unsaved edits after failures and does not silently rebase', async () => {
    const item = board();
    let fail = true;
    const session = new BoardSession(
      item.id,
      item,
      async (_id, document, version) => {
        if (fail) throw new Error('Conflict');
        return { ...item, document, rowVersion: version + 1 };
      },
      () => {},
      100000,
    );
    session.update({ ...session.document, grid: false });
    await expect(session.flush()).rejects.toThrow('Conflict');
    expect(session.state).toBe('error');
    expect(session.dirty).toBe(true);
    expect(session.document.grid).toBe(false);
    fail = false;
    await session.retry();
    expect(session.dirty).toBe(false);
    session.dispose();
  });
  it('undo and redo restore significant changes through the same persistence queue', async () => {
    const item = board();
    const session = new BoardSession(
      item.id,
      item,
      async (_id, document, version) => ({
        ...item,
        document,
        rowVersion: version + 1,
      }),
      () => {},
      100000,
    );
    session.update({ ...session.document, grid: false }, 'Edit');
    session.undo();
    expect(session.document.grid).toBe(true);
    session.redo();
    expect(session.document.grid).toBe(false);
    await session.flush();
    expect(session.state).toBe('saved');
    session.dispose();
  });
});

describe('board replacement and typing history', () => {
  it('refuses replacement while an older write is still in flight, even with newer queued edits', async () => {
    const item = board();
    let release!: (value: BoardRecord) => void;
    let calls = 0;
    const session = new BoardSession(
      item.id,
      item,
      async (_id, document, version) => {
        if (++calls === 1)
          return new Promise((resolve) => {
            release = resolve;
          });
        return { ...item, document, rowVersion: version + 1 };
      },
      () => {},
      100000,
    );
    session.update({ ...session.document, grid: false });
    const saving = session.flush();
    session.update({ ...session.document, showCables: false });
    expect(session.state).toBe('unsaved');
    expect(session.saving).toBe(true);
    expect(session.pause()).toBe(false);
    expect(() => session.replace(item)).toThrow('current save');
    release({ ...item, rowVersion: 2 });
    await saving;
    expect(session.document.grid).toBe(false);
    expect(session.document.showCables).toBe(false);
    expect(session.rowVersion).toBe(3);
    session.dispose();
  });
  it('suspends pending debounce during explicit reload and rejects edits until resumed', async () => {
    const item = board();
    let writes = 0;
    const session = new BoardSession(
      item.id,
      item,
      async (_id, document) => {
        writes++;
        return { ...item, document, rowVersion: 2 };
      },
      () => {},
      5,
    );
    session.update({ ...session.document, grid: false });
    expect(session.pause()).toBe(true);
    expect(() =>
      session.update({ ...session.document, showCables: false }),
    ).toThrow('loading');
    await expect(session.flush()).rejects.toThrow('loading');
    session.replace({ ...item, rowVersion: 9 });
    session.resume();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(writes).toBe(0);
    expect(session.document.grid).toBe(true);
    expect(session.rowVersion).toBe(9);
    session.dispose();
  });
  it('undoes a continuous property edit as one change and redoes the full text', () => {
    const item = board();
    item.document.elements.push({
      id: 'device',
      type: 'device',
      name: 'Switch',
      x: 0,
      y: 0,
      width: 160,
      height: 120,
      z: 0,
      color: '',
      properties: {},
    });
    const session = new BoardSession(
      item.id,
      item,
      async () => item,
      () => {},
      100000,
    );
    for (const name of ['W', 'WA', 'WAN'])
      session.update(
        {
          ...session.document,
          elements: [{ ...session.document.elements[0]!, name }],
        },
        'Property:device:name',
      );
    session.undo();
    expect(session.document.elements[0]!.name).toBe('Switch');
    session.redo();
    expect(session.document.elements[0]!.name).toBe('WAN');
    session.dispose();
  });
});
