import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IntegrationMode, Role } from '@prisma/client';
import { JwtAuthGuard, Roles, RolesGuard } from '../common/guards';
import { assertModeMatch } from '../common/integration-mode';
import { PrismaService } from '../prisma/prisma.service';
import { QboService } from '../qbo/qbo.service';
import { FbrService } from '../fbr/fbr.service';

@Controller('fbr/customer')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CUSTOMER_ADMIN, Role.CUSTOMER_USER)
export class FbrCustomerController {
  constructor(
    private prisma: PrismaService,
    private qbo: QboService,
    private fbr: FbrService,
  ) {}

  private orgId(req: any) {
    const organizationId = req.user?.organizationId as string | null | undefined;
    if (!organizationId) {
      throw new ForbiddenException(
        'Your account is not linked to a company workspace',
      );
    }
    assertModeMatch(
      IntegrationMode.FBR,
      req.user?.integrationMode || req.user?.organization?.integrationMode,
      'Workspace',
    );
    return organizationId;
  }

  @Get('connections')
  async connections(@Req() req: any) {
    const organizationId = this.orgId(req);
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, pntn: true, qbo: true, fbr: true, integrationMode: true },
    });
    if (!org) return org;
    const { apiToken, ...fbrSafe } = org.fbr || {};
    return {
      ...org,
      fbr: org.fbr
        ? { ...fbrSafe, hasToken: Boolean(apiToken) }
        : null,
      qbo: org.qbo
        ? (() => {
            const { accessToken, refreshToken, ...qboSafe } = org.qbo!;
            return qboSafe;
          })()
        : null,
    };
  }

  @Get('invoices')
  async invoices(@Req() req: any) {
    const organizationId = this.orgId(req);
    const [tracked, qboInvoices] = await Promise.all([
      this.prisma.fbrInvoiceSync.findMany({
        where: { organizationId },
        orderBy: { updatedAt: 'desc' },
      }),
      this.qbo.listInvoices(organizationId).catch(() => []),
    ]);
    const byQbo = new Map(tracked.map((t) => [t.qboInvoiceId, t]));
    return (qboInvoices as any[]).map((inv) => ({
      qboInvoiceId: inv.Id,
      docNumber: inv.DocNumber,
      customerName: inv.CustomerRef?.name,
      total: inv.TotalAmt,
      txnDate: inv.TxnDate,
      tracked: byQbo.get(inv.Id) || null,
      fbrInvoiceNo: byQbo.get(inv.Id)?.fbrInvoiceNo || null,
    }));
  }

  @Get('invoices/sync')
  async invoiceSyncRows(@Req() req: any) {
    return this.prisma.fbrInvoiceSync.findMany({
      where: { organizationId: this.orgId(req) },
      orderBy: { updatedAt: 'desc' },
    });
  }

  @Post('invoices/:qboInvoiceId/validate')
  async validateInvoice(
    @Req() req: any,
    @Param('qboInvoiceId') qboInvoiceId: string,
    @Body() body: { scenarioId?: 'SN001' | 'SN002' },
  ) {
    const organizationId = this.orgId(req);
    const scenarioId = body?.scenarioId || 'SN001';

    const [fbrConn, qboInvoice] = await Promise.all([
      this.prisma.fbrConnection.findUnique({ where: { organizationId } }),
      this.qbo.getInvoice(organizationId, qboInvoiceId),
    ]);
    if (!fbrConn) {
      throw new BadRequestException('FBR connection is not configured for this company');
    }

    const payload = this.fbr.buildPayloadFromQboInvoice(
      qboInvoice,
      fbrConn,
      scenarioId,
    );

    const result = await this.fbr.validateAndStore(
      organizationId,
      qboInvoiceId,
      payload,
      {
        usin: qboInvoice?.DocNumber || qboInvoiceId,
        customerName: qboInvoice?.CustomerRef?.name,
        totalAmount: Number(qboInvoice?.TotalAmt || 0),
      },
    );

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: req.user.id,
        integrationMode: IntegrationMode.FBR,
        action: 'FBR_INVOICE_VALIDATE',
        entity: 'FbrInvoiceSync',
        meta: { qboInvoiceId, scenarioId, ok: true },
      },
    });

    return {
      ok: true,
      status: result.row.status,
      validatedPayloadHash: result.row.validatedPayloadHash,
    };
  }

  @Post('invoices/:qboInvoiceId/post')
  async postInvoice(
    @Req() req: any,
    @Param('qboInvoiceId') qboInvoiceId: string,
    @Body() body: { scenarioId?: 'SN001' | 'SN002'; writeToQbo?: boolean },
  ) {
    const organizationId = this.orgId(req);
    const scenarioId = body?.scenarioId || 'SN001';

    const [fbrConn, qboInvoice] = await Promise.all([
      this.prisma.fbrConnection.findUnique({ where: { organizationId } }),
      this.qbo.getInvoice(organizationId, qboInvoiceId),
    ]);
    if (!fbrConn) {
      throw new BadRequestException('FBR connection is not configured for this company');
    }

    const payload = this.fbr.buildPayloadFromQboInvoice(
      qboInvoice,
      fbrConn,
      scenarioId,
    );

    const result = await this.fbr.postValidated(
      organizationId,
      qboInvoiceId,
      payload,
    );

    if (body?.writeToQbo && result.fbrInvoiceNo) {
      await this.qbo
        .updateInvoiceCustomField(
          organizationId,
          qboInvoiceId,
          'FBR Invoice No',
          result.fbrInvoiceNo,
        )
        .catch(() => undefined);
    }

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: req.user.id,
        integrationMode: IntegrationMode.FBR,
        action: 'FBR_INVOICE_POST',
        entity: 'FbrInvoiceSync',
        meta: {
          qboInvoiceId,
          fbrInvoiceNo: result.fbrInvoiceNo,
        },
      },
    });

    return {
      ok: true,
      fbrInvoiceNo: result.fbrInvoiceNo,
      status: result.row.status,
    };
  }
}
