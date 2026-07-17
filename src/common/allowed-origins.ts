/** Stable production frontend (Vercel alias). Preview URLs change per deploy. */
const STABLE_FRONTEND = 'https://pra-connector-frontend.vercel.app';

export function getConfiguredOrigins(): string[] {
  const fromEnv = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // Always keep the stable alias as a safe fallback, even if env is unset or
  // points at an old ephemeral preview deployment.
  if (!fromEnv.includes(STABLE_FRONTEND)) {
    fromEnv.push(STABLE_FRONTEND);
  }
  return fromEnv.length ? fromEnv : [STABLE_FRONTEND];
}

export function isAllowedFrontendOrigin(origin: string): boolean {
  if (!origin) return false;
  const configured = getConfiguredOrigins();
  return (
    configured.includes(origin) ||
    origin.includes('localhost') ||
    origin.endsWith('.vercel.app')
  );
}

export function resolveFrontendOrigin(preferred?: string | null): string {
  if (preferred && isAllowedFrontendOrigin(preferred)) {
    return preferred.replace(/\/$/, '');
  }
  const configured = getConfiguredOrigins();
  // Prefer a stable, non-preview origin over an ephemeral preview URL.
  const stable = configured.find(
    (o) => !/-[a-z0-9]{9,}-.*\.vercel\.app$/.test(o),
  );
  return (stable || configured[0] || STABLE_FRONTEND).replace(/\/$/, '');
}
