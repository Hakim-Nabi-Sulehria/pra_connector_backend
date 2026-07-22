import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/guards';
import { resolveFrontendOrigin } from '../common/allowed-origins';
import { peekReturnOrigin } from './oauth-state';
import { QboService } from './qbo.service';

@Controller('qbo')
export class QboController {
  constructor(private qbo: QboService) {}

  @Public()
  @Get('callback')
  async callback(@Req() req: any, @Res() res: Response) {
    // Decode returnOrigin from OAuth state up front so BOTH success and error
    // redirects land on the same origin the user started from (never a stale URL).
    const returnOrigin = peekReturnOrigin(req.query?.state);
    let frontend = resolveFrontendOrigin(returnOrigin);
    try {
      const host = req.get('x-forwarded-host') || req.get('host');
      const proto = req.get('x-forwarded-proto') || req.protocol;
      const fullUrl = `${proto}://${host}${req.originalUrl}`;
      const result = await this.qbo.handleCallback(fullUrl, req.query);
      frontend = resolveFrontendOrigin(result.returnOrigin || returnOrigin);
      return res.redirect(`${frontend}/app/connections?qbo=connected`);
    } catch (err: any) {
      const raw = String(err?.error || err?.authResponse?.json?.error || err?.message || 'QBO OAuth failed');
      let friendly = raw;
      if (/invalid_client/i.test(raw)) {
        friendly =
          'invalid_client: Intuit rejected the app credentials. On Render, Development keys need QBO_ENVIRONMENT=sandbox; Production keys need QBO_ENVIRONMENT=production. Also confirm QBO_CLIENT_ID / QBO_CLIENT_SECRET / Redirect URI match the Intuit Developer app exactly.';
      }
      const msg = encodeURIComponent(friendly);
      return res.redirect(`${frontend}/app/connections?qbo=error&message=${msg}`);
    }
  }
}
