import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/guards';
import { resolveFrontendOrigin } from '../common/allowed-origins';
import { QboService } from './qbo.service';

@Controller('qbo')
export class QboController {
  constructor(private qbo: QboService) {}

  @Public()
  @Get('callback')
  async callback(@Req() req: any, @Res() res: Response) {
    let frontend = resolveFrontendOrigin();
    try {
      const host = req.get('x-forwarded-host') || req.get('host');
      const proto = req.get('x-forwarded-proto') || req.protocol;
      const fullUrl = `${proto}://${host}${req.originalUrl}`;
      const result = await this.qbo.handleCallback(fullUrl, req.query);
      frontend = resolveFrontendOrigin(result.returnOrigin);
      return res.redirect(`${frontend}/app/connections?qbo=connected`);
    } catch (err: any) {
      const msg = encodeURIComponent(err?.message || 'QBO OAuth failed');
      return res.redirect(`${frontend}/app/connections?qbo=error&message=${msg}`);
    }
  }
}
