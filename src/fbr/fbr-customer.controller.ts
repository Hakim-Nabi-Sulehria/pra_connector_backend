import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { IntegrationMode, MappingSection, Role } from '@prisma/client';
import { JwtAuthGuard, Roles, RolesGuard } from '../common/guards';
import { assertModeMatch } from '../common/integration-mode';
import { PrismaService } from '../prisma/prisma.service';
import { QboService } from '../qbo/qbo.service';
import { FbrService } from '../fbr/fbr.service';
import { MappingService } from '../mappings/mapping.service';

class SaveMappingItemDto {
  @IsString()
  id!: string;

  @IsString()
  sourceField!: string;
}

class SaveMappingsDto {
  @IsOptional()
  @IsString()
  invoiceId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaveMappingItemDto)
  items!: SaveMappingItemDto[];
}

class SwapMappingDto {
  @IsString()
  fromId!: string;

  @IsString()
  toId!: string;

  @IsIn(['HEADER', 'LINE'])
  section!: MappingSection;
}

class MoveMappingDto {
  @IsIn(['up', 'down'])
  direction!: 'up' | 'down';

  @IsIn(['HEADER', 'LINE'])
  section!: MappingSection;
}

@Controller('fbr/customer')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CUSTOMER_ADMIN, Role.CUSTOMER_USER)
export class FbrCustomerController {
  constructor(
    private prisma: PrismaService,
    private qbo: QboService,
    private fbr: FbrService,
    private mappingService: MappingService,
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

  private sanitizeOrg(org: any) {
    if (!org) return org;
    const next: any = { ...org };
    if (next.qbo) {
      const { accessToken, refreshToken, ...qboSafe } = next.qbo;
      next.qbo = qboSafe;
    }
    if (next.fbr) {
      const { apiToken, ...fbrSafe } = next.fbr;
      next.fbr = { ...fbrSafe, hasToken: Boolean(apiToken) };
    }
    return next;
  }

  @Get('dashboard')
  async dashboard(@Req() req: any) {
    const organizationId = this.orgId(req);
    const [org, posted, failed, pending, recent, logs] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        include: {
          qbo: true,
          fbr: true,
          _count: { select: { fbrInvoices: true, mappings: true } },
        },
      }),
      this.prisma.fbrInvoiceSync.count({
        where: { organizationId, status: 'POSTED' },
      }),
      this.prisma.fbrInvoiceSync.count({
        where: { organizationId, status: 'FAILED' },
      }),
      this.prisma.fbrInvoiceSync.count({
        where: { organizationId, status: { in: ['PENDING', 'RETRYING', 'VALIDATED'] } },
      }),
      this.prisma.fbrInvoiceSync.findMany({
        where: { organizationId },
        take: 8,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.findMany({
        where: { organizationId },
        take: 8,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const steps = [
      { key: 'org', label: 'Organization profile', done: Boolean(org?.name) },
      {
        key: 'qbo',
        label: 'Connect QuickBooks',
        done: org?.qbo?.status === 'CONNECTED',
      },
      {
        key: 'fbr',
        label: 'FBR seller + token',
        done: org?.fbr?.status === 'CONNECTED' && Boolean(org?.fbr?.sellerNTNCNIC),
      },
      {
        key: 'mappings',
        label: 'FBR field mappings',
        done: (org?._count.mappings || 0) > 0,
      },
    ];

    return {
      org: this.sanitizeOrg(org),
      kpis: { posted, failed, pending, total: org?._count.fbrInvoices || 0 },
      onboarding: {
        completed: steps.filter((s) => s.done).length,
        total: steps.length,
        steps,
      },
      recentInvoices: recent,
      recentLogs: logs,
    };
  }

  @Get('connections')
  async connections(@Req() req: any) {
    const organizationId = this.orgId(req);
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, pntn: true, qbo: true, fbr: true, integrationMode: true },
    });
    if (!org) return org;
    return {
      ...this.sanitizeOrg(org),
      qboEnvironment: process.env.QBO_ENVIRONMENT || 'sandbox',
      qboRedirectUri:
        process.env.QBO_REDIRECT_URI ||
        'https://pra-connector-backend.onrender.com/api/qbo/callback',
    };
  }

  @Get('qbo/auth-url')
  authUrl(
    @Req() req: any,
    @Query('returnOrigin') returnOrigin?: string,
    @Query('returnPath') returnPath?: string,
  ) {
    const url = this.qbo.getAuthUri(
      this.orgId(req),
      req.user.id,
      returnOrigin,
      returnPath || '/fbr/app/connections',
      'FBR',
    );
    return { url };
  }

  @Get('qbo/company')
  qboCompany(@Req() req: any) {
    return this.qbo.getCompany(this.orgId(req));
  }

  @Get('qbo/invoices')
  async qboInvoices(@Req() req: any, @Query('max') max?: string) {
    const maxResults = Math.min(Math.max(Number(max) || 25, 1), 100);
    const invoices = await this.qbo.listInvoices(this.orgId(req), maxResults);
    return { ok: true, count: invoices.length, invoices };
  }

  @Get('mappings/workspace')
  mappingWorkspace(@Req() req: any, @Query('invoiceId') invoiceId?: string) {
    return this.mappingService.getWorkspace(this.orgId(req), invoiceId);
  }

  @Post('mappings/save')
  saveMappings(@Req() req: any, @Body() dto: SaveMappingsDto) {
    return this.mappingService.saveMappings(
      this.orgId(req),
      dto.items,
      dto.invoiceId,
    );
  }

  @Post('mappings/swap')
  swapMappings(@Req() req: any, @Body() dto: SwapMappingDto) {
    return this.mappingService.swapSources(
      this.orgId(req),
      dto.section,
      dto.fromId,
      dto.toId,
    );
  }

  @Post('mappings/:id/move')
  moveMapping(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: MoveMappingDto,
  ) {
    return this.mappingService.moveSource(
      this.orgId(req),
      dto.section,
      id,
      dto.direction,
    );
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
      balance: inv.Balance,
      txnDate: inv.TxnDate,
      customField: inv.CustomField || [],
      tracked: byQbo.get(inv.Id) || null,
      fbrInvoiceNo: byQbo.get(inv.Id)?.fbrInvoiceNo || null,
    }));
  }

  private async mappedPayload(
    organizationId: string,
    qboInvoiceId: string,
    scenarioId: 'SN001' | 'SN002',
  ) {
    await this.mappingService.ensureDefaults(organizationId);
    const [fbrConn, qboInvoice, mappings] = await Promise.all([
      this.prisma.fbrConnection.findUnique({ where: { organizationId } }),
      this.qbo.getInvoice(organizationId, qboInvoiceId),
      this.prisma.fieldMapping.findMany({ where: { organizationId } }),
    ]);
    if (!fbrConn) {
      throw new BadRequestException('FBR connection is not configured for this company');
    }
    const payload = this.fbr.buildPayloadFromQboInvoice(
      qboInvoice,
      fbrConn,
      scenarioId,
      mappings,
    );
    return { fbrConn, qboInvoice, payload };
  }

  @Get('invoices/:qboInvoiceId/preview')
  async previewInvoice(
    @Req() req: any,
    @Param('qboInvoiceId') qboInvoiceId: string,
    @Query('scenarioId') scenarioId?: 'SN001' | 'SN002',
  ) {
    const organizationId = this.orgId(req);
    const scenario = scenarioId === 'SN002' ? 'SN002' : 'SN001';
    const { qboInvoice, payload } = await this.mappedPayload(
      organizationId,
      qboInvoiceId,
      scenario,
    );
    const tracked = await this.prisma.fbrInvoiceSync.findUnique({
      where: {
        organizationId_qboInvoiceId: { organizationId, qboInvoiceId },
      },
    });
    return { qboInvoice, payload, tracked, scenarioId: scenario };
  }

  @Post('invoices/:qboInvoiceId/validate')
  async validateInvoice(
    @Req() req: any,
    @Param('qboInvoiceId') qboInvoiceId: string,
    @Body() body: { scenarioId?: 'SN001' | 'SN002' },
  ) {
    const organizationId = this.orgId(req);
    const scenarioId = body?.scenarioId || 'SN001';
    const { qboInvoice, payload } = await this.mappedPayload(
      organizationId,
      qboInvoiceId,
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
    const { payload } = await this.mappedPayload(
      organizationId,
      qboInvoiceId,
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

  @Get('logs')
  logs(@Req() req: any) {
    return this.prisma.auditLog.findMany({
      where: { organizationId: this.orgId(req) },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });
  }
}
