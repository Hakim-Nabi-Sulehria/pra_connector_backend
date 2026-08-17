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

  /** Build a minimal DI payload from QBO invoice + org FBR setup (SN001/SN002). */
  buildPayloadFromQboInvoice(
    qboInvoice: any,
    fbrConn: {
      sellerNTNCNIC: string | null;
      sellerBusinessName: string | null;
      sellerProvince: string | null;
      sellerAddress: string | null;
    },
    scenarioId: 'SN001' | 'SN002',
  ): FbrDiPayload {
    const customer = qboInvoice?.CustomerRef?.name || 'Customer';
    const buyerReg =
      scenarioId === 'SN001' ? 'Registered' : 'Unregistered';
    const buyerNtn =
      scenarioId === 'SN001'
        ? qboInvoice?.CustomerMemo?.value?.slice(0, 13) || '3740558449617'
        : '1000000000000';

    const lines = (qboInvoice?.Line || []).filter(
      (l: any) => l.DetailType === 'SalesItemLineDetail',
    );
    const items = lines.length
      ? lines.map((line: any) => {
          const qty = Number(line.SalesItemLineDetail?.Qty || 1);
          const unitPrice = Number(line.SalesItemLineDetail?.UnitPrice || 0);
          const valueExTax = qty * unitPrice;
          const tax = Number(line.SalesItemLineDetail?.TaxCodeRef ? 0 : 0);
          const salesTax = valueExTax * 0.18;
          const total = valueExTax + salesTax;
          return {
            hsCode: '8478.9000',
            productDescription: line.Description || 'Inventory',
            rate: '18%',
            uoM: 'KG',
            quantity: qty,
            totalValues: total,
            valueSalesExcludingST: valueExTax,
            fixedNotifiedValueOrRetailPrice: 0.0,
            salesTaxApplicable: salesTax,
            salesTaxWithheldAtSource: 0.0,
            extraTax: 0.0,
            furtherTax: 0.0,
            sroScheduleNo: '',
            fedPayable: 0.0,
            discount: 0.0,
            saleType: 'Goods at standard rate (default)',
            sroItemSerialNo: '',
          };
        })
      : [
          {
            hsCode: '8478.9000',
            productDescription: 'Inventory',
            rate: '18%',
            uoM: 'KG',
            quantity: 1.0,
            totalValues: 1180.0,
            valueSalesExcludingST: 1000.0,
            fixedNotifiedValueOrRetailPrice: 0.0,
            salesTaxApplicable: 180.0,
            salesTaxWithheldAtSource: 0.0,
            extraTax: 0.0,
            furtherTax: 0.0,
            sroScheduleNo: '',
            fedPayable: 0.0,
            discount: 0.0,
            saleType: 'Goods at standard rate (default)',
            sroItemSerialNo: '',
          },
        ];

    const txnDate = qboInvoice?.TxnDate || new Date().toISOString().slice(0, 10);

    return {
      invoiceType: 'Sale Invoice',
      invoiceDate: txnDate,
      sellerNTNCNIC: fbrConn.sellerNTNCNIC || '',
      sellerBusinessName: fbrConn.sellerBusinessName || '',
      sellerProvince: fbrConn.sellerProvince || '',
      sellerAddress: fbrConn.sellerAddress || '',
      buyerNTNCNIC: buyerNtn,
      buyerBusinessName: customer,
      buyerProvince: 'SINDH',
      buyerAddress: 'KARACHI',
      buyerRegistrationType: buyerReg,
      invoiceRefNo: '',
      scenarioId,
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
