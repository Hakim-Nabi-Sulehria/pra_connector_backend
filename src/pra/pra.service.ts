import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import axios from 'axios';
import {
  ConnectionStatus,
  InvoiceSyncStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QboService } from '../qbo/qbo.service';
import {
  resolveLineValue,
  resolveSampleValue,
  type MappingExtras,
} from '../mappings/mapping.defaults';

export type PraPostItem = {
  ItemCode: string;
  ItemName: string;
  Quantity: number;
  PCTCode: string;
  TaxRate: number;
  SaleValue: number;
  TotalAmount: number;
  TaxCharged: number;
  Discount: number;
  FurtherTax: number;
  InvoiceType: number;
  RefUSIN: string | null;
};

export type PraPostPayload = {
  InvoiceNumber: string;
  POSID: number;
  USIN: string;
  DateTime: string;
  BuyerPNTN: string;
  BuyerCNIC: string;
  BuyerName: string;
  BuyerPhoneNumber: string;
  TotalBillAmount: number;
  TotalQuantity: number;
  TotalSaleValue: number;
  TotalTaxCharged: number;
  Discount: number;
  FurtherTax: number;
  PaymentMode: number;
  RefUSIN: string | null;
  InvoiceType: number;
  Items: PraPostItem[];
};

export type InvoiceDraft = {
  header?: Record<string, unknown>;
  customer?: Record<string, unknown>;
  lines?: Array<Record<string, unknown>>;
  totals?: Record<string, unknown>;
};

function defaultPraUrl(environment: string) {
  return environment === 'production'
    ? 'https://ims.pral.com.pk/ims/production/api/Live/PostData'
    : 'https://ims.pral.com.pk/ims/sandbox/api/Live/PostData';
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function formatPraDateTime(value: unknown): string {
  if (!value) {
    const now = new Date();
    return now.toISOString().slice(0, 19).replace('T', ' ');
  }
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(raw)) return raw.slice(0, 19);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

function mergeCustomField(
  fields: any[] | undefined,
  name: string,
  value: unknown,
): any[] {
  const list = Array.isArray(fields) ? [...fields] : [];
  const idx = list.findIndex(
    (cf) => String(cf?.Name || '').toLowerCase() === name.toLowerCase(),
  );
  const entry = {
    ...(idx >= 0 ? list[idx] : { Name: name }),
    Name: name,
    Type: 'StringType',
    StringValue: str(value),
  };
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
  return list;
}

@Injectable()
export class PraService {
  private readonly logger = new Logger(PraService.name);

  constructor(
    private prisma: PrismaService,
    private qbo: QboService,
  ) {}

  private async getConnection(organizationId: string) {
    const conn = await this.prisma.praConnection.findUnique({
      where: { organizationId },
    });
    if (!conn?.apiToken?.trim()) {
      throw new BadRequestException(
        'PRA bearer token is not configured for this company',
      );
    }
    if (!conn.posId?.trim()) {
      throw new BadRequestException('PRA POS ID is not configured for this company');
    }
    const posId = Number(conn.posId);
    if (!Number.isFinite(posId) || posId <= 0) {
      throw new BadRequestException('PRA POS ID must be a valid number');
    }
    return { ...conn, posIdNumber: posId };
  }

  applyDraftToQboInvoice(invoice: any, draft?: InvoiceDraft | null): any {
    if (!draft) return invoice;
    const merged = { ...invoice };
    const header = draft.header || {};
    const customer = draft.customer || {};
    const totals = draft.totals || {};

    if (header.docNumber != null) merged.DocNumber = header.docNumber;
    if (header.txnDate != null) merged.TxnDate = header.txnDate;
    if (header.dueDate != null) merged.DueDate = header.dueDate;
    if (header.terms != null) {
      merged.SalesTermRef = { ...(merged.SalesTermRef || {}), name: header.terms };
    }
    if (header.emailStatus != null) merged.EmailStatus = header.emailStatus;
    if (header.printStatus != null) merged.PrintStatus = header.printStatus;
    if (header.hsCode != null) {
      merged.CustomField = mergeCustomField(merged.CustomField, 'HS Code', header.hsCode);
    }
    if (header.fiscalInvoice != null) {
      merged.CustomField = mergeCustomField(
        merged.CustomField,
        'Fiscal Invoice',
        header.fiscalInvoice,
      );
    }

    if (customer.name != null) {
      merged.CustomerRef = {
        ...(merged.CustomerRef || {}),
        name: customer.name,
      };
    }
    if (customer.id != null) {
      merged.CustomerRef = {
        ...(merged.CustomerRef || {}),
        value: customer.id,
      };
    }
    if (customer.billTo != null) {
      merged.BillAddr = { ...(merged.BillAddr || {}), Line1: customer.billTo };
    }
    if (customer.shipTo != null) {
      merged.ShipAddr = { ...(merged.ShipAddr || {}), Line1: customer.shipTo };
    }

    if (totals.customerMemo != null) {
      merged.CustomerMemo = { value: totals.customerMemo };
    }

    const sales = (merged.Line || []).filter(
      (l: any) => l?.DetailType === 'SalesItemLineDetail',
    );
    if (Array.isArray(draft.lines) && draft.lines.length) {
      let salesIdx = 0;
      merged.Line = (merged.Line || []).map((line: any) => {
        if (line?.DetailType !== 'SalesItemLineDetail') return line;
        const draftLine = draft.lines?.[salesIdx] || {};
        salesIdx += 1;
        const detail = { ...(line.SalesItemLineDetail || {}) };
        if (draftLine.itemCode != null) {
          detail.ItemRef = { ...(detail.ItemRef || {}), value: draftLine.itemCode };
        }
        if (draftLine.itemName != null) {
          detail.ItemRef = {
            ...(detail.ItemRef || {}),
            name: draftLine.itemName,
          };
        }
        if (draftLine.qty != null) detail.Qty = draftLine.qty;
        const nextLine = { ...line, SalesItemLineDetail: detail };
        if (draftLine.saleValue != null) nextLine.Amount = draftLine.saleValue;
        if (draftLine.pctCode != null) {
          nextLine.CustomField = mergeCustomField(
            nextLine.CustomField,
            'PCTCode',
            draftLine.pctCode,
          );
        }
        return nextLine;
      });

      if (totals.totalTax != null && sales.length) {
        merged.TxnTaxDetail = {
          ...(merged.TxnTaxDetail || {}),
          TotalTax: totals.totalTax,
        };
      }
    }

    return merged;
  }

  buildPayloadFromQboInvoice(
    qboInvoice: any,
    praConn: { posId: string | null; posIdNumber?: number },
    mappings: Array<{
      section: string;
      targetField: string;
      sourceField: string;
    }>,
    draft?: InvoiceDraft | null,
  ): PraPostPayload {
    const invoice = this.applyDraftToQboInvoice(qboInvoice, draft);
    const extras: MappingExtras = { posId: praConn.posId };
    const headerMap = new Map(
      mappings
        .filter((m) => m.section === 'HEADER')
        .map((m) => [m.targetField, m.sourceField]),
    );
    const lineMap = new Map(
      mappings
        .filter((m) => m.section === 'LINE')
        .map((m) => [m.targetField, m.sourceField]),
    );

    const header = (key: string, fallback: any = '') => {
      const source = headerMap.get(key);
      if (!source) return fallback;
      const value = resolveSampleValue(invoice, source, extras);
      return value == null || value === '' ? fallback : value;
    };

    const salesLines = (invoice?.Line || []).filter(
      (l: any) => l?.DetailType === 'SalesItemLineDetail',
    );

    const itemFromLine = (line: any): PraPostItem => {
      const mapped = (key: string, fallback: any) => {
        const source = lineMap.get(key);
        if (!source) return fallback;
        const value = resolveLineValue(invoice, line, source, extras);
        return value == null || value === '' ? fallback : value;
      };
      const saleValue = num(mapped('SaleValue', line?.Amount), 0);
      const taxRate = num(mapped('TaxRate', 0), 0);
      const taxCharged = num(mapped('TaxCharged', saleValue * (taxRate / 100)), 0);
      const discount = num(mapped('Discount', 0), 0);
      const furtherTax = num(mapped('FurtherTax', 0), 0);
      const totalAmount = num(
        mapped('TotalAmount', saleValue + taxCharged + furtherTax - discount),
        0,
      );
      const pct = str(mapped('PCTCode', '00000000'), '00000000').slice(0, 8);
      return {
        ItemCode: str(mapped('ItemCode', '0000'), '0000'),
        ItemName: str(
          mapped('ItemName', line?.Description || 'Item'),
          'Item',
        ),
        Quantity: num(mapped('Quantity', 1), 1),
        PCTCode: pct.padStart(8, '0').slice(-8),
        TaxRate: taxRate,
        SaleValue: saleValue,
        TotalAmount: totalAmount,
        TaxCharged: taxCharged,
        Discount: discount,
        FurtherTax: furtherTax,
        InvoiceType: num(mapped('InvoiceType', 1), 1),
        RefUSIN: mapped('RefUSIN', null) ? str(mapped('RefUSIN', ''), '') : null,
      };
    };

    const items = salesLines.length
      ? salesLines.map(itemFromLine)
      : [itemFromLine({ Amount: 0, SalesItemLineDetail: { Qty: 1 } })];

    const totalQty =
      draft?.totals?.totalQty != null
        ? num(draft.totals.totalQty)
        : items.reduce((s: number, i: PraPostItem) => s + i.Quantity, 0);
    const totalSaleValue =
      draft?.totals?.totalSaleValue != null
        ? num(draft.totals.totalSaleValue)
        : items.reduce((s: number, i: PraPostItem) => s + i.SaleValue, 0);
    const totalTaxCharged =
      draft?.totals?.totalTax != null
        ? num(draft.totals.totalTax)
        : items.reduce((s: number, i: PraPostItem) => s + i.TaxCharged, 0);
    const discount =
      draft?.totals?.totalDisc != null
        ? num(draft.totals.totalDisc)
        : num(header('Discount', 0), 0);
    const furtherTax =
      draft?.totals?.totalFurtherTax != null
        ? num(draft.totals.totalFurtherTax)
        : num(header('FurtherTax', 0), 0);
    const totalBillAmount =
      draft?.totals?.totalAmount != null
        ? num(draft.totals.totalAmount)
        : num(header('TotalBillAmount', invoice?.TotalAmt), 0) ||
          items.reduce((s: number, i: PraPostItem) => s + i.TotalAmount, 0);

    const refUsinRaw = draft?.totals?.refUsin ?? header('RefUSIN', null);
    const refUsin =
      refUsinRaw == null || refUsinRaw === '' || refUsinRaw === 'null'
        ? null
        : str(refUsinRaw);

    const posId =
      praConn.posIdNumber ?? Number(praConn.posId);

    return {
      InvoiceNumber: str(header('InvoiceNumber', ''), ''),
      POSID: posId,
      USIN: str(header('USIN', invoice?.DocNumber || invoice?.Id), ''),
      DateTime: formatPraDateTime(header('DateTime', invoice?.TxnDate)),
      BuyerPNTN: str(header('BuyerPNTN', ''), ''),
      BuyerCNIC: str(header('BuyerCNIC', ''), ''),
      BuyerName: str(header('BuyerName', invoice?.CustomerRef?.name), ''),
      BuyerPhoneNumber: str(header('BuyerPhoneNumber', ''), ''),
      TotalBillAmount: totalBillAmount,
      TotalQuantity: totalQty,
      TotalSaleValue: totalSaleValue,
      TotalTaxCharged: totalTaxCharged,
      Discount: discount,
      FurtherTax: furtherTax,
      PaymentMode: num(
        draft?.totals?.paymentMode ?? header('PaymentMode', 1),
        1,
      ),
      RefUSIN: refUsin,
      InvoiceType: num(
        draft?.totals?.invoiceType ?? header('InvoiceType', 1),
        1,
      ),
      Items: items,
    };
  }

  async postToPra(organizationId: string, payload: PraPostPayload) {
    const conn = await this.getConnection(organizationId);
    const url = (conn.apiUrl || defaultPraUrl(conn.environment)).trim();

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
      this.logger.error(`PRA PostData transport error: ${err.message}`);
      throw new BadRequestException(
        `PRA PostData request failed: ${err.message}`,
      );
    }
  }

  parsePost(body: any): {
    ok: boolean;
    fiscalInvoiceNo?: string;
    code?: string;
    message?: string;
  } {
    const code = body?.Code != null ? String(body.Code) : undefined;
    const fiscalInvoiceNo = body?.InvoiceNumber?.toString();
    const message = body?.Response?.toString() || body?.Message?.toString();
    const ok = code === '100' && Boolean(fiscalInvoiceNo);
    return { ok, fiscalInvoiceNo, code, message };
  }

  async saveDraft(
    organizationId: string,
    qboInvoiceId: string,
    draft: InvoiceDraft,
    meta?: { usin?: string; customerName?: string; totalAmount?: number },
  ) {
    const existing = await this.prisma.invoiceSync.findUnique({
      where: {
        organizationId_qboInvoiceId: { organizationId, qboInvoiceId },
      },
    });
    if (existing?.status === 'POSTED') {
      throw new BadRequestException(
        'Cannot edit an invoice that has already been posted to PRA',
      );
    }

    const praPayload = {
      draft,
      savedAt: new Date().toISOString(),
    };

    return this.prisma.invoiceSync.upsert({
      where: {
        organizationId_qboInvoiceId: { organizationId, qboInvoiceId },
      },
      create: {
        organizationId,
        qboInvoiceId,
        usin: meta?.usin,
        customerName: meta?.customerName,
        totalAmount: meta?.totalAmount,
        status: InvoiceSyncStatus.PENDING,
        praPayload: praPayload as any,
      },
      update: {
        usin: meta?.usin ?? undefined,
        customerName: meta?.customerName ?? undefined,
        totalAmount: meta?.totalAmount ?? undefined,
        praPayload: praPayload as any,
      },
    });
  }

  async postInvoice(
    organizationId: string,
    qboInvoiceId: string,
    options?: { writeToQbo?: boolean; qboCustomFieldName?: string },
  ) {
    const conn = await this.getConnection(organizationId);
    const writeToQbo = options?.writeToQbo !== false;
    const fieldName = options?.qboCustomFieldName?.trim() || 'Fiscal Invoice';

    let qboInvoice = await this.qbo.getInvoice(organizationId, qboInvoiceId);
    const [mappings, existing] = await Promise.all([
      this.prisma.fieldMapping.findMany({
        where: { organizationId },
        orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }],
      }),
      this.prisma.invoiceSync.findUnique({
        where: {
          organizationId_qboInvoiceId: { organizationId, qboInvoiceId },
        },
      }),
    ]);

    const draft = (existing?.praPayload as any)?.draft as InvoiceDraft | undefined;
    const payload = this.buildPayloadFromQboInvoice(
      qboInvoice,
      { posId: conn.posId, posIdNumber: conn.posIdNumber },
      mappings,
      draft,
    );

    if (!payload.USIN?.trim()) {
      throw new BadRequestException('USIN (invoice number) is required for PRA posting');
    }
    if (!payload.Items.every((i) => i.PCTCode && i.PCTCode !== '00000000')) {
      // warn but allow - PCT might be required by PRA
    }

    const result = await this.postToPra(organizationId, payload);
    const parsed = this.parsePost(result.body);

    if (!parsed.ok) {
      const msg =
        parsed.message ||
        `PRA rejected the invoice (Code: ${parsed.code || 'unknown'})`;
      await this.prisma.invoiceSync.upsert({
        where: {
          organizationId_qboInvoiceId: { organizationId, qboInvoiceId },
        },
        create: {
          organizationId,
          qboInvoiceId,
          usin: payload.USIN,
          customerName: qboInvoice?.CustomerRef?.name || null,
          totalAmount: payload.TotalBillAmount,
          status: InvoiceSyncStatus.FAILED,
          praPayload: { draft, submitted: payload } as any,
          praResponse: result.body,
          errorMessage: msg,
        },
        update: {
          status: InvoiceSyncStatus.FAILED,
          praPayload: { draft, submitted: payload } as any,
          praResponse: result.body,
          errorMessage: msg,
        },
      });
      throw new BadRequestException(msg);
    }

    const fiscalInvoiceNo = parsed.fiscalInvoiceNo!;
    let qboWriteVerified = false;
    let qboWriteError: string | null = null;

    if (writeToQbo) {
      try {
        const qboWrite = await this.qbo.updateInvoiceCustomField(
          organizationId,
          qboInvoiceId,
          fieldName,
          fiscalInvoiceNo,
        );
        qboWriteVerified = Boolean(qboWrite?._writeMeta?.verified);
        qboInvoice = qboWrite;
        if (!qboWriteVerified) {
          qboWriteError = 'QBO accepted the update but the value did not persist';
        }
      } catch (e: any) {
        qboWriteError =
          e?.response?.message || e?.message || 'Failed to write custom field to QBO';
      }
    }

    const row = await this.prisma.invoiceSync.upsert({
      where: {
        organizationId_qboInvoiceId: { organizationId, qboInvoiceId },
      },
      create: {
        organizationId,
        qboInvoiceId,
        usin: payload.USIN,
        customerName: qboInvoice?.CustomerRef?.name || null,
        totalAmount: payload.TotalBillAmount,
        status: InvoiceSyncStatus.POSTED,
        fiscalInvoiceNo,
        postedAt: new Date(),
        praPayload: { draft, submitted: payload } as any,
        praResponse: {
          ...result.body,
          qboCustomFieldName: fieldName,
          qboWriteOk: qboWriteVerified,
          qboWriteVerified,
          qboWriteError,
          httpStatus: result.httpStatus,
          requestUrl: result.requestUrl,
        },
      },
      update: {
        usin: payload.USIN,
        customerName: qboInvoice?.CustomerRef?.name || null,
        totalAmount: payload.TotalBillAmount,
        status: InvoiceSyncStatus.POSTED,
        fiscalInvoiceNo,
        postedAt: new Date(),
        errorMessage: null,
        praPayload: { draft, submitted: payload } as any,
        praResponse: {
          ...result.body,
          qboCustomFieldName: fieldName,
          qboWriteOk: qboWriteVerified,
          qboWriteVerified,
          qboWriteError,
          httpStatus: result.httpStatus,
          requestUrl: result.requestUrl,
        },
      },
    });

    await this.prisma.praConnection.update({
      where: { organizationId },
      data: {
        status: ConnectionStatus.CONNECTED,
        lastPostedAt: new Date(),
      },
    });

    return {
      ...row,
      qboWriteOk: qboWriteVerified,
      qboWriteVerified,
      qboWriteError,
      praCode: parsed.code,
      praMessage: parsed.message,
    };
  }
}
