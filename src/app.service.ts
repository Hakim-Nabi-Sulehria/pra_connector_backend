import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  health() {
    return {
      ok: true,
      service: 'PRA Connector API',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
  }
}
