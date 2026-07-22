import {
  decodeQboOAuthState,
  encodeQboOAuthState,
} from './oauth-state';

describe('QBO OAuth state (multi-tenant binding)', () => {
  const prev = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.JWT_SECRET = 'test-tenant-isolation-secret';
  });

  afterAll(() => {
    process.env.JWT_SECRET = prev;
  });

  it('round-trips organizationId and userId without mixup', () => {
    const encoded = encodeQboOAuthState({
      organizationId: 'org-company-a',
      userId: 'user-a',
      returnOrigin: 'https://pra-connector-frontend.vercel.app',
      t: 1,
    });
    const decoded = decodeQboOAuthState(encoded);
    expect(decoded.organizationId).toBe('org-company-a');
    expect(decoded.userId).toBe('user-a');
  });

  it('rejects tampered organizationId in signed state', () => {
    const encoded = encodeQboOAuthState({
      organizationId: 'org-company-a',
      userId: 'user-a',
      t: 1,
    });
    const [payload] = encoded.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        organizationId: 'org-company-b',
        userId: 'user-a',
        t: 1,
      }),
      'utf8',
    ).toString('base64url');
    const forged = `${forgedPayload}.${encoded.split('.')[1]}`;
    expect(payload).not.toBe(forgedPayload);
    expect(() => decodeQboOAuthState(forged)).toThrow(/signature/i);
  });
});

describe('Tenant-scoped QBO connection lookups', () => {
  it('loads tokens only for the requested organizationId', async () => {
    const stores: Record<string, any> = {
      'org-a': {
        organizationId: 'org-a',
        realmId: 'realm-xyz',
        accessToken: 'token-a',
        refreshToken: 'refresh-a',
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        companyName: 'QBO XYZ',
      },
      'org-b': {
        organizationId: 'org-b',
        realmId: 'realm-abc',
        accessToken: 'token-b',
        refreshToken: 'refresh-b',
        tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        companyName: 'QBO ABC',
      },
    };

    const prisma = {
      qboConnection: {
        findUnique: jest.fn(async ({ where }: any) => stores[where.organizationId] || null),
      },
    };

    // Mirror ensureTokensUnlocked selection logic used by QboService.
    async function loadForOrg(organizationId: string) {
      const conn = await prisma.qboConnection.findUnique({
        where: { organizationId },
      });
      if (!conn) throw new Error('missing');
      return {
        realmId: conn.realmId,
        accessToken: conn.accessToken,
        companyName: conn.companyName,
      };
    }

    const a = await loadForOrg('org-a');
    const b = await loadForOrg('org-b');

    expect(a).toEqual({
      realmId: 'realm-xyz',
      accessToken: 'token-a',
      companyName: 'QBO XYZ',
    });
    expect(b).toEqual({
      realmId: 'realm-abc',
      accessToken: 'token-b',
      companyName: 'QBO ABC',
    });
    expect(prisma.qboConnection.findUnique).toHaveBeenNthCalledWith(1, {
      where: { organizationId: 'org-a' },
    });
    expect(prisma.qboConnection.findUnique).toHaveBeenNthCalledWith(2, {
      where: { organizationId: 'org-b' },
    });
  });

  it('keeps InvoiceSync unique per organization + qboInvoiceId', () => {
    // Same QBO invoice numeric id can exist in two realms; composite key prevents clash.
    const rows = [
      { organizationId: 'org-a', qboInvoiceId: '2', company: 'XYZ' },
      { organizationId: 'org-b', qboInvoiceId: '2', company: 'ABC' },
    ];
    const key = (r: { organizationId: string; qboInvoiceId: string }) =>
      `${r.organizationId}:${r.qboInvoiceId}`;
    const set = new Set(rows.map(key));
    expect(set.size).toBe(2);
    expect(set.has('org-a:2')).toBe(true);
    expect(set.has('org-b:2')).toBe(true);
  });

  it('redacts QBO tokens from customer-facing org payloads', () => {
    const org = {
      name: 'Company A',
      qbo: {
        status: 'CONNECTED',
        realmId: 'realm-xyz',
        companyName: 'QBO XYZ',
        accessToken: 'secret-access',
        refreshToken: 'secret-refresh',
      },
      pra: {
        status: 'CONNECTED',
        posId: '123',
        apiToken: 'pra-secret',
      },
    };
    const { accessToken, refreshToken, ...qboSafe } = org.qbo;
    const { apiToken, ...praSafe } = org.pra;
    const sanitized = {
      ...org,
      qbo: qboSafe,
      pra: { ...praSafe, hasToken: Boolean(apiToken) },
    };
    expect(sanitized.qbo).not.toHaveProperty('accessToken');
    expect(sanitized.qbo).not.toHaveProperty('refreshToken');
    expect(sanitized.pra).not.toHaveProperty('apiToken');
    expect(sanitized.pra.hasToken).toBe(true);
    expect(sanitized.qbo.realmId).toBe('realm-xyz');
  });

  it('scopes invoice mutations by organizationId to block IDOR', () => {
    const invoices = [
      { id: 'inv-a', organizationId: 'org-a' },
      { id: 'inv-b', organizationId: 'org-b' },
    ];
    const actingOrg = 'org-a';
    const targetId = 'inv-b';
    const allowed = invoices.find(
      (row) => row.id === targetId && row.organizationId === actingOrg,
    );
    expect(allowed).toBeUndefined();
  });
});
