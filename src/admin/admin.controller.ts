import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { ConnectionStatus, IntegrationMode, Prisma, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard, Roles, RolesGuard } from '../common/guards';
import { CreateCompanyDto, UpdateCompanyDto, UpdateQboConfigDto } from './admin.dto';
import {
  FBR_DEFAULT_BASE_URL,
  parseIntegrationMode,
  sanitizeFbr,
} from '../common/integration-mode';

function defaultPraUrl(environment: string) {
  return environment === 'production'
    ? 'https://ims.pral.com.pk/ims/production/api/Live/PostData'
    : 'https://ims.pral.com.pk/ims/sandbox/api/Live/PostData';
}

function defaultFbrUrl(_environment: string) {
  return FBR_DEFAULT_BASE_URL;
}

function sanitizePra<T extends { apiToken?: string | null } | null | undefined>(pra: T) {
  if (!pra) return null;
  const { apiToken, ...rest } = pra;
  return { ...rest, hasToken: Boolean(apiToken) };
}

function sanitizeCompany(org: any) {
  const admin = (org.users || []).find((u: any) => u.role === Role.CUSTOMER_ADMIN) || org.users?.[0];
  return {
    ...org,
    pra: sanitizePra(org.pra),
    fbr: sanitizeFbr(org.fbr),
    qbo: org.qbo
      ? (() => {
          const { accessToken, refreshToken, ...qboSafe } = org.qbo;
          return qboSafe;
        })()
      : null,
    adminEmail: admin?.email || null,
    adminUserId: admin?.id || null,
    users: undefined,
  };
}

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
export class AdminController {
  constructor(private prisma: PrismaService) {}

  private adminMode(req: any): IntegrationMode {
    const header = (req.headers?.['x-integration-mode'] as string) || '';
    if (req.user?.role === Role.SUPER_ADMIN && header) {
      return parseIntegrationMode(header);
    }
    return req.user?.integrationMode || IntegrationMode.PRA;
  }

  @Get('overview')
  async overview(@Req() req: any) {
    const mode = this.adminMode(req);
    const orgWhere = { integrationMode: mode };
    const [
      organizations,
      activeOrganizations,
      users,
      connectedQbo,
      connectedPra,
      connectedFbr,
      postedInvoices,
      failedInvoices,
      pendingInvoices,
      recentLogs,
    ] = await Promise.all([
      this.prisma.organization.count({ where: orgWhere }),
      this.prisma.organization.count({ where: { ...orgWhere, isActive: true } }),
      this.prisma.user.count({
        where: { role: { not: Role.SUPER_ADMIN }, integrationMode: mode },
      }),
      this.prisma.qboConnection.count({
        where: { status: 'CONNECTED', organization: orgWhere },
      }),
      this.prisma.praConnection.count({
        where: { status: 'CONNECTED', organization: orgWhere },
      }),
      this.prisma.fbrConnection.count({
        where: { status: 'CONNECTED', organization: orgWhere },
      }),
      mode === IntegrationMode.FBR
        ? this.prisma.fbrInvoiceSync.count({ where: { status: 'POSTED' } })
        : this.prisma.invoiceSync.count({ where: { status: 'POSTED' } }),
      mode === IntegrationMode.FBR
        ? this.prisma.fbrInvoiceSync.count({ where: { status: 'FAILED' } })
        : this.prisma.invoiceSync.count({ where: { status: 'FAILED' } }),
      mode === IntegrationMode.FBR
        ? this.prisma.fbrInvoiceSync.count({ where: { status: 'PENDING' } })
        : this.prisma.invoiceSync.count({ where: { status: 'PENDING' } }),
      this.prisma.auditLog.findMany({
        where: { integrationMode: mode },
        take: 12,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { fullName: true, email: true } },
          organization: { select: { name: true } },
        },
      }),
    ]);

    return {
      integrationMode: mode,
      kpis: {
        companies: organizations,
        activeCompanies: activeOrganizations,
        users,
        connectedQbo,
        connectedPra,
        connectedFbr,
        postedInvoices,
        failedInvoices,
        pendingInvoices,
        successRate:
          postedInvoices + failedInvoices === 0
            ? 100
            : Math.round(
                (postedInvoices / (postedInvoices + failedInvoices)) * 100,
              ),
      },
      recentLogs,
    };
  }

  private companyInclude() {
    return {
      qbo: true,
      pra: true,
      fbr: true,
      users: {
        where: { role: { in: [Role.CUSTOMER_ADMIN, Role.CUSTOMER_USER] } },
        orderBy: { createdAt: 'asc' as const },
        select: {
          id: true,
          email: true,
          fullName: true,
          role: true,
          isActive: true,
          lastLoginAt: true,
        },
      },
      _count: { select: { users: true, invoices: true, branches: true } },
    };
  }

  private buildCompanyWhere(
    mode: IntegrationMode,
    query: {
    q?: string;
    environment?: string;
    qbo?: string;
    pra?: string;
    fbr?: string;
    active?: string;
  }): Prisma.OrganizationWhereInput {
    const where: Prisma.OrganizationWhereInput = { integrationMode: mode };

    if (query.q?.trim()) {
      const q = query.q.trim();
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { pntn: { contains: q, mode: 'insensitive' } },
        {
          users: {
            some: {
              email: { contains: q, mode: 'insensitive' },
              role: { not: Role.SUPER_ADMIN },
            },
          },
        },
      ];
    }

    if (query.qbo === 'CONNECTED' || query.qbo === 'DISCONNECTED') {
      where.qbo = { status: query.qbo as ConnectionStatus };
    }

    const praWhere: Prisma.PraConnectionWhereInput = {};
    if (query.environment === 'sandbox' || query.environment === 'production') {
      praWhere.environment = query.environment;
    }
    if (query.pra === 'CONNECTED' || query.pra === 'DISCONNECTED') {
      praWhere.status = query.pra as ConnectionStatus;
    }
    if (Object.keys(praWhere).length) {
      where.pra = praWhere;
    }

    const fbrWhere: Prisma.FbrConnectionWhereInput = {};
    if (query.environment === 'sandbox' || query.environment === 'production') {
      fbrWhere.environment = query.environment;
    }
    if (query.fbr === 'CONNECTED' || query.fbr === 'DISCONNECTED') {
      fbrWhere.status = query.fbr as ConnectionStatus;
    }
    if (Object.keys(fbrWhere).length) {
      where.fbr = fbrWhere;
    }

    if (query.active === 'true') where.isActive = true;
    if (query.active === 'false') where.isActive = false;

    return where;
  }

  @Get('companies')
  async companies(
    @Req() req: any,
    @Query('q') q?: string,
    @Query('environment') environment?: string,
    @Query('qbo') qbo?: string,
    @Query('pra') pra?: string,
    @Query('fbr') fbr?: string,
    @Query('active') active?: string,
  ) {
    const mode = this.adminMode(req);
    try {
      const rows = await this.prisma.organization.findMany({
        where: this.buildCompanyWhere(mode, { q, environment, qbo, pra, fbr, active }),
        include: this.companyInclude(),
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(sanitizeCompany);
    } catch (e: any) {
      // Return a safe, non-sensitive error hint for admin UI debugging.
      throw new BadRequestException({
        message: 'Failed to load companies',
        details: e?.message || String(e),
      });
    }
  }

  @Get('companies/:id')
  async company(@Param('id') id: string, @Req() req: any) {
    const mode = this.adminMode(req);
    const org = await this.prisma.organization.findFirst({
      where: { id, integrationMode: mode },
      include: {
        ...this.companyInclude(),
        branches: true,
        invoices: { take: 10, orderBy: { createdAt: 'desc' } },
        fbrInvoices: {
          take: 8,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            qboInvoiceId: true,
            fbrInvoiceNo: true,
            status: true,
            totalAmount: true,
            customerName: true,
            postedAt: true,
            createdAt: true,
            errorMessage: true,
          },
        },
      },
    });
    if (!org) throw new BadRequestException('Company not found');
    return sanitizeCompany(org);
  }

  @Post('companies')
  async createCompany(@Body() dto: CreateCompanyDto, @Req() req: any) {
    const mode = this.adminMode(req);
    const email = dto.companyEmail.toLowerCase().trim();
    const exists = await this.prisma.user.findUnique({
      where: { email_integrationMode: { email, integrationMode: mode } },
    });
    if (exists) throw new BadRequestException('Email already registered');

    const environment = dto.environment || 'sandbox';
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const companyName = dto.companyName.trim();

    const org = await this.prisma.$transaction(async (tx) => {
      const base: Prisma.OrganizationCreateInput = {
        name: companyName,
        legalName: companyName,
        integrationMode: mode,
        qbo: { create: { status: ConnectionStatus.DISCONNECTED } },
        branches: {
          create: [{ name: 'Head Office', isDefault: true }],
        },
      };

      if (mode === IntegrationMode.FBR) {
        const apiToken = dto.fbrToken?.trim() || null;
        base.fbr = {
          create: {
            environment,
            apiBaseUrl: dto.fbrApiUrl?.trim() || defaultFbrUrl(environment),
            sellerNTNCNIC: dto.sellerNTNCNIC?.trim() || null,
            sellerBusinessName: dto.sellerBusinessName?.trim() || companyName,
            sellerProvince: dto.sellerProvince?.trim() || null,
            sellerAddress: dto.sellerAddress?.trim() || null,
            apiToken,
            status: apiToken ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED,
          },
        };
      } else {
        const apiUrl = dto.praApiUrl?.trim() || defaultPraUrl(environment);
        const apiToken = dto.praToken?.trim() || null;
        const posId = dto.posId?.trim() || null;
        base.pra = {
          create: {
            environment,
            posId,
            apiUrl,
            apiToken,
            status: apiToken ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED,
          },
        };
      }

      const created = await tx.organization.create({ data: base });

      await tx.user.create({
        data: {
          email,
          passwordHash,
          fullName: `${companyName} Admin`,
          role: Role.CUSTOMER_ADMIN,
          integrationMode: mode,
          organizationId: created.id,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: created.id,
          userId: req.user?.id,
          integrationMode: mode,
          action: 'ADMIN_COMPANY_CREATE',
          entity: 'Organization',
          meta: { companyName, adminEmail: email, environment, mode },
        },
      });

      return created;
    });

    const full = await this.prisma.organization.findUnique({
      where: { id: org.id },
      include: this.companyInclude(),
    });
    return sanitizeCompany(full);
  }

  @Patch('companies/:id')
  async updateCompany(
    @Param('id') id: string,
    @Body() dto: UpdateCompanyDto,
    @Req() req: any,
  ) {
    const mode = this.adminMode(req);
    const org = await this.prisma.organization.findFirst({
      where: { id, integrationMode: mode },
      include: {
        pra: true,
        fbr: true,
        users: { where: { role: Role.CUSTOMER_ADMIN }, take: 1 },
      },
    });
    if (!org) throw new BadRequestException('Company not found');

    const admin = org.users[0];
    const environment = dto.environment || org.pra?.environment || org.fbr?.environment || 'sandbox';

    if (dto.companyEmail) {
      const email = dto.companyEmail.toLowerCase().trim();
      const clash = await this.prisma.user.findFirst({
        where: {
          email,
          integrationMode: mode,
          id: admin ? { not: admin.id } : undefined,
        },
      });
      if (clash) throw new BadRequestException('Email already in use');
    }

    await this.prisma.$transaction(async (tx) => {
      if (dto.companyName?.trim()) {
        await tx.organization.update({
          where: { id },
          data: {
            name: dto.companyName.trim(),
            legalName: dto.companyName.trim(),
          },
        });
      }

      if (mode === IntegrationMode.FBR) {
        const apiToken =
          dto.fbrToken !== undefined && dto.fbrToken.trim() !== ''
            ? dto.fbrToken.trim()
            : org.fbr?.apiToken || null;
        const fbrStatus =
          apiToken ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED;

        await tx.fbrConnection.upsert({
          where: { organizationId: id },
          create: {
            organizationId: id,
            environment,
            apiBaseUrl: dto.fbrApiUrl?.trim() || defaultFbrUrl(environment),
            sellerNTNCNIC: dto.sellerNTNCNIC?.trim() || org.fbr?.sellerNTNCNIC || null,
            sellerBusinessName:
              dto.sellerBusinessName?.trim() || org.fbr?.sellerBusinessName || org.name,
            sellerProvince: dto.sellerProvince?.trim() || org.fbr?.sellerProvince || null,
            sellerAddress: dto.sellerAddress?.trim() || org.fbr?.sellerAddress || null,
            apiToken,
            status: fbrStatus,
          },
          update: {
            environment,
            apiBaseUrl:
              dto.fbrApiUrl?.trim() || org.fbr?.apiBaseUrl || defaultFbrUrl(environment),
            sellerNTNCNIC: dto.sellerNTNCNIC?.trim() || org.fbr?.sellerNTNCNIC || null,
            sellerBusinessName:
              dto.sellerBusinessName?.trim() || org.fbr?.sellerBusinessName || org.name,
            sellerProvince: dto.sellerProvince?.trim() || org.fbr?.sellerProvince || null,
            sellerAddress: dto.sellerAddress?.trim() || org.fbr?.sellerAddress || null,
            apiToken,
            status: fbrStatus,
          },
        });
      } else {
        const apiUrl =
          dto.praApiUrl?.trim() ||
          org.pra?.apiUrl ||
          defaultPraUrl(environment);
        const posId =
          dto.posId !== undefined
            ? dto.posId.trim() || null
            : org.pra?.posId || null;
        const apiToken =
          dto.praToken !== undefined && dto.praToken.trim() !== ''
            ? dto.praToken.trim()
            : org.pra?.apiToken || null;
        const praStatus =
          apiToken ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED;

        await tx.praConnection.upsert({
          where: { organizationId: id },
          create: {
            organizationId: id,
            environment,
            posId,
            apiUrl,
            apiToken,
            status: praStatus,
          },
          update: {
            environment,
            posId,
            apiUrl,
            apiToken,
            status: praStatus,
          },
        });
      }

      if (admin) {
        const userData: Prisma.UserUpdateInput = {};
        if (dto.companyEmail) userData.email = dto.companyEmail.toLowerCase().trim();
        if (dto.password) userData.passwordHash = await bcrypt.hash(dto.password, 10);
        if (Object.keys(userData).length) {
          await tx.user.update({ where: { id: admin.id }, data: userData });
        }
      }

      await tx.auditLog.create({
        data: {
          organizationId: id,
          userId: req.user?.id,
          integrationMode: mode,
          action: 'ADMIN_COMPANY_UPDATE',
          entity: 'Organization',
          meta: {
            companyName: dto.companyName?.trim() || org.name,
            adminEmail: dto.companyEmail?.toLowerCase() || admin?.email,
            environment,
            mode,
          },
        },
      });
    });

    const full = await this.prisma.organization.findUnique({
      where: { id },
      include: this.companyInclude(),
    });
    return sanitizeCompany(full);
  }

  /** @deprecated use GET /admin/companies */
  @Get('organizations')
  async organizations(@Query('q') q?: string) {
    return this.companies(q, undefined, undefined, undefined, undefined);
  }

  /** @deprecated use GET /admin/companies/:id */
  @Get('organizations/:id')
  async organization(@Param('id') id: string, @Req() req: any) {
    return this.company(id, req);
  }

  /** @deprecated use PATCH /admin/companies/:id */
  @Patch('organizations/:id/pra')
  async updateOrgPra(
    @Param('id') id: string,
    @Body() dto: UpdateCompanyDto,
    @Req() req: any,
  ) {
    return this.updateCompany(id, dto, req);
  }

  @Patch('organizations/:id/toggle')
  async toggleOrg(@Param('id') id: string, @Req() req: any) {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id },
    });
    const updated = await this.prisma.organization.update({
      where: { id },
      data: { isActive: !org.isActive },
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId: id,
        userId: req.user?.id,
        action: 'ADMIN_COMPANY_TOGGLE',
        entity: 'Organization',
        meta: { isActive: updated.isActive },
      },
    });
    return updated;
  }

  @Get('users')
  async users(@Req() req: any) {
    const mode = this.adminMode(req);
    return this.prisma.user.findMany({
      where: { role: { not: Role.SUPER_ADMIN }, integrationMode: mode },
      include: { organization: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get('logs')
  async logs(@Req() req: any) {
    const mode = this.adminMode(req);
    return this.prisma.auditLog.findMany({
      where: { integrationMode: mode },
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { fullName: true, email: true } },
        organization: { select: { name: true } },
      },
    });
  }

  @Get('invoices')
  async invoices(@Req() req: any) {
    const mode = this.adminMode(req);
    if (mode === IntegrationMode.FBR) {
      return this.prisma.fbrInvoiceSync.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' },
        include: { organization: { select: { name: true } } },
      });
    }
    return this.prisma.invoiceSync.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: { organization: { select: { name: true } } },
    });
  }

  @Get('qbo/config')
  async getQboConfig() {
    // Store QBO client credentials snapshot in AuditLog meta
    // to avoid schema-dependent migrations on production DB.
    const last = await this.prisma.auditLog.findFirst({
      where: { action: 'ADMIN_QBO_CONFIG_SNAPSHOT', entity: 'QboConfig' },
      orderBy: { createdAt: 'desc' },
    });

    const meta: any = last?.meta || {};
    const activeEnvironment: 'sandbox' | 'production' =
      (meta?.activeEnvironment as any) === 'production' ? 'production' : 'sandbox';

    const creds = meta?.credentials || {};
    const toResp = (c: any) => {
      const clientId = c?.clientId ?? null;
      const hasClientSecret = Boolean(c?.clientSecret);
      return {
        clientId,
        clientSecretMasked: hasClientSecret ? '********' : null,
        hasClientSecret,
      };
    };

    return {
      activeEnvironment,
      credentials: {
        sandbox: toResp(creds?.sandbox),
        production: toResp(creds?.production),
      },
    };
  }

  @Patch('qbo/config')
  async patchQboConfig(@Body() dto: UpdateQboConfigDto, @Req() req: any) {
    const last = await this.prisma.auditLog.findFirst({
      where: { action: 'ADMIN_QBO_CONFIG_SNAPSHOT', entity: 'QboConfig' },
      orderBy: { createdAt: 'desc' },
    });

    const meta: any = last?.meta || {};
    const prevCreds = meta?.credentials || {};

    const activeEnvironment: 'sandbox' | 'production' =
      (dto.activeEnvironment || dto.environment) === 'production'
        ? 'production'
        : 'sandbox';

    const env = dto.environment;
    const prevEnvCred = prevCreds?.[env] || {};
    const nextSecret =
      dto.clientSecret?.trim()?.length
        ? dto.clientSecret.trim()
        : prevEnvCred?.clientSecret ?? null;

    const nextSnapshot = {
      activeEnvironment,
      credentials: {
        sandbox:
          env === 'sandbox'
            ? { clientId: dto.clientId.trim(), clientSecret: nextSecret }
            : prevCreds?.sandbox || { clientId: null, clientSecret: null },
        production:
          env === 'production'
            ? { clientId: dto.clientId.trim(), clientSecret: nextSecret }
            : prevCreds?.production || { clientId: null, clientSecret: null },
      },
    };

    await this.prisma.auditLog.create({
      data: {
        userId: req.user?.id,
        action: 'ADMIN_QBO_CONFIG_SNAPSHOT',
        entity: 'QboConfig',
        meta: nextSnapshot,
      },
    });

    return { ok: true };
  }
}
