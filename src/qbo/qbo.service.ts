import { Injectable, BadRequestException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OAuthClient = require('intuit-oauth');
import axios from 'axios';
import { ConnectionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class QboService {
  constructor(private prisma: PrismaService) {}

  private env(key: string) {
    return (process.env[key] || '').trim().replace(/^["']|["']$/g, '');
  }

  private createClient() {
    const clientId = this.env('QBO_CLIENT_ID');
    const clientSecret = this.env('QBO_CLIENT_SECRET');
    const redirectUri = this.env('QBO_REDIRECT_URI');
    const environment =
      this.env('QBO_ENVIRONMENT').toLowerCase() === 'production'
        ? 'production'
        : 'sandbox';
    if (!clientId || !clientSecret || !redirectUri) {
      throw new BadRequestException(
        'QBO credentials missing. Set QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI in backend .env',
      );
    }
    return new OAuthClient({
      clientId,
      clientSecret,
      environment,
      redirectUri,
    });
  }

  private baseUrl() {
    return process.env.QBO_ENVIRONMENT === 'production'
      ? 'https://quickbooks.api.intuit.com'
      : 'https://sandbox-quickbooks.api.intuit.com';
  }

  getAuthUri(organizationId: string, userId: string, returnOrigin?: string) {
    const oauth = this.createClient();
    const state = Buffer.from(
      JSON.stringify({
        organizationId,
        userId,
        returnOrigin: returnOrigin || null,
        t: Date.now(),
      }),
    ).toString('base64url');
    return oauth.authorizeUri({
      scope: [OAuthClient.scopes.Accounting],
      state,
    });
  }

  async handleCallback(fullUrl: string, query: Record<string, string>) {
    const oauth = this.createClient();
    const authResponse = await oauth.createToken(fullUrl);
    const token = authResponse.getToken();
    const realmId = query.realmId || token.realmId;
    if (!query.state) throw new BadRequestException('Missing OAuth state');

    let state: {
      organizationId: string;
      userId: string;
      returnOrigin?: string | null;
    };
    try {
      state = JSON.parse(Buffer.from(query.state, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid OAuth state');
    }

    const expiresAt = token.expires_in
      ? new Date(Date.now() + Number(token.expires_in) * 1000)
      : null;

    // Fetch company name
    let companyName: string | null = null;
    try {
      const infoUrl = `${this.baseUrl()}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`;
      const info = await axios.get(infoUrl, {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          Accept: 'application/json',
        },
      });
      companyName = info.data?.CompanyInfo?.CompanyName || null;
    } catch {
      companyName = null;
    }

    const qbo = await this.prisma.qboConnection.upsert({
      where: { organizationId: state.organizationId },
      create: {
        organizationId: state.organizationId,
        realmId,
        companyName,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        tokenExpiresAt: expiresAt || undefined,
        status: ConnectionStatus.CONNECTED,
        lastSyncedAt: new Date(),
      },
      update: {
        realmId,
        companyName,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        tokenExpiresAt: expiresAt || undefined,
        status: ConnectionStatus.CONNECTED,
        lastSyncedAt: new Date(),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: state.organizationId,
        userId: state.userId,
        action: 'QBO_CONNECTED',
        entity: 'QboConnection',
        meta: { realmId, companyName },
      },
    });

    return { qbo, returnOrigin: state.returnOrigin };
  }

  private async ensureTokens(organizationId: string) {
    const conn = await this.prisma.qboConnection.findUnique({
      where: { organizationId },
    });
    if (!conn?.accessToken || !conn.refreshToken || !conn.realmId) {
      throw new BadRequestException('QuickBooks is not connected for this organization');
    }

    const oauth = this.createClient();
    oauth.setToken({
      access_token: conn.accessToken,
      refresh_token: conn.refreshToken,
      token_type: 'bearer',
      expires_in: 3600,
      x_refresh_token_expires_in: 8726400,
      realmId: conn.realmId,
    });

    const expired =
      !conn.tokenExpiresAt || conn.tokenExpiresAt.getTime() < Date.now() + 60_000;

    if (expired) {
      const refreshed = await oauth.refresh();
      const token = refreshed.getToken();
      const expiresAt = token.expires_in
        ? new Date(Date.now() + Number(token.expires_in) * 1000)
        : null;
      await this.prisma.qboConnection.update({
        where: { organizationId },
        data: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token || conn.refreshToken,
          tokenExpiresAt: expiresAt || undefined,
          status: ConnectionStatus.CONNECTED,
        },
      });
      return {
        realmId: conn.realmId,
        accessToken: token.access_token as string,
      };
    }

    return { realmId: conn.realmId, accessToken: conn.accessToken };
  }

  async getCompany(organizationId: string) {
    const { realmId, accessToken } = await this.ensureTokens(organizationId);
    const url = `${this.baseUrl()}/v3/company/${realmId}/companyinfo/${realmId}?minorversion=75`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    return { realmId, company: response.data?.CompanyInfo };
  }

  async getInvoice(organizationId: string, invoiceId: string) {
    const { realmId, accessToken } = await this.ensureTokens(organizationId);
    // include=enhancedAllCustomFields helps surface custom field values when supported.
    const url = `${this.baseUrl()}/v3/company/${realmId}/invoice/${invoiceId}?minorversion=75&include=enhancedAllCustomFields`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    return response.data?.Invoice;
  }

  /**
   * Legacy sales-form custom fields from Preferences.
   * DefinitionId is the trailing digit of SalesFormsPrefs.SalesCustomName#
   * (typically "1", "2", or "3").
   */
  async getSalesCustomFieldDefs(organizationId: string): Promise<
    { definitionId: string; name: string; enabled: boolean }[]
  > {
    const { realmId, accessToken } = await this.ensureTokens(organizationId);
    const url = `${this.baseUrl()}/v3/company/${realmId}/preferences?minorversion=75`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    const groups = response.data?.Preferences?.SalesFormsPrefs?.CustomField || [];
    const enabled: Record<string, boolean> = {};
    const names: Record<string, string> = {};

    for (const group of groups) {
      for (const cf of group?.CustomField || []) {
        const key = String(cf?.Name || '');
        const useMatch = key.match(/UseSalesCustom(\d+)$/i);
        if (useMatch) {
          enabled[useMatch[1]] = Boolean(cf?.BooleanValue);
          continue;
        }
        const nameMatch = key.match(/SalesCustomName(\d+)$/i);
        if (nameMatch) {
          names[nameMatch[1]] = String(cf?.StringValue || '').trim();
        }
      }
    }

    return Object.keys({ ...enabled, ...names })
      .sort()
      .map((id) => ({
        definitionId: id,
        name: names[id] || `CustomField${id}`,
        enabled: enabled[id] !== false,
      }))
      .filter((d) => d.enabled && d.name);
  }

  /** Merge Preferences definitions into invoice.CustomField so empty fields still appear. */
  enrichInvoiceCustomFields(
    invoice: any,
    defs: { definitionId: string; name: string }[],
  ) {
    if (!invoice) return invoice;
    const existing = Array.isArray(invoice.CustomField) ? invoice.CustomField : [];
    const byId = new Map<string, any>();
    const byName = new Map<string, any>();

    for (const cf of existing) {
      if (cf?.DefinitionId != null) byId.set(String(cf.DefinitionId), cf);
      if (cf?.Name) byName.set(String(cf.Name).toLowerCase(), cf);
    }

    const merged = defs.map((def) => {
      const found =
        byId.get(def.definitionId) ||
        byName.get(def.name.toLowerCase()) ||
        null;
      return {
        DefinitionId: def.definitionId,
        Name: def.name,
        Type: found?.Type || 'StringType',
        StringValue:
          found?.StringValue ??
          found?.BooleanValue ??
          found?.DateValue ??
          found?.NumberValue ??
          null,
      };
    });

    // Keep any unexpected fields from API that aren't in Preferences defs.
    for (const cf of existing) {
      const id = cf?.DefinitionId != null ? String(cf.DefinitionId) : '';
      if (id && defs.some((d) => d.definitionId === id)) continue;
      const name = String(cf?.Name || '').toLowerCase();
      if (name && defs.some((d) => d.name.toLowerCase() === name)) continue;
      merged.push({
        DefinitionId: id || 'unknown',
        Name: cf?.Name || 'CustomField',
        Type: cf?.Type || 'StringType',
        StringValue:
          cf?.StringValue ??
          cf?.BooleanValue ??
          cf?.DateValue ??
          cf?.NumberValue ??
          null,
      });
    }

    return { ...invoice, CustomField: merged };
  }

  async listInvoices(organizationId: string, maxResults = 10) {
    const { realmId, accessToken } = await this.ensureTokens(organizationId);
    const query = encodeURIComponent(`select * from Invoice maxresults ${maxResults}`);
    const url = `${this.baseUrl()}/v3/company/${realmId}/query?query=${query}&minorversion=75`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    const summaries = response.data?.QueryResponse?.Invoice || [];
    if (!summaries.length) return [];

    let defs: { definitionId: string; name: string }[] = [];
    try {
      defs = await this.getSalesCustomFieldDefs(organizationId);
    } catch {
      defs = [];
    }

    const full = await Promise.all(
      summaries.map(async (inv: { Id: string }) => {
        try {
          const detail = await this.getInvoice(organizationId, String(inv.Id));
          return this.enrichInvoiceCustomFields(detail, defs);
        } catch {
          return this.enrichInvoiceCustomFields(inv, defs);
        }
      }),
    );
    return full.filter(Boolean);
  }

  async updateInvoiceCustomField(
    organizationId: string,
    invoiceId: string,
    fieldName: string,
    stringValue: string,
  ) {
    const defs = await this.getSalesCustomFieldDefs(organizationId);
    const invoice = await this.getInvoice(organizationId, invoiceId);
    if (!invoice?.Id || invoice.SyncToken == null) {
      throw new BadRequestException('Invoice not found in QuickBooks');
    }

    const existing = Array.isArray(invoice.CustomField) ? invoice.CustomField : [];
    const fromInvoice = existing.find(
      (cf: any) =>
        String(cf?.Name || '').toLowerCase() === fieldName.toLowerCase(),
    );
    const fromPrefs = defs.find(
      (d) => d.name.toLowerCase() === fieldName.toLowerCase(),
    );

    // Prefer Preference DefinitionId, then invoice CustomField, then legacy slots 1..3.
    const candidates: { definitionId: string; name: string }[] = [];
    if (fromPrefs) {
      candidates.push({ definitionId: fromPrefs.definitionId, name: fromPrefs.name });
    }
    if (fromInvoice?.DefinitionId != null) {
      candidates.push({
        definitionId: String(fromInvoice.DefinitionId),
        name: String(fromInvoice.Name || fieldName),
      });
    }
    // Last resort: try classic legacy DefinitionIds (SalesCustom 1/2/3)
    for (const id of ['1', '2', '3']) {
      if (!candidates.some((c) => c.definitionId === id)) {
        candidates.push({ definitionId: id, name: fieldName });
      }
    }

    const { realmId, accessToken } = await this.ensureTokens(organizationId);
    const url = `${this.baseUrl()}/v3/company/${realmId}/invoice?minorversion=75`;
    const attempts: { definitionId: string; ok: boolean; error?: string; invoice?: any }[] = [];

    for (const candidate of candidates) {
      try {
        const payload = {
          Id: String(invoice.Id),
          SyncToken: String(
            attempts.find((a) => a.ok && a.invoice?.SyncToken)?.invoice?.SyncToken ??
              invoice.SyncToken,
          ),
          sparse: true,
          CustomField: [
            {
              DefinitionId: candidate.definitionId,
              Name: candidate.name,
              Type: 'StringType',
              StringValue: stringValue,
            },
          ],
        };
        // Always re-read SyncToken before each attempt after a success path change
        const latest = await this.getInvoice(organizationId, invoiceId);
        payload.SyncToken = String(latest.SyncToken);
        payload.Id = String(latest.Id);

        const response = await axios.post(url, payload, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        });
        const updated = response.data?.Invoice || response.data;
        attempts.push({
          definitionId: candidate.definitionId,
          ok: true,
          invoice: updated,
        });
        return {
          ...this.enrichInvoiceCustomFields(updated, defs),
          _writeMeta: {
            fieldName,
            stringValue,
            definitionIdUsed: candidate.definitionId,
            attempts,
          },
        };
      } catch (e: any) {
        const msg =
          e?.response?.data?.Fault?.Error?.[0]?.Message ||
          e?.response?.data?.Fault?.Error?.[0]?.Detail ||
          e?.message ||
          'QBO update failed';
        attempts.push({
          definitionId: candidate.definitionId,
          ok: false,
          error: msg,
        });
      }
    }

    throw new BadRequestException({
      message: `Could not update QBO custom field "${fieldName}". REST API may not support this field (new Custom Fields vs legacy sales-form fields).`,
      availablePrefs: defs,
      invoiceCustomFields: existing,
      attempts,
    });
  }
}
