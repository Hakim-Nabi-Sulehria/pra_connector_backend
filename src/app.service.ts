import { Injectable } from '@nestjs/common';
import { praTlsProbe } from './pra/pra-http.client';

const PRA_SANDBOX_URL =
  process.env.PRA_SANDBOX_URL ||
  'https://ims.pral.com.pk/ims/sandbox/api/Live/PostData';
const PRA_SANDBOX_TOKEN =
  process.env.PRA_SANDBOX_TOKEN || '24d8fab3-f2e9-398f-ae17-b387125ec4a2';

@Injectable()
export class AppService {
  health() {
    return {
      ok: true,
      service: 'QuickBooks Online Connector API',
      version: '1.0.4',
      timestamp: new Date().toISOString(),
    };
  }

  async praTlsHealth() {
    const probe = await praTlsProbe(PRA_SANDBOX_URL, PRA_SANDBOX_TOKEN);
    return {
      ok: probe.ok,
      version: '1.0.4',
      timestamp: new Date().toISOString(),
      praSandbox: probe,
      requestUrl: PRA_SANDBOX_URL,
    };
  }
}
