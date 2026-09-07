import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/guards';
import { resolveFrontendOrigin } from '../common/allowed-origins';
import {
  buildLocalHandoffRedirectUrl,
  peekMode,
  peekReturnOrigin,
  peekReturnPath,
  safeQboReturnPath,
} from './oauth-state';
import { QboService } from './qbo.service';

@Controller('qbo')
export class QboController {
  constructor(private qbo: QboService) {}

  private resumeUrl(
    frontend: string,
    status: 'connected' | 'error',
    next: string,
    message?: string,
  ) {
    const params = new URLSearchParams({ qbo: status, next });
    if (message) params.set('message', message);
    return `${frontend}/oauth/qbo?${params.toString()}`;
  }

  @Public()
  @Get('callback')
  async callback(@Req() req: any, @Res() res: Response) {
    const returnOrigin = peekReturnOrigin(req.query?.state);
    const mode = peekMode(req.query?.state);
    const returnPath = safeQboReturnPath(peekReturnPath(req.query?.state), mode);
    // Always resume on localhost — never Vercel.
    const frontend = resolveFrontendOrigin(returnOrigin || 'http://localhost:5173');
    try {
      const host = String(req.get('x-forwarded-host') || req.get('host') || '')
        .split(',')[0]
        .trim();
      const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
        .split(',')[0]
        .trim();
      const fullUrl = `${proto}://${host}${req.originalUrl}`;
      const result = await this.qbo.handleCallback(fullUrl, req.query);

      if (!result.handoff) {
        throw new Error('Expected local handoff from Render callback');
      }
      return res.redirect(
        buildLocalHandoffRedirectUrl(result.handoffOrigin, result.payload),
      );
    } catch (err: any) {
      const json = err?.authResponse?.json || err?.authResponse?.body || {};
      const raw = String(
        json.error_description ||
          json.error ||
          err?.error ||
          err?.message ||
          'QBO OAuth failed',
      );
      console.error('[qbo/callback] token exchange failed', raw);
      let friendly = raw;
      if (/invalid_client/i.test(raw)) {
        friendly =
          'invalid_client: Intuit rejected the app credentials. Use Production Client ID/Secret with QBO_ENVIRONMENT=production.';
      }
      if (/no sandbox companies/i.test(raw)) {
        friendly =
          'This Intuit login has no live QuickBooks company for Production. Sign in with the company owner account.';
      }
      return res.redirect(this.resumeUrl(frontend, 'error', returnPath, friendly));
    }
  }

  /** Local receiver: Render hands off tokens here; saves to local Postgres. */
  @Public()
  @Get('local-handoff')
  async localHandoff(
    @Query('handoff') handoff: string,
    @Res() res: Response,
  ) {
    const frontend = resolveFrontendOrigin('http://localhost:5173');
    let returnPath = '/app/connections';
    try {
      const result = await this.qbo.applyLocalHandoff(handoff);
      returnPath = safeQboReturnPath(result.returnPath, result.mode);
      const resumeFrontend = resolveFrontendOrigin(
        result.returnOrigin || frontend,
      );
      return res.redirect(this.resumeUrl(resumeFrontend, 'connected', returnPath));
    } catch (err: any) {
      const message = String(err?.message || 'QBO local handoff failed');
      console.error('[qbo/local-handoff]', message);
      return res.redirect(this.resumeUrl(frontend, 'error', returnPath, message));
    }
  }
}
