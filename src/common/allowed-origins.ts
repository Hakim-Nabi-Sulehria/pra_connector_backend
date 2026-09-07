/** Local-only frontend. Render is used only as the QBO OAuth callback host. */
const LOCAL_FRONTEND = 'http://localhost:5173';

function isLocalOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

export function getConfiguredOrigins(): string[] {
  const fromEnv = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .filter(isLocalOrigin);
  if (!fromEnv.includes(LOCAL_FRONTEND)) fromEnv.push(LOCAL_FRONTEND);
  return fromEnv.length ? fromEnv : [LOCAL_FRONTEND];
}

export function isAllowedFrontendOrigin(origin: string): boolean {
  if (!origin) return false;
  return isLocalOrigin(origin);
}

/** Always resume on localhost — never Vercel or other remote frontends. */
export function resolveFrontendOrigin(preferred?: string | null): string {
  if (preferred && isLocalOrigin(preferred)) {
    return preferred.replace(/\/$/, '');
  }
  const configured = getConfiguredOrigins()[0] || LOCAL_FRONTEND;
  return configured.replace(/\/$/, '');
}
