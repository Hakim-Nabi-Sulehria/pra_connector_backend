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

function isPreviewOrigin(origin: string): boolean {
  // Vercel preview deployments look like project-<hash>-<scope>.vercel.app
  return /-[a-z0-9]{6,}-[a-z0-9-]+\.vercel\.app$/.test(origin);
}

export function resolveFrontendOrigin(preferred?: string | null): string {
  if (preferred && isAllowedFrontendOrigin(preferred)) {
    return preferred.replace(/\/$/, '');
  }
  // No usable return origin: prefer a stable, non-preview configured origin,
  // otherwise fall back to the known stable alias (never an ephemeral preview).
  const stable = getConfiguredOrigins().find(
    (o) => !isPreviewOrigin(o) && !o.includes('localhost'),
  );
  return (stable || STABLE_FRONTEND).replace(/\/$/, '');
}
