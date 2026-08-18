import { Injectable } from '@nestjs/common';
import * as dns from 'dns';
import { promisify } from 'util';
import { praTlsProbe } from './pra/pra-http.client';

const PRA_SANDBOX_URL =
  process.env.PRA_SANDBOX_URL ||
  'https://ims.pral.com.pk/ims/sandbox/api/Live/PostData';
const PRA_SANDBOX_TOKEN =
  process.env.PRA_SANDBOX_TOKEN || '24d8fab3-f2e9-398f-ae17-b387125ec4a2';

const dnsLookup = promisify(dns.lookup);

const PRA_WHITELIST_HINT =
  'Ask PRA to whitelist your server outbound IP at eims@pra.punjab.gov.pk. On Render, use serverOutboundIp from this response. Optional: set PRA_HTTPS_PROXY to route via an HTTPS egress proxy.';

async function fetchServerOutboundIp(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { ip?: string };
    return body.ip?.trim() || null;
  } catch {
    return null;
  }
}

async function resolvePraIpv4(hostname: string): Promise<string | null> {
  try {
    const result = await dnsLookup(hostname, { family: 4 });
    const address = typeof result === 'string' ? result : result.address;
    return address;
  } catch {
    return null;
  }
}

@Injectable()
export class AppService {
  health() {
    return {
      ok: true,
      service: 'QuickBooks Online Connector API',
      version: '1.0.8',
      timestamp: new Date().toISOString(),
    };
  }

  async praTlsHealth() {
    const hostname = new URL(PRA_SANDBOX_URL).hostname;
    const [probe, serverOutboundIp, praResolvedIp] = await Promise.all([
      praTlsProbe(PRA_SANDBOX_URL, PRA_SANDBOX_TOKEN),
      fetchServerOutboundIp(),
      resolvePraIpv4(hostname),
    ]);

    return {
      ok: probe.ok,
      version: '1.0.8',
      timestamp: new Date().toISOString(),
      praSandbox: probe,
      requestUrl: PRA_SANDBOX_URL,
      serverOutboundIp,
      praResolvedIp,
      ...(probe.ok ? {} : { whitelistHint: PRA_WHITELIST_HINT }),
    };
  }
}
