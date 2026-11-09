import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface Configuration {
  baseUrl: URL;
  token: string;
  timeoutMs: number;
  allowPrivateHttp: boolean;
  diagnostics?: boolean;
}
export function loadConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Configuration {
  let baseUrl: URL;
  try {
    baseUrl = new URL(env.PORTFOLIO_API_URL ?? '');
  } catch {
    throw new Error('PORTFOLIO_API_URL must be an absolute HTTPS URL');
  }
  const allowPrivateHttp = env.PORTFOLIO_ALLOW_PRIVATE_HTTP === 'true';
  if (
    !['https:', 'http:'].includes(baseUrl.protocol) ||
    (baseUrl.protocol === 'http:' && !allowPrivateHttp) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    /[?#]/.test(env.PORTFOLIO_API_URL ?? '')
  )
    throw new Error(
      'Use HTTPS, or explicitly enable private HTTP; URL credentials, queries and fragments are forbidden',
    );
  const token = env.PORTFOLIO_API_TOKEN;
  if (!token || !/^[\x21-\x7e]+$/.test(token))
    throw new Error('PORTFOLIO_API_TOKEN must be a nonempty printable token');
  const timeoutMs = Number(env.PORTFOLIO_REQUEST_TIMEOUT_MS ?? 15000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
    throw new Error(
      'PORTFOLIO_REQUEST_TIMEOUT_MS must be between 100 and 120000',
    );
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  return {
    baseUrl,
    token,
    timeoutMs,
    allowPrivateHttp,
    diagnostics: env.PORTFOLIO_MCP_DIAGNOSTICS === 'true',
  };
}
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a = -1, b = -1] = ip.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return isIP(ip) === 6 && (ip === '::1' || /^(fc|fd)[0-9a-f]{2}:/.test(ip));
}
const safeApiErrors: Record<string, string> = {
  VALIDATION_ERROR: 'Check the supplied fields against the tool schema.',
  INVALID_BOARD_EDIT:
    'The command batch failed graph or identity validation; reread the board and check referenced IDs, slot positions and geometry.',
  CONFLICT:
    'The board changed; reread its current rowVersion and review the intended changes before retrying.',
  VERSION_CONFLICT:
    'The board changed; reread its current rowVersion and review the intended changes before retrying.',
  STALE_VERSION:
    'The board changed; reread its current rowVersion and review the intended changes before retrying.',
  PROPOSAL_CHANGED:
    'The proposal digest changed; validate and review a new proposal.',
  PREVIEW_CHANGED:
    'The generated preview changed; validate again and obtain approval of the new preview before applying.',
  PROPOSAL_EXPIRED:
    'The preview expired; validate it again and obtain approval of the new preview.',
  PROPOSAL_INVALID:
    'The saved proposal is invalid; validate and review a new proposal.',
  ALREADY_APPLIED:
    'This proposal was already applied with a different idempotency key. Read the board instead of creating another.',
  IDEMPOTENCY_CONFLICT:
    'The idempotency key belongs to another proposal. Do not reuse it for different work.',
  IMPORTED_BOARD_REMOVED:
    'The imported board was removed; this retry will not recreate it.',
  PROPOSAL_LIMIT:
    'Too many pending previews; wait for an existing preview to expire.',
  NOT_FOUND:
    'The requested object is absent or outside the token scope; verify board and nested object IDs.',
};
function apiFailure(status: number, body: unknown): Error {
  const error =
    body && typeof body === 'object' && 'error' in body
      ? body.error
      : undefined;
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    Object.hasOwn(safeApiErrors, error.code)
      ? error.code
      : undefined;
  const fallback =
    status === 401
      ? 'Check the API token and its expiry or revocation.'
      : status === 403
        ? 'This token is not permitted to perform this operation.'
        : status === 409
          ? 'State changed; reread and review before retrying.'
          : status === 429
            ? 'Rate limit reached; wait before explicitly retrying.'
            : 'Check the request and server availability.';
  const fieldErrors =
    error &&
    typeof error === 'object' &&
    'fieldErrors' in error &&
    error.fieldErrors &&
    typeof error.fieldErrors === 'object'
      ? error.fieldErrors
      : {};
  const allowedFields = new Set([
    'boardId',
    'deviceId',
    'elementId',
    'entryId',
    'portId',
    'proposal',
    'proposalId',
    'digest',
    'idempotencyKey',
    'approved',
    'rowVersion',
    'commands',
  ]);
  const fields = Object.keys(fieldErrors).filter((key) =>
    allowedFields.has(key),
  );
  return new Error(
    `PortFolio API returned HTTP ${status}${code ? ` (${code})` : ''}: ${code ? safeApiErrors[code] : fallback}${fields.length ? ` Check fields: ${fields.join(', ')}.` : ''}`,
  );
}

/** HTTP-only bridge. No database, filesystem access, redirects or automatic retries. */
export class PortfolioClient {
  constructor(private readonly configuration: Configuration) {}
  async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const started = Date.now();
    let status: number | 'error' = 'error';
    try {
      return await this.send(method, path, body, (value) => {
        status = value;
      });
    } finally {
      if (this.configuration.diagnostics)
        process.stderr.write(
          JSON.stringify({
            component: 'portfolio-mcp',
            method,
            status,
            durationMs: Date.now() - started,
          }) + '\n',
        );
    }
  }
  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    reportStatus: (status: number) => void,
  ): Promise<unknown> {
    const { baseUrl, token, timeoutMs } = this.configuration;
    const started = Date.now();
    const url = new URL(`api/v1/integration${path}`, baseUrl);
    let address: { address: string; family: number } | undefined;
    if (url.protocol === 'http:') {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      let dnsTimer: NodeJS.Timeout | undefined;
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await Promise.race([
            lookup(hostname, { all: true }).catch(() => {
              throw new Error('Private HTTP hostname could not be resolved');
            }),
            new Promise<never>((_, reject) => {
              dnsTimer = setTimeout(
                () => reject(new Error('PortFolio request timed out')),
                timeoutMs,
              );
              dnsTimer.unref();
            }),
          ]).finally(() => clearTimeout(dnsTimer));
      if (
        !addresses.length ||
        addresses.some((entry) => !isPrivateAddress(entry.address))
      )
        throw new Error(
          'HTTP is allowed only for private or loopback addresses',
        );
      address = addresses.find((entry) => entry.family === 4) ?? addresses[0];
    }
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      if (payload && Buffer.byteLength(payload) > 8 * 1024 * 1024) {
        reject(new Error('PortFolio request body is too large'));
        return;
      }
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method,
          ...(address ? { family: address.family } : {}),
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(payload
              ? {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }
              : {}),
          },
          // Pin the validated DNS answer so private HTTP cannot rebind to a public IP.
          ...(address
            ? {
                lookup: (_hostname, _options, callback) =>
                  callback(null, address!.address, address!.family),
              }
            : {}),
        },
        (response) => {
          reportStatus(response.statusCode ?? 500);
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400
          ) {
            response.resume();
            reject(new Error('PortFolio redirects are forbidden'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          const success =
            !!response.statusCode &&
            response.statusCode >= 200 &&
            response.statusCode < 300;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > (success ? 12 * 1024 * 1024 : 16384)) {
              request.destroy();
              reject(
                success
                  ? new Error('PortFolio response is too large')
                  : apiFailure(response.statusCode ?? 500, undefined),
              );
            } else chunks.push(chunk);
          });
          response.on('end', () => {
            let result: unknown;
            try {
              result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              reject(
                success
                  ? new Error('PortFolio API returned invalid JSON')
                  : apiFailure(response.statusCode ?? 500, undefined),
              );
              return;
            }
            if (success) resolve(result);
            else reject(apiFailure(response.statusCode ?? 500, result));
          });
          response.on('error', () =>
            reject(new Error('PortFolio response could not be read')),
          );
        },
      );
      const timer = setTimeout(
        () => {
          reject(new Error('PortFolio request timed out'));
          request.destroy();
        },
        Math.max(1, timeoutMs - (Date.now() - started)),
      );
      timer.unref();
      request.on('close', () => clearTimeout(timer));
      request.on('error', () => reject(new Error('PortFolio request failed')));
      if (payload) request.write(payload);
      request.end();
    });
  }
}
