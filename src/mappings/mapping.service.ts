import { BadRequestException, Injectable } from '@nestjs/common';
import { IntegrationMode, MappingSection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QboService } from '../qbo/qbo.service';
import {
  DEFAULT_MAPPINGS,
  FBR_DEFAULT_MAPPINGS,
  collectQboKeys,
  resolveSampleValue,
  type DefaultMapping,
} from './mapping.defaults';

@Injectable()
export class MappingService {
  constructor(
    private prisma: PrismaService,
    private qbo: QboService,
  ) {}

  private async defaultsFor(organizationId: string): Promise<{
    mode: IntegrationMode;
    mappings: DefaultMapping[];
  }> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { integrationMode: true },
    });
    const mode = org?.integrationMode || IntegrationMode.PRA;
    return {
      mode,
      mappings: mode === IntegrationMode.FBR ? FBR_DEFAULT_MAPPINGS : DEFAULT_MAPPINGS,
    };
  }

  async ensureDefaults(organizationId: string) {
    const { mappings: defaults } = await this.defaultsFor(organizationId);
    const existing = await this.prisma.fieldMapping.findMany({
      where: { organizationId },
    });
    const byKey = new Map(
      existing.map((e) => [`${e.section}:${e.targetField}`, e] as const),
    );
    const allowed = new Set(defaults.map((m) => `${m.section}:${m.targetField}`));

    const staleIds = existing
      .filter((e) => !allowed.has(`${e.section}:${e.targetField}`))
      .map((e) => e.id);
    if (staleIds.length) {
      await this.prisma.fieldMapping.deleteMany({
        where: { id: { in: staleIds } },
      });
      for (const id of staleIds) {
        const row = existing.find((e) => e.id === id);
        if (row) byKey.delete(`${row.section}:${row.targetField}`);
      }
    }

    const missing = defaults.filter(
      (m) => !byKey.has(`${m.section}:${m.targetField}`),
    );

    if (missing.length) {
      await this.prisma.fieldMapping.createMany({
        data: missing.map((m) => ({
          organizationId,
          section: m.section as MappingSection,
          targetField: m.targetField,
          sourceField: m.sourceField,
          isRequired: m.isRequired,
          sortOrder: m.sortOrder,
        })),
      });
    }

    const syncOps = defaults.flatMap((m) => {
      const row = byKey.get(`${m.section}:${m.targetField}`);
      if (!row) return [];
      if (row.sortOrder === m.sortOrder && row.isRequired === m.isRequired) {
        return [];
      }
      return [
        this.prisma.fieldMapping.update({
          where: { id: row.id },
          data: { sortOrder: m.sortOrder, isRequired: m.isRequired },
        }),
      ];
    });
    if (syncOps.length) {
      await this.prisma.$transaction(syncOps);
    }
  }

  async saveMappings(
    organizationId: string,
    items: { id: string; sourceField: string }[],
    invoiceId?: string,
  ) {
    if (!items?.length) throw new BadRequestException('No mappings to save');

    const ids = items.map((i) => i.id);
    const rows = await this.prisma.fieldMapping.findMany({
      where: { organizationId, id: { in: ids } },
    });
    if (rows.length !== items.length) {
      throw new BadRequestException('One or more mapping rows are invalid');
    }

    await this.prisma.$transaction(
      items.map((item) =>
        this.prisma.fieldMapping.update({
          where: { id: item.id },
          data: { sourceField: item.sourceField ?? '' },
        }),
      ),
    );

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        action: 'MAPPINGS_SAVED',
        entity: 'FieldMapping',
        meta: { count: items.length },
      },
    });

    return this.getWorkspace(organizationId, invoiceId);
  }

  async getWorkspace(organizationId: string, invoiceId?: string) {
    await this.ensureDefaults(organizationId);
    const { mode, mappings: defaults } = await this.defaultsFor(organizationId);

    const [pra, fbr, qbo] = await Promise.all([
      this.prisma.praConnection.findUnique({ where: { organizationId } }),
      this.prisma.fbrConnection.findUnique({ where: { organizationId } }),
      this.prisma.qboConnection.findUnique({ where: { organizationId } }),
    ]);

    let sampleInvoice: any = null;
    let sampleMeta: any = null;
    let invoices: any[] = [];

    if (qbo?.status === 'CONNECTED') {
      try {
        invoices = await this.qbo.listInvoices(organizationId, 10);
        const chosenId = invoiceId || invoices[0]?.Id;
        if (chosenId) {
          sampleInvoice = await this.qbo.getInvoice(organizationId, chosenId);
          sampleMeta = {
            Id: sampleInvoice?.Id,
            DocNumber: sampleInvoice?.DocNumber,
            TxnDate: sampleInvoice?.TxnDate,
            TotalAmt: sampleInvoice?.TotalAmt,
            Customer: sampleInvoice?.CustomerRef?.name,
          };
        }
      } catch (err: any) {
        // keep workspace usable even if fetch fails
        sampleMeta = { error: err?.message || 'Failed to fetch QBO invoice' };
      }
    }

    const rows = await this.prisma.fieldMapping.findMany({
      where: { organizationId },
      orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }],
    });

    const canonicalOrder = new Map(
      defaults.map((m) => [`${m.section}:${m.targetField}`, m.sortOrder]),
    );
    const sortedRows = [...rows].sort((a, b) => {
      const sectionCmp = String(a.section).localeCompare(String(b.section));
      if (sectionCmp !== 0) return sectionCmp;
      const ao =
        canonicalOrder.get(`${a.section}:${a.targetField}`) ?? a.sortOrder;
      const bo =
        canonicalOrder.get(`${b.section}:${b.targetField}`) ?? b.sortOrder;
      return ao - bo;
    });

    const enrich = (row: any) => ({
      id: row.id,
      section: row.section,
      praKey: row.targetField,
      qboKey: row.sourceField,
      isRequired: row.isRequired,
      sortOrder:
        canonicalOrder.get(`${row.section}:${row.targetField}`) ?? row.sortOrder,
      value: sampleInvoice
        ? resolveSampleValue(sampleInvoice, row.sourceField, {
            posId: pra?.posId,
            fbr,
          })
        : null,
    });

    return {
      mode,
      targetLabel: mode === IntegrationMode.FBR ? 'FBR' : 'PRA',
      connected: qbo?.status === 'CONNECTED',
      companyName: qbo?.companyName,
      sample: sampleMeta,
      invoices: invoices.map((i: any) => ({
        Id: i.Id,
        DocNumber: i.DocNumber,
        TxnDate: i.TxnDate,
        TotalAmt: i.TotalAmt,
        Customer: i.CustomerRef?.name,
      })),
      availableQboKeys: collectQboKeys(sampleInvoice),
      header: sortedRows.filter((r) => r.section === 'HEADER').map(enrich),
      lines: sortedRows.filter((r) => r.section === 'LINE').map(enrich),
    };
  }

  async swapSources(
    organizationId: string,
    section: MappingSection,
    fromId: string,
    toId: string,
  ) {
    const [a, b] = await Promise.all([
      this.prisma.fieldMapping.findFirst({ where: { id: fromId, organizationId, section } }),
      this.prisma.fieldMapping.findFirst({ where: { id: toId, organizationId, section } }),
    ]);
    if (!a || !b) throw new BadRequestException('Mapping rows not found');

    // Swap QBO source fields only (PRA targets stay fixed)
    await this.prisma.$transaction([
      this.prisma.fieldMapping.update({
        where: { id: a.id },
        data: { sourceField: b.sourceField },
      }),
      this.prisma.fieldMapping.update({
        where: { id: b.id },
        data: { sourceField: a.sourceField },
      }),
    ]);

    return this.getWorkspace(organizationId);
  }

  async updateSource(
    organizationId: string,
    id: string,
    sourceField: string,
  ) {
    const row = await this.prisma.fieldMapping.findFirst({
      where: { id, organizationId },
    });
    if (!row) throw new BadRequestException('Mapping not found');
    await this.prisma.fieldMapping.update({
      where: { id },
      data: { sourceField },
    });
    return this.getWorkspace(organizationId);
  }

  async moveSource(
    organizationId: string,
    section: MappingSection,
    id: string,
    direction: 'up' | 'down',
  ) {
    const rows = await this.prisma.fieldMapping.findMany({
      where: { organizationId, section },
      orderBy: { sortOrder: 'asc' },
    });
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) throw new BadRequestException('Row not found');
    const swapWith = direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= rows.length) {
      return this.getWorkspace(organizationId);
    }
    return this.swapSources(organizationId, section, rows[idx].id, rows[swapWith].id);
  }
}
