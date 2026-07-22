import { createHmac, timingSafeEqual } from 'crypto';
import { BadRequestException } from '@nestjs/common';

export type QboOAuthState = {
  organizationId: string;
  userId: string;
  returnOrigin?: string | null;
  t: number;
};

function stateSecret() {
  return (
    process.env.QBO_STATE_SECRET ||
    process.env.JWT_SECRET ||
    'pra-connector-dev-secret'
  );
}

function signPayload(payloadB64: string) {
  return createHmac('sha256', stateSecret())
    .update(payloadB64)
    .digest('base64url');
}

/** Encode org/user into a tamper-proof OAuth state string. */
export function encodeQboOAuthState(state: QboOAuthState): string {
  const payloadB64 = Buffer.from(JSON.stringify(state), 'utf8').toString(
    'base64url',
  );
  return `${payloadB64}.${signPayload(payloadB64)}`;
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
    const expected = signPayload(payloadB64);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
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

/** Extract returnOrigin without throwing (used for error redirects). */
export function peekReturnOrigin(raw?: string): string | null {
  if (!raw) return null;
  try {
    return decodeQboOAuthState(raw).returnOrigin || null;
  } catch {
    return null;
  }
}
