import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, sessionRequest, uploadAttachment } from '../api.js';
class FakeUpload {
  static latest: FakeUpload;
  upload = {
    onprogress: null as
      | null
      | ((event: {
          loaded: number;
          total: number;
          lengthComputable: boolean;
        }) => void),
  };
  headers: Record<string, string> = {};
  method = '';
  url = '';
  withCredentials = false;
  body: unknown;
  status = 201;
  responseText = '{"attachment":{"id":"file"}}';
  onload?: () => void;
  onabort?: () => void;
  onerror?: () => void;
  constructor() {
    FakeUpload.latest = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
}
afterEach(() => vi.unstubAllGlobals());
describe('authenticated attachment upload', () => {
  it('reuses session CSRF, sends raw bytes and reports progress without another session read', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        csrfToken: 'current-token',
        user: { id: 'user' },
      }),
    });
    const dispatchEvent = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('XMLHttpRequest', FakeUpload);
    await sessionRequest();
    const file = { name: 'photo.png', size: 8 } as File;
    const progress = vi.fn();
    const result = uploadAttachment(
      '/boards/b/attachments?ownerType=device&elementId=d',
      file,
      new AbortController().signal,
      progress,
    );
    const request = FakeUpload.latest;
    expect(request.headers).toEqual({
      'Content-Type': 'application/octet-stream',
      'x-csrf-token': 'current-token',
    });
    expect(request.body).toBe(file);
    expect(request.withCredentials).toBe(true);
    request.upload.onprogress?.({
      loaded: 4,
      total: 8,
      lengthComputable: true,
    });
    expect(progress).toHaveBeenCalledWith(4, 8);
    request.onload?.();
    await expect(result).resolves.toEqual({ attachment: { id: 'file' } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(dispatchEvent).toHaveBeenCalled();
  });
  it('cancels in flight and surfaces server errors', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeUpload);
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    const controller = new AbortController();
    const result = uploadAttachment(
      '/boards/b/attachments',
      { size: 1 } as File,
      controller.signal,
      vi.fn(),
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    const failure = uploadAttachment(
      '/boards/b/attachments',
      { size: 1 } as File,
      new AbortController().signal,
      vi.fn(),
    );
    FakeUpload.latest.status = 413;
    FakeUpload.latest.responseText = '{"error":{"message":"File too large"}}';
    FakeUpload.latest.onload?.();
    await expect(failure).rejects.toEqual(new ApiError('File too large', 413));
  });
});
