import type { Session } from '../../../packages/shared/src/index.js';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

let csrfToken = '';

export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers:
      method === 'GET'
        ? {}
        : { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (
    response.ok &&
    !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
    !path.startsWith('/auth/')
  )
    window.dispatchEvent(new Event('portfolio:changed'));
  if (response.status === 204) return undefined as T;
  const result = await response.json();
  if (
    response.status === 403 &&
    result.error?.code === 'INVALID_CSRF' &&
    !path.startsWith('/auth/')
  ) {
    const latestSession = await sessionRequest();
    if (!latestSession.user)
      window.dispatchEvent(new Event('portfolio:unauthorized'));
  }
  if (response.status === 401 && !path.startsWith('/auth/'))
    window.dispatchEvent(new Event('portfolio:unauthorized'));
  if (!response.ok)
    throw new ApiError(
      result.error?.message ?? 'The request could not be completed.',
      response.status,
      result.error?.fieldErrors,
    );
  return result as T;
}

export async function sessionRequest(
  path = '/auth/session',
  body?: unknown,
): Promise<Session> {
  const session = await api<Session>(path, body ? 'POST' : 'GET', body);
  csrfToken = session.csrfToken;
  return session;
}

/** Raw uploads share the authenticated session's CSRF token; no per-file session request. */
export function uploadAttachment<T>(
  path: string,
  file: File,
  signal: AbortSignal,
  onProgress: (sent: number, total: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    request.open('POST', `/api/v1${path}`);
    request.withCredentials = true;
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('x-csrf-token', csrfToken);
    request.upload.onprogress = (event) =>
      onProgress(
        event.loaded,
        event.lengthComputable ? event.total : file.size,
      );
    request.onerror = () => {
      cleanup();
      reject(new Error('Upload failed. Check your connection and retry.'));
    };
    request.onabort = () => {
      cleanup();
      reject(new DOMException('Upload cancelled.', 'AbortError'));
    };
    request.onload = () => {
      cleanup();
      let result: {
        error?: {
          message?: string;
          code?: string;
          fieldErrors?: Record<string, string[]>;
        };
      };
      try {
        result = JSON.parse(request.responseText);
      } catch {
        reject(
          new Error(
            'The upload response could not be read. Refresh attachments before retrying.',
          ),
        );
        return;
      }
      if (request.status >= 200 && request.status < 300) {
        window.dispatchEvent(new Event('portfolio:changed'));
        resolve(result as T);
      } else {
        if (request.status === 401)
          window.dispatchEvent(new Event('portfolio:unauthorized'));
        if (request.status === 403 && result.error?.code === 'INVALID_CSRF')
          void sessionRequest()
            .then((session) => {
              if (!session.user)
                window.dispatchEvent(new Event('portfolio:unauthorized'));
            })
            .catch(() => {});
        reject(
          new ApiError(
            result.error?.message ?? 'The file could not be uploaded.',
            request.status,
            result.error?.fieldErrors,
          ),
        );
      }
    };
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled.', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    request.send(file);
  });
}
