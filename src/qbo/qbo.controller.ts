import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../common/guards';
import { QboService } from './qbo.service';

@Controller('qbo')
export class QboController {
  constructor(private qbo: QboService) {}

  @Public()
  @Get('callback')
  async callback(@Req() req: any, @Res() res: Response) {
    const frontend = process.env.FRONTEND_URL || 'http://localhost:5173';
    try {
      const host = req.get('host');
      const proto = req.protocol;
      const fullUrl = `${proto}://${host}${req.originalUrl}`;
      await this.qbo.handleCallback(fullUrl, req.query);
      return res.redirect(`${frontend}/app/connections?qbo=connected`);
    } catch (err: any) {
      const msg = encodeURIComponent(err?.message || 'QBO OAuth failed');
      return res.redirect(`${frontend}/app/connections?qbo=error&message=${msg}`);
    }
  }
}
