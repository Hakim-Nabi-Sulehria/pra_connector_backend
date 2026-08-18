import * as dns from 'dns';
import * as https from 'https';
import axios, { AxiosError } from 'axios';

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

export function isRetryablePraNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  const message = String((err as Error).message || '');
  return (
    message.includes('Client network socket disconnected') ||
    message.includes('socket hang up') ||
    message.includes('network socket disconnected')
  );
}

/**
 * Dedicated agent for PRA IMS. Official PRA samples disable certificate
 * validation; some cloud hosts (Render) also hit TLS handshake resets unless
 * IPv4 + retries are used.
 */
export function createPraHttpsAgent(hostname = 'ims.pral.com.pk'): https.Agent {
  const strictTls = process.env.PRA_TLS_REJECT_UNAUTHORIZED === 'true';
  return new https.Agent({
    keepAlive: true,
    family: 4,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    servername: hostname,
    rejectUnauthorized: strictTls,
  });
}

export async function praHttpPost<T = unknown>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options?: { timeoutMs?: number; retries?: number },
): Promise<{ httpStatus: number; data: T; requestUrl: string }> {
  const timeoutMs = options?.timeoutMs ?? 90000;
  const retries = options?.retries ?? 4;
  let hostname = 'ims.pral.com.pk';
  try {
    hostname = new URL(url).hostname;
  } catch {
    /* keep default */
  }
  const httpsAgent = createPraHttpsAgent(hostname);

  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.post<T>(url, body, {
        headers,
        timeout: timeoutMs,
        validateStatus: () => true,
        httpsAgent,
        proxy: false,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return { httpStatus: res.status, data: res.data, requestUrl: url };
    } catch (err) {
      lastError = err;
      const retryable = isRetryablePraNetworkError(err);
      if (!retryable || attempt >= retries - 1) break;
      const delay =
        Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
      await sleep(delay);
    }
  }

  const axiosErr = lastError as AxiosError | undefined;
  throw lastError instanceof Error
    ? lastError
    : new Error(String(axiosErr?.message || lastError || 'PRA request failed'));
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
      },
      { retries: 3, timeoutMs: 45000 },
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
