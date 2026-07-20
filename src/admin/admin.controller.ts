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
import { ConnectionStatus, Prisma, QboEnvironment, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard, Roles, RolesGuard } from '../common/guards';
import { CreateCompanyDto, UpdateCompanyDto, UpdateQboConfigDto } from './admin.dto';

function defaultPraUrl(environment: string) {
  return environment === 'production'
    ? 'https://ims.pral.com.pk/ims/production/api/Live/PostData'
    : 'https://ims.pral.com.pk/ims/sandbox/api/Live/PostData';
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

  @Get('overview')
  async overview() {
    const [
      organizations,
      activeOrganizations,
      users,
      connectedQbo,
      connectedPra,
      postedInvoices,
      failedInvoices,
      pendingInvoices,
      recentLogs,
    ] = await Promise.all([
      this.prisma.organization.count(),
      this.prisma.organization.count({ where: { isActive: true } }),
      this.prisma.user.count({ where: { role: { not: Role.SUPER_ADMIN } } }),
      this.prisma.qboConnection.count({ where: { status: 'CONNECTED' } }),
      this.prisma.praConnection.count({ where: { status: 'CONNECTED' } }),
      this.prisma.invoiceSync.count({ where: { status: 'POSTED' } }),
      this.prisma.invoiceSync.count({ where: { status: 'FAILED' } }),
      this.prisma.invoiceSync.count({ where: { status: 'PENDING' } }),
      this.prisma.auditLog.findMany({
        take: 12,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { fullName: true, email: true } },
          organization: { select: { name: true } },
        },
      }),
    ]);

    return {
      kpis: {
        companies: organizations,
        activeCompanies: activeOrganizations,
        users,
        connectedQbo,
        connectedPra,
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

  private buildCompanyWhere(query: {
    q?: string;
    environment?: string;
    qbo?: string;
    pra?: string;
    active?: string;
  }): Prisma.OrganizationWhereInput {
    const where: Prisma.OrganizationWhereInput = {};

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

    if (query.active === 'true') where.isActive = true;
    if (query.active === 'false') where.isActive = false;

    return where;
  }

  @Get('companies')
  async companies(
    @Query('q') q?: string,
    @Query('environment') environment?: string,
    @Query('qbo') qbo?: string,
    @Query('pra') pra?: string,
    @Query('active') active?: string,
  ) {
    const rows = await this.prisma.organization.findMany({
      where: this.buildCompanyWhere({ q, environment, qbo, pra, active }),
      include: this.companyInclude(),
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(sanitizeCompany);
  }

  @Get('companies/:id')
  async company(@Param('id') id: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        ...this.companyInclude(),
        branches: true,
        invoices: { take: 10, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!org) throw new BadRequestException('Company not found');
    return sanitizeCompany(org);
  }

  @Post('companies')
  async createCompany(@Body() dto: CreateCompanyDto, @Req() req: any) {
    const email = dto.companyEmail.toLowerCase().trim();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new BadRequestException('Email already registered');

    const environment = dto.environment || 'sandbox';
    const apiUrl = dto.praApiUrl?.trim() || defaultPraUrl(environment);
    const apiToken = dto.praToken?.trim() || null;
    const praStatus =
      apiToken ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED;

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const companyName = dto.companyName.trim();

    const org = await this.prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({
        data: {
          name: companyName,
          legalName: companyName,
          qbo: { create: { status: ConnectionStatus.DISCONNECTED } },
          pra: {
            create: {
              environment,
              apiUrl,
              apiToken,
              status: praStatus,
            },
          },
          branches: {
            create: [{ name: 'Head Office', isDefault: true }],
          },
        },
      });

      await tx.user.create({
        data: {
          email,
          passwordHash,
          fullName: `${companyName} Admin`,
          role: Role.CUSTOMER_ADMIN,
          organizationId: created.id,
        },
      });

      await tx.auditLog.create({
        data: {
          organizationId: created.id,
          userId: req.user?.id,
          action: 'ADMIN_COMPANY_CREATE',
          entity: 'Organization',
          meta: { companyName, adminEmail: email, environment },
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
    const org = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        pra: true,
        users: { where: { role: Role.CUSTOMER_ADMIN }, take: 1 },
      },
    });
    if (!org) throw new BadRequestException('Company not found');

    const admin = org.users[0];
    const environment = dto.environment || org.pra?.environment || 'sandbox';
    const apiUrl =
      dto.praApiUrl?.trim() ||
      org.pra?.apiUrl ||
      defaultPraUrl(environment);
    const apiToken =
      dto.praToken !== undefined && dto.praToken.trim() !== ''
        ? dto.praToken.trim()
        : org.pra?.apiToken || null;
    const praStatus =
      apiToken ? ConnectionStatus.CONNECTED : ConnectionStatus.DISCONNECTED;

    if (dto.companyEmail) {
      const email = dto.companyEmail.toLowerCase().trim();
      const clash = await this.prisma.user.findFirst({
        where: { email, id: admin ? { not: admin.id } : undefined },
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

      await tx.praConnection.upsert({
        where: { organizationId: id },
        create: {
          organizationId: id,
          environment,
          apiUrl,
          apiToken,
          status: praStatus,
        },
        update: {
          environment,
          apiUrl,
          apiToken,
          status: praStatus,
        },
      });

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
          action: 'ADMIN_COMPANY_UPDATE',
          entity: 'Organization',
          meta: {
            companyName: dto.companyName?.trim() || org.name,
            adminEmail: dto.companyEmail?.toLowerCase() || admin?.email,
            environment,
            hasToken: Boolean(apiToken),
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
  async organization(@Param('id') id: string) {
    return this.company(id);
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
  async users() {
    return this.prisma.user.findMany({
      where: { role: { not: Role.SUPER_ADMIN } },
      include: { organization: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get('logs')
  async logs() {
    return this.prisma.auditLog.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { fullName: true, email: true } },
        organization: { select: { name: true } },
      },
    });
  }

  @Get('invoices')
  async invoices() {
    return this.prisma.invoiceSync.findMany({
      take: 100,
      orderBy: { createdAt: 'desc' },
      include: { organization: { select: { name: true } } },
    });
  }

  private qboEnvToModel(env: string): QboEnvironment {
    return env === 'production' ? QboEnvironment.PRODUCTION : QboEnvironment.SANDBOX;
  }

  private qboEnvToApi(env: QboEnvironment): 'sandbox' | 'production' {
    return env === QboEnvironment.PRODUCTION ? 'production' : 'sandbox';
  }

  @Get('qbo/config')
  async getQboConfig() {
    const runtime = await this.prisma.qboRuntimeSettings.upsert({
      where: { id: 1 },
      create: { id: 1, activeEnvironment: QboEnvironment.SANDBOX },
      update: {},
    });

    const sandbox = await this.prisma.qboClientCredential.findUnique({
      where: { environment: QboEnvironment.SANDBOX },
    });
    const production = await this.prisma.qboClientCredential.findUnique({
      where: { environment: QboEnvironment.PRODUCTION },
    });

    const toResp = (c: any) => {
      const hasClientSecret = Boolean(c?.clientSecret);
      return {
        clientId: c?.clientId ?? null,
        clientSecretMasked: hasClientSecret ? '********' : null,
        hasClientSecret,
      };
    };

    return {
      activeEnvironment: this.qboEnvToApi(runtime.activeEnvironment),
      credentials: {
        sandbox: toResp(sandbox),
        production: toResp(production),
      },
    };
  }

  @Patch('qbo/config')
  async patchQboConfig(@Body() dto: UpdateQboConfigDto, @Req() req: any) {
    const activeEnv = dto.activeEnvironment || dto.environment;
    const envModel = this.qboEnvToModel(dto.environment);
    const activeModel = this.qboEnvToModel(activeEnv);

    const existing = await this.prisma.qboClientCredential.findUnique({
      where: { environment: envModel },
    });

    const next = await this.prisma.qboClientCredential.upsert({
      where: { environment: envModel },
      create: {
        environment: envModel,
        clientId: dto.clientId.trim(),
        clientSecret: dto.clientSecret?.trim() ? dto.clientSecret.trim() : null,
      },
      update: {
        clientId: dto.clientId.trim(),
        clientSecret:
          dto.clientSecret?.trim()
            ? dto.clientSecret.trim()
            : existing?.clientSecret ?? null,
      },
    });

    await this.prisma.qboRuntimeSettings.upsert({
      where: { id: 1 },
      create: { id: 1, activeEnvironment: activeModel },
      update: { activeEnvironment: activeModel },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: req.user?.id,
        action: 'ADMIN_QBO_CONFIG_SAVE',
        entity: 'QboClientCredential',
        meta: {
          environment: dto.environment,
          activeEnvironment: activeEnv,
          clientIdConfigured: Boolean(next.clientId),
          clientSecretConfigured: Boolean(next.clientSecret),
        },
      },
    });

    return { ok: true };
  }
}
