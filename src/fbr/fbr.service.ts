import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import { createHash } from 'crypto';
import { ConnectionStatus, InvoiceSyncStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FBR_DEFAULT_BASE_URL, fbrApiPaths } from '../common/integration-mode';
import {
  resolveLineValue,
  resolveSampleValue,
  type MappingExtras,
} from '../mappings/mapping.defaults';

export type FbrDiPayload = {
  invoiceType: string;
  invoiceDate: string;
  sellerNTNCNIC: string;
  sellerBusinessName: string;
  sellerProvince: string;
  sellerAddress: string;
  buyerNTNCNIC: string;
  buyerBusinessName: string;
  buyerProvince: string;
  buyerAddress: string;
  buyerRegistrationType: string;
  invoiceRefNo: string;
  scenarioId: string;
  items: Array<Record<string, unknown>>;
};

@Injectable()
export class FbrService {
  private readonly logger = new Logger(FbrService.name);

  constructor(private prisma: PrismaService) {}

  payloadHash(payload: string) {
    return createHash('sha256').update(payload).digest('hex');
  }

  private async getConnection(organizationId: string) {
    const conn = await this.prisma.fbrConnection.findUnique({
      where: { organizationId },
    });
    if (!conn?.apiToken) {
      throw new BadRequestException(
        'FBR bearer token is not configured for this company',
      );
    }
    if (!conn.sellerNTNCNIC?.trim()) {
      throw new BadRequestException('FBR seller NTN/CNIC is not configured');
    }
    return conn;
  }

  async postToFbr(
    organizationId: string,
    operation: 'validate' | 'post',
    payload: FbrDiPayload,
  ) {
    const conn = await this.getConnection(organizationId);
    const paths = fbrApiPaths(conn.environment);
    const base = (conn.apiBaseUrl || FBR_DEFAULT_BASE_URL).replace(/\/$/, '');
    const path = operation === 'validate' ? paths.validate : paths.post;
    const url = `${base}${path}`;

    try {
      const res = await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${conn.apiToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        timeout: 60000,
        validateStatus: () => true,
      });
      return {
        httpStatus: res.status,
        body: res.data,
        requestUrl: url,
      };
    } catch (err: any) {
      this.logger.error(`FBR ${operation} transport error: ${err.message}`);
      throw new BadRequestException(
        `FBR ${operation} request failed: ${err.message}`,
      );
    }
  }

  parseValidation(body: any): {
    ok: boolean;
    statusCode?: string;
    status?: string;
    errorCode?: string | null;
    error?: string;
    lineErrors: string[];
  } {
    const vr = body?.validationResponse || body;
    const statusCode = vr?.statusCode;
    const status = (vr?.status || '').toString();
    const lineStatuses = Array.isArray(vr?.invoiceStatuses)
      ? vr.invoiceStatuses
      : [];
    const lineErrors = lineStatuses
      .filter(
        (l: any) =>
          l?.statusCode !== '00' ||
          (l?.status || '').toString().toLowerCase() !== 'valid',
      )
      .map(
        (l: any) =>
          `Line ${l?.itemSNo || '?'}: ${l?.errorCode || ''} ${l?.error || l?.status || ''}`.trim(),
      );

    const ok =
      statusCode === '00' &&
      status.toLowerCase() === 'valid' &&
      lineErrors.length === 0;

    return {
      ok,
      statusCode,
      status,
      errorCode: vr?.errorCode,
      error: vr?.error || '',
      lineErrors,
    };
  }

  parsePost(body: any): {
    ok: boolean;
    fbrInvoiceNo?: string;
    lineInvoiceNos: string[];
    validation: ReturnType<FbrService['parseValidation']>;
  } {
    const validation = this.parseValidation(body);
    const fbrInvoiceNo = body?.invoiceNumber?.toString();
    const lineInvoiceNos = (body?.validationResponse?.invoiceStatuses || [])
      .map((l: any) => l?.invoiceNo)
      .filter(Boolean);

    const ok = validation.ok && Boolean(fbrInvoiceNo);
    return { ok, fbrInvoiceNo, lineInvoiceNos, validation };
  }

  /** Build a DI payload from QBO invoice + org FBR setup + optional field mappings. */
  buildPayloadFromQboInvoice(
    qboInvoice: any,
    fbrConn: {
      sellerNTNCNIC: string | null;
      sellerBusinessName: string | null;
      sellerProvince: string | null;
      sellerAddress: string | null;
    },
    scenarioId: 'SN001' | 'SN002',
    mappings?: Array<{ section: string; targetField: string; sourceField: string }>,
  ): FbrDiPayload {
    const extras: MappingExtras = { fbr: fbrConn, scenarioId };
    const headerMap = new Map(
      (mappings || [])
        .filter((m) => m.section === 'HEADER')
        .map((m) => [m.targetField, m.sourceField]),
    );
    const lineMap = new Map(
      (mappings || [])
        .filter((m) => m.section === 'LINE')
        .map((m) => [m.targetField, m.sourceField]),
    );

    const header = (key: string, fallback: any = '') => {
      const source = headerMap.get(key);
      if (!source) return fallback;
      const value = resolveSampleValue(qboInvoice, source, extras);
      return value == null || value === '' ? fallback : value;
    };

    const customer = qboInvoice?.CustomerRef?.name || 'Customer';
    const buyerReg =
      scenarioId === 'SN001' ? 'Registered' : 'Unregistered';
    const buyerNtn =
      scenarioId === 'SN001'
        ? String(
            header('buyerNTNCNIC', qboInvoice?.CustomerMemo?.value || ''),
          ).slice(0, 13) || '3740558449617'
        : String(header('buyerNTNCNIC', '1000000000000') || '1000000000000');

    const lines = (qboInvoice?.Line || []).filter(
      (l: any) => l.DetailType === 'SalesItemLineDetail',
    );

    const itemFromLine = (line: any) => {
      const qty = Number(line.SalesItemLineDetail?.Qty || 1);
      const unitPrice = Number(line.SalesItemLineDetail?.UnitPrice || 0);
      const valueExTax = qty * unitPrice || Number(line.Amount || 0);
      const rateRaw = resolveLineValue(qboInvoice, line, lineMap.get('rate') || '', extras);
      const taxPct = Number(String(rateRaw || '18').replace('%', '')) || 18;
      const salesTax =
        Number(
          resolveLineValue(
            qboInvoice,
            line,
            lineMap.get('salesTaxApplicable') || '',
            extras,
          ),
        ) || valueExTax * (taxPct / 100);
      const mapped = (key: string, fallback: any) => {
        const source = lineMap.get(key);
        if (!source) return fallback;
        const value = resolveLineValue(qboInvoice, line, source, extras);
        return value == null || value === '' ? fallback : value;
      };

      return {
        hsCode: String(mapped('hsCode', '8478.9000')),
        productDescription: String(
          mapped('productDescription', line.Description || line.SalesItemLineDetail?.ItemRef?.name || 'Inventory'),
        ),
        rate: String(mapped('rate', `${taxPct}%`)),
        uoM: String(mapped('uoM', 'Numbers, pieces, units')),
        quantity: Number(mapped('quantity', qty)),
        totalValues: Number(mapped('totalValues', valueExTax + salesTax)),
        valueSalesExcludingST: Number(mapped('valueSalesExcludingST', valueExTax)),
        fixedNotifiedValueOrRetailPrice: Number(mapped('fixedNotifiedValueOrRetailPrice', 0)),
        salesTaxApplicable: Number(mapped('salesTaxApplicable', salesTax)),
        salesTaxWithheldAtSource: Number(mapped('salesTaxWithheldAtSource', 0)),
        extraTax: Number(mapped('extraTax', 0)),
        furtherTax: Number(mapped('furtherTax', 0)),
        sroScheduleNo: String(mapped('sroScheduleNo', '')),
        fedPayable: Number(mapped('fedPayable', 0)),
        discount: Number(mapped('discount', 0)),
        saleType: String(mapped('saleType', 'Goods at standard rate (default)')),
        sroItemSerialNo: String(mapped('sroItemSerialNo', '')),
      };
    };

    const items = lines.length
      ? lines.map(itemFromLine)
      : [itemFromLine({ SalesItemLineDetail: { Qty: 1, UnitPrice: 1000 }, Amount: 1000, Description: 'Inventory' })];

    const txnDate = qboInvoice?.TxnDate || new Date().toISOString().slice(0, 10);
    const billAddr = [
      qboInvoice?.BillAddr?.Line1,
      qboInvoice?.BillAddr?.City,
    ]
      .filter(Boolean)
      .join(', ');

    return {
      invoiceType: String(header('invoiceType', 'Sale Invoice')),
      invoiceDate: String(header('invoiceDate', txnDate)),
      sellerNTNCNIC: String(header('sellerNTNCNIC', fbrConn.sellerNTNCNIC || '')),
      sellerBusinessName: String(header('sellerBusinessName', fbrConn.sellerBusinessName || '')),
      sellerProvince: String(header('sellerProvince', fbrConn.sellerProvince || '')),
      sellerAddress: String(header('sellerAddress', fbrConn.sellerAddress || '')),
      buyerNTNCNIC: buyerNtn,
      buyerBusinessName: String(header('buyerBusinessName', customer)),
      buyerProvince: String(header('buyerProvince', qboInvoice?.BillAddr?.CountrySubDivisionCode || 'SINDH')),
      buyerAddress: String(header('buyerAddress', billAddr || 'KARACHI')),
      buyerRegistrationType: String(header('buyerRegistrationType', buyerReg)),
      invoiceRefNo: String(header('invoiceRefNo', qboInvoice?.DocNumber || '')),
      scenarioId: String(header('scenarioId', scenarioId)),
      items,
    };
  }

  async validateAndStore(
    organizationId: string,
    qboInvoiceId: string,
    payload: FbrDiPayload,
    meta?: { usin?: string; customerName?: string; totalAmount?: number },
  ) {
    const payloadText = JSON.stringify(payload);
    const result = await this.postToFbr(organizationId, 'validate', payload);
    const parsed = this.parseValidation(result.body);

    const status = parsed.ok ? InvoiceSyncStatus.VALIDATED : InvoiceSyncStatus.FAILED;
    const errorMessage = parsed.ok
      ? null
      : [parsed.error, ...parsed.lineErrors].filter(Boolean).join('; ');

    const row = await this.prisma.fbrInvoiceSync.upsert({
      where: {
        organizationId_qboInvoiceId: { organizationId, qboInvoiceId },
      },
      create: {
        organizationId,
        qboInvoiceId,
        usin: meta?.usin,
        customerName: meta?.customerName,
        totalAmount: meta?.totalAmount,
        scenarioId: payload.scenarioId,
        status,
        validatePayload: payload as any,
        validateResponse: result.body,
        validatedPayloadHash: parsed.ok ? this.payloadHash(payloadText) : null,
        errorMessage,
      },
      update: {
        scenarioId: payload.scenarioId,
        status,
        validatePayload: payload as any,
        validateResponse: result.body,
        validatedPayloadHash: parsed.ok ? this.payloadHash(payloadText) : null,
        errorMessage,
        fbrInvoiceNo: null,
        postPayload: Prisma.DbNull,
        postResponse: Prisma.DbNull,
        postedAt: null,
      },
    });

    if (!parsed.ok) {
      throw new BadRequestException(
        errorMessage || 'FBR validation failed',
      );
    }

    return { row, httpStatus: result.httpStatus, parsed };
  }

  async postValidated(
    organizationId: string,
    qboInvoiceId: string,
    payload: FbrDiPayload,
  ) {
    const existing = await this.prisma.fbrInvoiceSync.findUnique({
      where: {
        organizationId_qboInvoiceId: { organizationId, qboInvoiceId },
      },
    });
    if (!existing || existing.status !== InvoiceSyncStatus.VALIDATED) {
      throw new BadRequestException(
        'Invoice must be validated with FBR before posting',
      );
    }

    const hash = this.payloadHash(JSON.stringify(payload));
    if (
      existing.validatedPayloadHash &&
      existing.validatedPayloadHash !== hash
    ) {
      throw new BadRequestException(
        'Payload changed since validation — re-validate before posting',
      );
    }

    const result = await this.postToFbr(organizationId, 'post', payload);
    const parsed = this.parsePost(result.body);

    if (!parsed.ok || !parsed.fbrInvoiceNo) {
      const msg =
        [parsed.validation.error, ...parsed.validation.lineErrors]
          .filter(Boolean)
          .join('; ') || 'FBR post failed';
      await this.prisma.fbrInvoiceSync.update({
        where: { id: existing.id },
        data: {
          status: InvoiceSyncStatus.FAILED,
          postPayload: payload as any,
          postResponse: result.body,
          errorMessage: msg,
        },
      });
      throw new BadRequestException(msg);
    }

    const row = await this.prisma.fbrInvoiceSync.update({
      where: { id: existing.id },
      data: {
        status: InvoiceSyncStatus.POSTED,
        fbrInvoiceNo: parsed.fbrInvoiceNo,
        postPayload: payload as any,
        postResponse: result.body,
        errorMessage: null,
        postedAt: new Date(),
      },
    });

    await this.prisma.fbrConnection.update({
      where: { organizationId },
      data: {
        status: ConnectionStatus.CONNECTED,
        lastPostedAt: new Date(),
      },
    });

    return { row, fbrInvoiceNo: parsed.fbrInvoiceNo, parsed };
  }
}
