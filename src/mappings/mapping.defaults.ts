export type MappingSection = 'HEADER' | 'LINE';

export type DefaultMapping = {
  section: MappingSection;
  targetField: string;
  sourceField: string;
  isRequired: boolean;
  sortOrder: number;
};

/** Complete PRA invoice fields with sensible QBO defaults */
export const DEFAULT_MAPPINGS: DefaultMapping[] = [
  // HEADER
  { section: 'HEADER', targetField: 'InvoiceNumber', sourceField: '', isRequired: false, sortOrder: 0 },
  { section: 'HEADER', targetField: 'POSID', sourceField: 'pra.posId', isRequired: true, sortOrder: 1 },
  { section: 'HEADER', targetField: 'USIN', sourceField: 'DocNumber', isRequired: true, sortOrder: 2 },
  { section: 'HEADER', targetField: 'DateTime', sourceField: 'TxnDate', isRequired: true, sortOrder: 3 },
  { section: 'HEADER', targetField: 'BuyerName', sourceField: 'CustomerRef.name', isRequired: false, sortOrder: 4 },
  { section: 'HEADER', targetField: 'BuyerPNTN', sourceField: 'Customer.PrimaryTaxIdentifier', isRequired: false, sortOrder: 5 },
  { section: 'HEADER', targetField: 'BuyerCNIC', sourceField: '', isRequired: false, sortOrder: 6 },
  { section: 'HEADER', targetField: 'BuyerPhoneNumber', sourceField: 'BillAddr.Line1', isRequired: false, sortOrder: 7 },
  { section: 'HEADER', targetField: 'TotalSaleValue', sourceField: 'TxnTaxDetail.TaxLine.0.TaxLineDetail.NetAmountTaxable', isRequired: true, sortOrder: 8 },
  { section: 'HEADER', targetField: 'TotalTaxCharged', sourceField: 'TxnTaxDetail.TotalTax', isRequired: true, sortOrder: 9 },
  { section: 'HEADER', targetField: 'Discount', sourceField: '', isRequired: false, sortOrder: 10 },
  { section: 'HEADER', targetField: 'FurtherTax', sourceField: '', isRequired: false, sortOrder: 11 },
  { section: 'HEADER', targetField: 'TotalBillAmount', sourceField: 'TotalAmt', isRequired: true, sortOrder: 12 },
  { section: 'HEADER', targetField: 'TotalQuantity', sourceField: 'derived.TotalQuantity', isRequired: false, sortOrder: 13 },
  { section: 'HEADER', targetField: 'PaymentMode', sourceField: 'derived.PaymentMode', isRequired: true, sortOrder: 14 },
  { section: 'HEADER', targetField: 'RefUSIN', sourceField: '', isRequired: false, sortOrder: 15 },
  { section: 'HEADER', targetField: 'InvoiceType', sourceField: 'derived.InvoiceType', isRequired: true, sortOrder: 16 },

  // LINE
  { section: 'LINE', targetField: 'ItemCode', sourceField: 'Line.SalesItemLineDetail.ItemRef.value', isRequired: true, sortOrder: 0 },
  { section: 'LINE', targetField: 'ItemName', sourceField: 'Line.SalesItemLineDetail.ItemRef.name', isRequired: true, sortOrder: 1 },
  { section: 'LINE', targetField: 'PCTCode', sourceField: 'custom.PCTCode', isRequired: true, sortOrder: 2 },
  { section: 'LINE', targetField: 'Quantity', sourceField: 'Line.SalesItemLineDetail.Qty', isRequired: true, sortOrder: 3 },
  { section: 'LINE', targetField: 'TaxRate', sourceField: 'TxnTaxDetail.TaxLine.0.TaxLineDetail.TaxPercent', isRequired: true, sortOrder: 4 },
  { section: 'LINE', targetField: 'SaleValue', sourceField: 'Line.Amount', isRequired: true, sortOrder: 5 },
  { section: 'LINE', targetField: 'Discount', sourceField: '', isRequired: false, sortOrder: 6 },
  { section: 'LINE', targetField: 'FurtherTax', sourceField: '', isRequired: false, sortOrder: 7 },
  { section: 'LINE', targetField: 'TaxCharged', sourceField: 'derived.LineTaxCharged', isRequired: true, sortOrder: 8 },
  { section: 'LINE', targetField: 'TotalAmount', sourceField: 'derived.LineTotalAmount', isRequired: true, sortOrder: 9 },
  { section: 'LINE', targetField: 'InvoiceType', sourceField: 'derived.InvoiceType', isRequired: true, sortOrder: 10 },
  { section: 'LINE', targetField: 'RefUSIN', sourceField: '', isRequired: false, sortOrder: 11 },
];

export function getByPath(obj: any, path: string): any {
  if (!path || !obj) return null;
  if (path.startsWith('derived.') || path.startsWith('pra.') || path.startsWith('custom.')) {
    return null; // resolved separately
  }
  const parts = path.split('.');
  let cur: any = obj;
  for (const part of parts) {
    if (cur == null) return null;
    if (part === 'Line') {
      const list = Array.isArray(cur.Line) ? cur.Line : Array.isArray(cur) ? cur : [];
      const sales = list.filter((l: any) => l?.DetailType === 'SalesItemLineDetail');
      cur = sales[0] || null;
      continue;
    }
    if (/^\d+$/.test(part)) {
      cur = cur[Number(part)];
      continue;
    }
    cur = cur[part];
  }
  return cur ?? null;
}

export function resolveSampleValue(
  invoice: any,
  sourceField: string,
  extras?: { posId?: string | null },
): any {
  if (!sourceField) return null;
  if (sourceField === 'pra.posId') return extras?.posId ?? null;
  if (sourceField === 'derived.PaymentMode') return 1;
  if (sourceField === 'derived.InvoiceType') return 1;
  if (sourceField === 'derived.TotalQuantity') {
    const lines = (invoice?.Line || []).filter(
      (l: any) => l.DetailType === 'SalesItemLineDetail',
    );
    return lines.reduce((s: number, l: any) => s + (Number(l.SalesItemLineDetail?.Qty) || 0), 0);
  }
  if (sourceField === 'derived.LineTaxCharged') {
    const line = (invoice?.Line || []).find((l: any) => l.DetailType === 'SalesItemLineDetail');
    const sale = Number(line?.Amount) || 0;
    const rate =
      Number(invoice?.TxnTaxDetail?.TaxLine?.[0]?.TaxLineDetail?.TaxPercent) || 0;
    return Math.round(sale * (rate / 100) * 100) / 100;
  }
  if (sourceField === 'derived.LineTotalAmount') {
    const line = (invoice?.Line || []).find((l: any) => l.DetailType === 'SalesItemLineDetail');
    const sale = Number(line?.Amount) || 0;
    const rate =
      Number(invoice?.TxnTaxDetail?.TaxLine?.[0]?.TaxLineDetail?.TaxPercent) || 0;
    const tax = Math.round(sale * (rate / 100) * 100) / 100;
    return Math.round((sale + tax) * 100) / 100;
  }
  if (sourceField === 'custom.PCTCode') return null;

  // Support indexed path like TxnTaxDetail.TaxLine.0.TaxLineDetail.TaxPercent
  if (/\.\d+\./.test(sourceField) || /\.\d+$/.test(sourceField)) {
    const parts = sourceField.split('.');
    let cur: any = invoice;
    for (const part of parts) {
      if (cur == null) return null;
      cur = /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
    }
    return cur ?? null;
  }

  return getByPath(invoice, sourceField);
}

/** Flatten useful QBO keys from a sample invoice for the picker / display */
export function collectQboKeys(invoice: any): string[] {
  const keys = new Set<string>([
    'DocNumber',
    'TxnDate',
    'TotalAmt',
    'Balance',
    'CustomerRef.name',
    'CustomerRef.value',
    'BillEmail.Address',
    'BillAddr.Line1',
    'BillAddr.Line2',
    'TxnTaxDetail.TotalTax',
    'TxnTaxDetail.TaxLine.0.TaxLineDetail.TaxPercent',
    'TxnTaxDetail.TaxLine.0.TaxLineDetail.NetAmountTaxable',
    'Line.SalesItemLineDetail.ItemRef.value',
    'Line.SalesItemLineDetail.ItemRef.name',
    'Line.SalesItemLineDetail.Qty',
    'Line.SalesItemLineDetail.UnitPrice',
    'Line.Amount',
    'Line.Description',
    'derived.TotalQuantity',
    'derived.PaymentMode',
    'derived.InvoiceType',
    'derived.LineTaxCharged',
    'derived.LineTotalAmount',
    'pra.posId',
    'custom.PCTCode',
    '',
  ]);
  if (invoice?.DocNumber != null) keys.add('DocNumber');
  return Array.from(keys);
}
