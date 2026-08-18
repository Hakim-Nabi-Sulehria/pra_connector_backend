import * as dns from 'dns';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { URL } from 'url';

/** Prefer IPv4 for ims.pral.com.pk from cloud hosts. */
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
    message.includes('read ECONNRESET') ||
    message.includes('Client network socket disconnected') ||
    message.includes('socket hang up') ||
    message.includes('network socket disconnected') ||
    message.includes('TLS connection')
  );
}

function praTlsOptions(hostname: string) {
  const strictTls = process.env.PRA_TLS_REJECT_UNAUTHORIZED === 'true';
  return {
    keepAlive: true,
    family: 4,
    lookup: ipv4Lookup as any,
    minVersion: 'TLSv1.2' as const,
    maxVersion: 'TLSv1.2' as const,
    servername: hostname,
    rejectUnauthorized: strictTls,
    ciphers: 'DEFAULT:@SECLEVEL=0',
  };
}

export function createPraHttpsAgent(hostname = 'ims.pral.com.pk'): https.Agent {
  return new https.Agent(praTlsOptions(hostname));
}

function getPraRequestAgent(hostname: string): https.Agent {
  const proxyUrl = process.env.PRA_HTTPS_PROXY?.trim();
  if (proxyUrl) {
    return new HttpsProxyAgent(proxyUrl, praTlsOptions(hostname)) as unknown as https.Agent;
  }
  return createPraHttpsAgent(hostname);
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
    const viaProxy = Boolean(process.env.PRA_HTTPS_PROXY?.trim());
    const agent = getPraRequestAgent(sniHost);
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
        lookup:
          !viaProxy && connectHost
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
  const viaProxy = Boolean(process.env.PRA_HTTPS_PROXY?.trim());

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
    const useDirectIp = !viaProxy && attempt > 0 && resolvedIp;
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
    : new Error('PRA request failed');
}
