import { createHmac, timingSafeEqual } from 'crypto';
import { BadRequestException } from '@nestjs/common';

export type QboOAuthState = {
  organizationId: string;
  userId: string;
  returnOrigin?: string | null;
  returnPath?: string | null;
  mode?: 'PRA' | 'FBR' | null;
  /** When set (local dev), production callback relays tokens to this origin. */
  handoffOrigin?: string | null;
  t: number;
};

export type QboLocalHandoffPayload = {
  organizationId: string;
  userId: string;
  realmId: string;
  companyName?: string | null;
  accessToken: string;
  refreshToken: string;
  expiresIn?: number | null;
  returnOrigin?: string | null;
  returnPath?: string | null;
  mode?: 'PRA' | 'FBR' | null;
  t: number;
};

function stateSecret() {
  return (
    process.env.QBO_STATE_SECRET ||
    process.env.JWT_SECRET ||
    'pra-connector-dev-secret'
  );
}

function handoffSecret() {
  return (
    process.env.QBO_HANDOFF_SECRET ||
    process.env.QBO_STATE_SECRET ||
    process.env.JWT_SECRET ||
    'pra-connector-dev-secret'
  );
}

/** Secrets accepted when verifying OAuth state (local JWT ≠ Render JWT). */
function stateVerifySecrets() {
  return [
    ...new Set(
      [
        process.env.QBO_HANDOFF_SECRET,
        process.env.QBO_STATE_SECRET,
        process.env.JWT_SECRET,
        'pra-connector-dev-secret',
      ].filter((s): s is string => Boolean(s && String(s).trim())),
    ),
  ];
}

function signPayload(payloadB64: string, secret: string) {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

function verifySignature(payloadB64: string, signature: string, secret: string) {
  const expected = signPayload(payloadB64, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Encode org/user into a tamper-proof OAuth state string.
 * Local→Render handoff signs with QBO_HANDOFF_SECRET so Render can verify
 * without sharing the production JWT_SECRET.
 */
export function encodeQboOAuthState(state: QboOAuthState): string {
  const payloadB64 = Buffer.from(JSON.stringify(state), 'utf8').toString(
    'base64url',
  );
  const secret = state.handoffOrigin ? handoffSecret() : stateSecret();
  return `${payloadB64}.${signPayload(payloadB64, secret)}`;
}

/**
 * Decode and verify OAuth state.
 * Accepts legacy unsigned base64url JSON for in-flight connections during rollout.
 */
export function decodeQboOAuthState(raw: string): QboOAuthState {
  if (!raw) throw new BadRequestException('Missing OAuth state');

  const signedMatch = raw.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (signedMatch) {
    const [, payloadB64, signature] = signedMatch;
    const ok = stateVerifySecrets().some((secret) =>
      verifySignature(payloadB64, signature, secret),
    );
    if (!ok) {
      throw new BadRequestException('Invalid OAuth state signature');
    }
    try {
      return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid OAuth state');
    }
  }

  // Legacy unsigned state (pre-hardening). Still parse, but callback must verify membership.
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid OAuth state');
  }
}

/** Parse state payload without verifying signature (error-redirect UX only). */
function peekStateUnsafe(raw?: string): Partial<QboOAuthState> | null {
  if (!raw) return null;
  try {
    const signedMatch = String(raw).match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
    const payloadB64 = signedMatch ? signedMatch[1] : String(raw);
    return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Extract returnOrigin without throwing (used for error redirects). */
export function peekReturnOrigin(raw?: string): string | null {
  if (!raw) return null;
  try {
    return decodeQboOAuthState(raw).returnOrigin || null;
  } catch {
    return peekStateUnsafe(raw)?.returnOrigin || null;
  }
}

export function peekReturnPath(raw?: string): string | null {
  if (!raw) return null;
  try {
    return decodeQboOAuthState(raw).returnPath || null;
  } catch {
    return peekStateUnsafe(raw)?.returnPath || null;
  }
}

export function peekMode(raw?: string): 'PRA' | 'FBR' | null {
  if (!raw) return null;
  try {
    const mode = decodeQboOAuthState(raw).mode;
    return mode === 'FBR' || mode === 'PRA' ? mode : null;
  } catch {
    const mode = peekStateUnsafe(raw)?.mode;
    return mode === 'FBR' || mode === 'PRA' ? mode : null;
  }
}

export function peekHandoffOrigin(raw?: string): string | null {
  if (!raw) return null;
  try {
    return decodeQboOAuthState(raw).handoffOrigin || null;
  } catch {
    return peekStateUnsafe(raw)?.handoffOrigin || null;
  }
}

function decodeMaybe(value: string) {
  try {
    return value.includes('%') ? decodeURIComponent(value) : value;
  } catch {
    return value;
  }
}

export function safeQboReturnPath(path?: string | null, mode?: string | null) {
  let raw = decodeMaybe(String(path || '')).split('?')[0];
  if (raw.startsWith('/fbr/app')) return raw;
  if (raw.startsWith('/app')) return raw;
  return mode === 'FBR' ? '/fbr/app/connections' : '/app/connections';
}

/** Only localhost handoff targets are allowed (never arbitrary remote hosts). */
export function isAllowedHandoffOrigin(origin?: string | null): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function encodeQboLocalHandoff(payload: QboLocalHandoffPayload): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  return `${payloadB64}.${signPayload(payloadB64, handoffSecret())}`;
}

export function decodeQboLocalHandoff(raw: string): QboLocalHandoffPayload {
  if (!raw) throw new BadRequestException('Missing handoff payload');
  const signedMatch = raw.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!signedMatch) throw new BadRequestException('Invalid handoff payload');
  const [, payloadB64, signature] = signedMatch;
  if (!verifySignature(payloadB64, signature, handoffSecret())) {
    throw new BadRequestException('Invalid handoff signature');
  }
  let parsed: QboLocalHandoffPayload;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid handoff payload');
  }
  if (!parsed?.organizationId || !parsed?.userId || !parsed?.realmId) {
    throw new BadRequestException('Handoff payload incomplete');
  }
  if (!parsed.accessToken || !parsed.refreshToken) {
    throw new BadRequestException('Handoff tokens missing');
  }
  // 5 minute TTL
  if (!parsed.t || Date.now() - Number(parsed.t) > 5 * 60 * 1000) {
    throw new BadRequestException('Handoff expired — connect QuickBooks again');
  }
  return parsed;
}

export function buildLocalHandoffRedirectUrl(
  handoffOrigin: string,
  payload: QboLocalHandoffPayload,
) {
  if (!isAllowedHandoffOrigin(handoffOrigin)) {
    throw new BadRequestException('Handoff origin not allowed');
  }
  const base = handoffOrigin.replace(/\/$/, '');
  const token = encodeQboLocalHandoff(payload);
  return `${base}/api/qbo/local-handoff?handoff=${encodeURIComponent(token)}`;
}
