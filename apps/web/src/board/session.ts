import type {
  BoardDocument,
  BoardRecord,
} from '../../../../packages/shared/src/board.js';

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'error';
type Transport = (
  id: string,
  document: BoardDocument,
  rowVersion: number,
) => Promise<BoardRecord>;

/** One serialized optimistic queue per open board. Acknowledgements never replace newer edits. */
export class BoardSession {
  document: BoardDocument;
  rowVersion: number;
  state: SaveState = 'saved';
  error = '';
  private revision = 0;
  private acknowledged = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: Promise<void> | undefined;
  private disposed = false;
  private paused = false;
  private lastProperty = '';
  private lastPropertyAt = 0;
  private past: BoardDocument[] = [];
  private future: BoardDocument[] = [];
  constructor(
    readonly id: string,
    board: BoardRecord,
    private transport: Transport,
    private notify: () => void,
    private delay = 450,
  ) {
    this.document = structuredClone(board.document);
    this.rowVersion = board.rowVersion;
  }
  get saving() {
    return Boolean(this.flight);
  }
  pause(): boolean {
    if (this.flight) return false;
    this.paused = true;
    clearTimeout(this.timer);
    return true;
  }
  resume() {
    this.paused = false;
    if (this.dirty && this.state !== 'error' && !this.disposed)
      this.timer = setTimeout(() => {
        void this.flush().catch(() => {});
      }, this.delay);
  }
  get dirty() {
    return this.revision !== this.acknowledged;
  }
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  update(document: BoardDocument, label = 'Edit') {
    if (this.paused) throw new Error('Wait for the board to finish loading');
    if (JSON.stringify(document) === JSON.stringify(this.document)) return;
    if (label !== 'Viewport' && label !== 'Display') {
      const coalesced =
        label.startsWith('Property:') &&
        this.lastProperty === label &&
        Date.now() - this.lastPropertyAt < 1200;
      if (!coalesced) this.past.push(structuredClone(this.document));
      this.lastProperty = label;
      this.lastPropertyAt = Date.now();
      if (this.past.length > 40) this.past.shift();
      this.future = [];
    }
    this.document = structuredClone(document);
    this.revision++;
    if (this.state !== 'error') this.state = 'unsaved';
    this.changed();
    clearTimeout(this.timer);
    if (this.state !== 'error')
      this.timer = setTimeout(() => {
        void this.flush().catch(() => {});
      }, this.delay);
  }
  undo() {
    if (this.paused) return;
    this.lastProperty = '';
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(structuredClone(this.document));
    this.update({ ...previous, viewport: this.document.viewport }, 'Display');
  }
  redo() {
    if (this.paused) return;
    this.lastProperty = '';
    const next = this.future.pop();
    if (!next) return;
    this.past.push(structuredClone(this.document));
    this.update({ ...next, viewport: this.document.viewport }, 'Display');
  }
  flush(): Promise<void> {
    if (this.paused) return Promise.reject(new Error('Board is loading'));
    clearTimeout(this.timer);
    if (this.flight) return this.flight;
    if (this.state === 'error') return Promise.reject(new Error(this.error));
    if (!this.dirty) return Promise.resolve();
    this.flight = this.drain().finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }
  retry() {
    this.error = '';
    this.state = this.dirty ? 'unsaved' : 'saved';
    return this.flush();
  }
  replace(board: BoardRecord) {
    if (this.flight)
      throw new Error('Wait for the current save before reloading');
    this.lastProperty = '';
    clearTimeout(this.timer);
    this.document = structuredClone(board.document);
    this.rowVersion = board.rowVersion;
    this.revision = 0;
    this.acknowledged = 0;
    this.past = [];
    this.future = [];
    this.error = '';
    this.state = 'saved';
    this.changed();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
  }
  private changed() {
    if (!this.disposed) this.notify();
  }
  private async drain() {
    while (this.dirty) {
      const revision = this.revision;
      const submitted = structuredClone(this.document);
      this.state = 'saving';
      this.changed();
      try {
        const saved = await this.transport(this.id, submitted, this.rowVersion);
        this.rowVersion = saved.rowVersion;
        this.acknowledged = revision;
        this.state = this.dirty ? 'unsaved' : 'saved';
        this.error = '';
        this.changed();
      } catch (cause) {
        this.state = 'error';
        this.error =
          cause instanceof Error ? cause.message : 'Unable to save board';
        this.changed();
        throw cause;
      }
    }
  }
}
