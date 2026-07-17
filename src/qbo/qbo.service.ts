import { Injectable, BadRequestException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OAuthClient = require('intuit-oauth');
import axios from 'axios';
import { ConnectionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class QboService {
  constructor(private prisma: PrismaService) {}

  private createClient() {
    const clientId = process.env.QBO_CLIENT_ID;
    const clientSecret = process.env.QBO_CLIENT_SECRET;
    const redirectUri = process.env.QBO_REDIRECT_URI;
    if (!clientId || !clientSecret || !redirectUri) {
      throw new BadRequestException(
        'QBO credentials missing. Set QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI in backend .env',
      );
    }
    return new OAuthClient({
      clientId,
      clientSecret,
      environment: process.env.QBO_ENVIRONMENT || 'sandbox',
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
    return response.data?.QueryResponse?.Invoice || [];
  }

  async getInvoice(organizationId: string, invoiceId: string) {
    const { realmId, accessToken } = await this.ensureTokens(organizationId);
    const url = `${this.baseUrl()}/v3/company/${realmId}/invoice/${invoiceId}?minorversion=75`;
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
    return response.data?.Invoice;
  }
}
