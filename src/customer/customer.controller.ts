import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MappingSection, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard, Roles, RolesGuard } from '../common/guards';
import { QboService } from '../qbo/qbo.service';
import { MappingService } from '../mappings/mapping.service';

class CreateBranchDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  praPosId?: string;
}

class SwapMappingDto {
  @IsString()
  fromId!: string;

  @IsString()
  toId!: string;

  @IsIn(['HEADER', 'LINE'])
  section!: MappingSection;
}

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

class MoveMappingDto {
  @IsIn(['up', 'down'])
  direction!: 'up' | 'down';

  @IsIn(['HEADER', 'LINE'])
  section!: MappingSection;
}

class UpdateSourceDto {
  @IsString()
  sourceField!: string;
}

class UpdateQboCustomFieldDto {
  @IsString()
  fieldName!: string;

  @IsString()
  value!: string;
}

class AttachFiscalDto {
  @IsString()
  qboInvoiceId!: string;

  @IsOptional()
  @IsString()
  usin?: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsNumber()
  totalAmount?: number;

  @IsOptional()
  @IsString()
  fiscalInvoiceNo?: string;

  /** QBO sales custom field name to write (default: Fiscal Invoice) */
  @IsOptional()
  @IsString()
  qboCustomFieldName?: string;

  /** When true (default), also sparse-update the QBO invoice custom field */
  @IsOptional()
  writeToQbo?: boolean;
}

@Controller('customer')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CUSTOMER_ADMIN, Role.CUSTOMER_USER)
export class CustomerController {
  constructor(
    private prisma: PrismaService,
    private qbo: QboService,
    private mappingService: MappingService,
  ) {}

  private orgId(req: any) {
    const organizationId = req.user?.organizationId as string | null | undefined;
    if (!organizationId) {
      throw new ForbiddenException(
        'Your account is not linked to a company workspace',
      );
    }
    return organizationId;
  }

  @Get('dashboard')
  async dashboard(@Req() req: any) {
    const organizationId = this.orgId(req);
    const [org, posted, failed, pending, recent, logs] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        include: {
          qbo: true,
          pra: true,
          branches: true,
          _count: { select: { invoices: true, mappings: true } },
        },
      }),
      this.prisma.invoiceSync.count({
        where: { organizationId, status: 'POSTED' },
      }),
      this.prisma.invoiceSync.count({
        where: { organizationId, status: 'FAILED' },
      }),
      this.prisma.invoiceSync.count({
        where: { organizationId, status: { in: ['PENDING', 'RETRYING'] } },
      }),
      this.prisma.invoiceSync.findMany({
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
        key: 'pra',
        label: 'Connect PRA',
        done: org?.pra?.status === 'CONNECTED' && Boolean(org?.pra?.posId),
      },
      {
        key: 'mappings',
        label: 'Field mappings',
        done: (org?._count.mappings || 0) > 0,
      },
      {
        key: 'branch',
        label: 'Configure branch / POS',
        done: (org?.branches?.length || 0) > 0,
      },
    ];

    return {
      org,
      kpis: { posted, failed, pending, total: org?._count.invoices || 0 },
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
      select: { qbo: true, pra: true, name: true, pntn: true },
    });
    if (!org) return org;
    const { apiToken, ...praSafe } = org.pra || ({} as any);
    return {
      ...org,
      qboEnvironment: process.env.QBO_ENVIRONMENT || 'sandbox',
      qboRedirectUri:
        process.env.QBO_REDIRECT_URI ||
        'https://pra-connector-backend.onrender.com/api/qbo/callback',
      pra: org.pra
        ? {
            ...praSafe,
            hasToken: Boolean(apiToken),
            apiToken: undefined,
          }
        : null,
    };
  }

  @Get('qbo/auth-url')
  authUrl(@Req() req: any, @Query('returnOrigin') returnOrigin?: string) {
    const url = this.qbo.getAuthUri(
      this.orgId(req),
      req.user.id,
      returnOrigin,
    );
    return { url };
  }

  @Get('qbo/company')
  qboCompany(@Req() req: any) {
    return this.qbo.getCompany(this.orgId(req));
  }

  @Get('qbo/custom-fields')
  async qboCustomFields(@Req() req: any) {
    const organizationId = this.orgId(req);
    const [legacy, enhanced] = await Promise.all([
      this.qbo.getSalesCustomFieldDefs(organizationId),
      this.qbo.getEnhancedCustomFieldDefs(organizationId),
    ]);
    return {
      ok: true,
      legacyCount: legacy.length,
      legacyFields: legacy,
      enhancedCount: enhanced.length,
      enhancedFields: enhanced,
    };
  }

  @Post('qbo/invoices/:id/custom-field')
  async updateQboCustomField(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateQboCustomFieldDto,
  ) {
    const updated = await this.qbo.updateInvoiceCustomField(
      this.orgId(req),
      id,
      dto.fieldName,
      dto.value,
    );
    await this.prisma.auditLog.create({
      data: {
        organizationId: this.orgId(req),
        userId: req.user.id,
        action: 'QBO_CUSTOM_FIELD_UPDATE',
        entity: 'Invoice',
        meta: {
          qboInvoiceId: id,
          fieldName: dto.fieldName,
          value: dto.value,
          definitionIdUsed: (updated as any)?._writeMeta?.definitionIdUsed,
        },
      },
    });
    return { ok: true, invoice: updated };
  }

  @Get('qbo/invoices')
  async qboInvoices(@Req() req: any, @Query('max') max?: string) {
    const maxResults = Math.min(Math.max(Number(max) || 25, 1), 100);
    const invoices = await this.qbo.listInvoices(this.orgId(req), maxResults);
    return {
      ok: true,
      count: invoices.length,
      invoices,
    };
  }

  @Get('mappings')
  mappings(@Req() req: any) {
    return this.prisma.fieldMapping.findMany({
      where: { organizationId: this.orgId(req) },
      orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  @Get('mappings/workspace')
  mappingWorkspace(
    @Req() req: any,
    @Query('invoiceId') invoiceId?: string,
  ) {
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

  @Patch('mappings/:id/source')
  updateSource(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateSourceDto,
  ) {
    return this.mappingService.updateSource(this.orgId(req), id, dto.sourceField);
  }

  @Get('branches')
  branches(@Req() req: any) {
    return this.prisma.branch.findMany({
      where: { organizationId: this.orgId(req) },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Post('branches')
  async createBranch(@Req() req: any, @Body() dto: CreateBranchDto) {
    const organizationId = this.orgId(req);
    const branch = await this.prisma.branch.create({
      data: { organizationId, ...dto },
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: req.user.id,
        action: 'BRANCH_CREATE',
        entity: 'Branch',
        meta: { name: dto.name },
      },
    });
    return branch;
  }

  @Get('invoices')
  invoices(@Req() req: any) {
    return this.prisma.invoiceSync.findMany({
      where: { organizationId: this.orgId(req) },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  @Post('invoices/attach-fiscal')
  async attachFiscal(@Req() req: any, @Body() dto: AttachFiscalDto) {
    const organizationId = this.orgId(req);
    const fiscalInvoiceNo =
      dto.fiscalInvoiceNo?.trim() ||
      `TEST-FISCAL-1002-${Date.now().toString().slice(-8)}`;
    const fieldName = dto.qboCustomFieldName?.trim() || 'Fiscal Invoice';
    const writeToQbo = dto.writeToQbo !== false;

    let qboInvoice: any = null;
    try {
      qboInvoice = await this.qbo.getInvoice(organizationId, dto.qboInvoiceId);
    } catch {
      qboInvoice = null;
    }

    let qboWrite: any = null;
    let qboWriteError: string | null = null;
    let qboWriteVerified = false;
    if (writeToQbo) {
      try {
        qboWrite = await this.qbo.updateInvoiceCustomField(
          organizationId,
          dto.qboInvoiceId,
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
          e?.response?.message ||
          e?.message ||
          'Failed to write custom field to QBO';
      }
    }

    const data = {
      usin: dto.usin || qboInvoice?.DocNumber || dto.qboInvoiceId,
      customerName:
        dto.customerName || qboInvoice?.CustomerRef?.name || null,
      totalAmount:
        dto.totalAmount ??
        (qboInvoice?.TotalAmt != null ? Number(qboInvoice.TotalAmt) : null),
      status: 'POSTED' as const,
      fiscalInvoiceNo,
      postedAt: new Date(),
      praResponse: {
        Code: '100',
        Response: 'Test fiscal invoice number attached successfully.',
        Test: true,
        qboCustomFieldName: fieldName,
        qboWriteOk: qboWriteVerified,
        qboWriteVerified,
        qboWriteError,
      },
    };

    const row = await this.prisma.invoiceSync.upsert({
      where: {
        organizationId_qboInvoiceId: {
          organizationId,
          qboInvoiceId: dto.qboInvoiceId,
        },
      },
      create: {
        organizationId,
        qboInvoiceId: dto.qboInvoiceId,
        ...data,
      },
      update: data,
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: req.user.id,
        action: 'INVOICE_ATTACH_FISCAL_TEST',
        entity: 'InvoiceSync',
        meta: {
          qboInvoiceId: dto.qboInvoiceId,
          usin: row.usin,
          fiscalInvoiceNo,
          qboCustomFieldName: fieldName,
          qboWriteOk: qboWriteVerified,
          qboWriteVerified,
          qboWriteError,
        },
      },
    });

    return {
      ...row,
      qboWriteOk: qboWriteVerified,
      qboWriteVerified,
      qboWriteError,
      qboCustomFields: qboInvoice?.CustomField || null,
    };
  }

  @Post('invoices/demo-seed')
  seedDemoInvoice(@Req() req: any) {
    const organizationId = this.orgId(req);
    return this.prisma.invoiceSync.create({
      data: {
        organizationId,
        qboInvoiceId: `demo-${Date.now()}`,
        usin: `INV-${Math.floor(Math.random() * 9000 + 1000)}`,
        customerName: 'Demo Customer',
        totalAmount: 12500,
        status: 'PENDING',
        praPayload: { InvoiceNumber: '', USIN: 'DEMO', InvoiceType: 1 },
      },
    });
  }

  @Patch('invoices/:id/simulate-post')
  async simulatePost(@Req() req: any, @Param('id') id: string) {
    const organizationId = this.orgId(req);
    const updated = await this.prisma.invoiceSync.update({
      where: { id },
      data: {
        status: 'POSTED',
        fiscalInvoiceNo: `9${Date.now().toString().slice(-17)}`,
        postedAt: new Date(),
        praResponse: {
          Code: '100',
          Response: 'Fiscal Invoice Number generated successfully.',
        },
      },
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId: req.user.id,
        action: 'INVOICE_SIMULATE_POST',
        entity: 'InvoiceSync',
        meta: { id },
      },
    });
    return updated;
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
