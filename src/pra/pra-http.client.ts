import * as dns from 'dns';
import * as https from 'https';
import { URL } from 'url';

/** Prefer IPv4 — Render/Node happy-eyeballs can fail on some routes to ims.pral.com.pk */
dns.setDefaultResultOrder('ipv4first');

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_SSL_WRONG_VERSION_NUMBER',
]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ipv4Lookup(
  hostname: string,
  _options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) {
  dns.lookup(hostname, { family: 4, all: false }, (err, address, family) => {
    callback(err, address, family);
  });
}

export function isRetryablePraNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  const message = String((err as Error).message || '');
  return (
    message.includes('Client network socket disconnected') ||
    message.includes('socket hang up') ||
    message.includes('network socket disconnected') ||
    message.includes('TLS connection')
  );
}

/**
 * Dedicated agent for PRA IMS. Official PRA samples disable certificate
 * validation; Render also needs IPv4-only lookup for ims.pral.com.pk.
 */
export function createPraHttpsAgent(hostname = 'ims.pral.com.pk'): https.Agent {
  const strictTls = process.env.PRA_TLS_REJECT_UNAUTHORIZED === 'true';
  return new https.Agent({
    keepAlive: true,
    family: 4,
    lookup: ipv4Lookup as any,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.2',
    servername: hostname,
    rejectUnauthorized: strictTls,
    ciphers: 'DEFAULT:@SECLEVEL=0',
  });
}

function parseResponseBody(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function nativeHttpsPost<T = unknown>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  connectHost?: string,
): Promise<{ httpStatus: number; data: T; requestUrl: string }> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const payload = JSON.stringify(body ?? {});
    const hostname = parsed.hostname;
    const sniHost = hostname;
    const requestHost = connectHost || hostname;
    const agent = createPraHttpsAgent(sniHost);
    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: requestHost,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'POST',
        headers: {
          ...headers,
          Host: hostname,
          'Content-Length': Buffer.byteLength(payload),
        },
        agent,
        lookup: connectHost
          ? (_host: string, _opts: dns.LookupOptions, cb: any) => cb(null, connectHost, 4)
          : (ipv4Lookup as any),
        minVersion: 'TLSv1.2',
        maxVersion: 'TLSv1.2',
        servername: sniHost,
        rejectUnauthorized: process.env.PRA_TLS_REJECT_UNAUTHORIZED === 'true',
        ciphers: 'DEFAULT:@SECLEVEL=0',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            httpStatus: res.statusCode || 0,
            data: parseResponseBody(raw) as T,
            requestUrl: url,
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`PRA request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export async function praHttpPost<T = unknown>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options?: { timeoutMs?: number; retries?: number },
): Promise<{ httpStatus: number; data: T; requestUrl: string }> {
  const timeoutMs = options?.timeoutMs ?? 90000;
  const retries = options?.retries ?? 5;
  const hostname = new URL(url).hostname;

  let resolvedIp: string | undefined;
  try {
    resolvedIp = await new Promise<string>((resolve, reject) => {
      dns.lookup(hostname, { family: 4, all: false }, (err, address) => {
        if (err) reject(err);
        else resolve(address);
      });
    });
  } catch {
    resolvedIp = undefined;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    const useDirectIp = attempt > 0 && resolvedIp;
    try {
      return await nativeHttpsPost<T>(
        url,
        body,
        headers,
        timeoutMs,
        useDirectIp ? resolvedIp : undefined,
      );
    } catch (err) {
      lastError = err;
      const retryable = isRetryablePraNetworkError(err);
      if (!retryable || attempt >= retries - 1) break;
      const delay =
        Math.min(30_000, 1500 * 2 ** attempt) * (0.5 + Math.random());
      await sleep(delay);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError || 'PRA request failed'));
}

/** Lightweight connectivity probe — any HTTP response means TLS succeeded. */
export async function praTlsProbe(
  url: string,
  token: string,
): Promise<{ ok: boolean; httpStatus: number; message: string }> {
  try {
    const result = await praHttpPost(
      url,
      {},
      {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'PRA-QBO-Connector/1.0',
      },
      { retries: 5, timeoutMs: 45000 },
    );
    return {
      ok: true,
      httpStatus: result.httpStatus,
      message:
        result.httpStatus === 401
          ? 'TLS OK — PRA reachable (credentials will be validated on post)'
          : `TLS OK — PRA responded with HTTP ${result.httpStatus}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      httpStatus: 0,
      message: err?.message || 'PRA TLS probe failed',
    };
  }
}
