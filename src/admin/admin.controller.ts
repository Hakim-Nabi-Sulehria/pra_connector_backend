import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { ConnectionStatus, Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard, Roles, RolesGuard } from '../common/guards';

class UpdateOrgPraDto {
  @IsOptional()
  @IsString()
  posId?: string;

  @IsOptional()
  @IsString()
  apiUrl?: string;

  @IsOptional()
  @IsString()
  apiToken?: string;

  @IsOptional()
  @IsIn(['sandbox', 'production'])
  environment?: string;
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
      users,
      connectedQbo,
      connectedPra,
      postedInvoices,
      failedInvoices,
      recentLogs,
    ] = await Promise.all([
      this.prisma.organization.count(),
      this.prisma.user.count({ where: { role: { not: Role.SUPER_ADMIN } } }),
      this.prisma.qboConnection.count({ where: { status: 'CONNECTED' } }),
      this.prisma.praConnection.count({ where: { status: 'CONNECTED' } }),
      this.prisma.invoiceSync.count({ where: { status: 'POSTED' } }),
      this.prisma.invoiceSync.count({ where: { status: 'FAILED' } }),
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
        organizations,
        users,
        connectedQbo,
        connectedPra,
        postedInvoices,
        failedInvoices,
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

  @Get('organizations')
  async organizations(@Query('q') q?: string) {
    return this.prisma.organization.findMany({
      where: q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { pntn: { contains: q, mode: 'insensitive' } },
            ],
          }
        : undefined,
      include: {
        qbo: true,
        pra: true,
        _count: { select: { users: true, invoices: true, branches: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Get('organizations/:id')
  async organization(@Param('id') id: string) {
    return this.prisma.organization.findUnique({
      where: { id },
      include: {
        users: {
          select: {
            id: true,
            email: true,
            fullName: true,
            role: true,
            isActive: true,
            lastLoginAt: true,
          },
        },
        branches: true,
        qbo: true,
        pra: true,
        invoices: { take: 20, orderBy: { createdAt: 'desc' } },
      },
    });
  }

  @Patch('organizations/:id/pra')
  async updateOrgPra(
    @Param('id') id: string,
    @Body() dto: UpdateOrgPraDto,
    @Req() req: any,
  ) {
    await this.prisma.organization.findUniqueOrThrow({ where: { id } });

    const posId = dto.posId?.trim() || null;
    const apiToken = dto.apiToken?.trim() || null;
    const apiUrl = dto.apiUrl?.trim() || null;
    const environment = dto.environment || 'sandbox';

    const defaultUrl =
      environment === 'production'
        ? 'https://ims.pral.com.pk/ims/production/api/Live/PostData'
        : 'https://ims.pral.com.pk/ims/sandbox/api/Live/PostData';

    const status =
      posId && apiToken
        ? ConnectionStatus.CONNECTED
        : ConnectionStatus.DISCONNECTED;

    const pra = await this.prisma.praConnection.upsert({
      where: { organizationId: id },
      create: {
        organizationId: id,
        posId,
        apiToken,
        apiUrl: apiUrl || defaultUrl,
        environment,
        status,
      },
      update: {
        posId,
        apiToken,
        apiUrl: apiUrl || defaultUrl,
        environment,
        status,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: id,
        userId: req.user?.id,
        action: 'ADMIN_PRA_CONFIG_SAVE',
        entity: 'PraConnection',
        meta: {
          posId,
          environment,
          apiUrl: pra.apiUrl,
          hasToken: Boolean(apiToken),
        },
      },
    });

    return pra;
  }

  @Patch('organizations/:id/toggle')
  async toggleOrg(@Param('id') id: string) {
    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id },
    });
    return this.prisma.organization.update({
      where: { id },
      data: { isActive: !org.isActive },
    });
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
}
