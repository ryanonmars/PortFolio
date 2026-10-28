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
