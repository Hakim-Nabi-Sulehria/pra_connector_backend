import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/guards';
import { resolveFrontendOrigin } from '../common/allowed-origins';
import { peekMode, peekReturnOrigin, peekReturnPath, safeQboReturnPath } from './oauth-state';
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
    // Always land on the public /oauth/qbo page so a Guard mismatch cannot
    // dump an authenticated FBR/PRA user onto /login after Intuit Approve.
    const returnOrigin = peekReturnOrigin(req.query?.state);
    const mode = peekMode(req.query?.state);
    const returnPath = safeQboReturnPath(peekReturnPath(req.query?.state), mode);
    let frontend = resolveFrontendOrigin(returnOrigin);
    try {
      const host = String(req.get('x-forwarded-host') || req.get('host') || '')
        .split(',')[0]
        .trim();
      const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
        .split(',')[0]
        .trim();
      const fullUrl = `${proto}://${host}${req.originalUrl}`;
      const result = await this.qbo.handleCallback(fullUrl, req.query);
      frontend = resolveFrontendOrigin(result.returnOrigin || returnOrigin);
      const path = safeQboReturnPath(result.returnPath || returnPath, result.mode || mode);
      return res.redirect(this.resumeUrl(frontend, 'connected', path));
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
          'invalid_client: Intuit rejected the app credentials. Development Client ID needs QBO_ENVIRONMENT=sandbox and the Development Redirect URI. Production Client ID needs QBO_ENVIRONMENT=production and the Production Redirect URI you already set.';
      }
      return res.redirect(this.resumeUrl(frontend, 'error', returnPath, friendly));
    }
  }
}
