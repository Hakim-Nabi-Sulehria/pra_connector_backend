export function getConfiguredOrigins(): string[] {
  return (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
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
  const configured = getConfiguredOrigins();
  const fallback = configured[0] || 'http://localhost:5173';
  if (preferred && isAllowedFrontendOrigin(preferred)) {
    return preferred.replace(/\/$/, '');
  }
  return fallback;
}
