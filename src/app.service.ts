import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  health() {
    return {
      ok: true,
      service: 'QuickBooks Online Connector API',
      version: '1.0.2',
      timestamp: new Date().toISOString(),
    };
  }
}
