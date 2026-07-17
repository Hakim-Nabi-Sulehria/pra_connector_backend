import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto, RegisterCustomerDto } from './dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  private async sign(user: {
    id: string;
    email: string;
    role: Role;
    organizationId: string | null;
  }) {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
    });
    return accessToken;
  }

  private sanitize(user: any) {
    const { passwordHash, ...safe } = user;
    if (safe.organization?.qbo) {
      const { accessToken, refreshToken, ...qboSafe } = safe.organization.qbo;
      safe.organization = { ...safe.organization, qbo: qboSafe };
    }
    if (safe.organization?.pra) {
      const { apiToken, ...praSafe } = safe.organization.pra;
      safe.organization = {
        ...safe.organization,
        pra: { ...praSafe, hasToken: Boolean(apiToken) },
      };
    }
    return safe;
  }

  async login(dto: LoginDto, expectedPortal?: 'admin' | 'customer') {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: { organization: true },
    });
    if (!user || !user.isActive) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid email or password');

    if (expectedPortal === 'admin' && user.role !== Role.SUPER_ADMIN) {
      throw new UnauthorizedException('Use the customer portal login');
    }
    if (
      expectedPortal === 'customer' &&
      user.role === Role.SUPER_ADMIN
    ) {
      throw new UnauthorizedException('Use the admin portal login');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await this.prisma.auditLog.create({
      data: {
        userId: user.id,
        organizationId: user.organizationId,
        action: 'LOGIN',
        entity: 'User',
        meta: { portal: expectedPortal || 'auto' },
      },
    });

    const accessToken = await this.sign(user);
    return { accessToken, user: this.sanitize(user) };
  }

  async registerCustomer(dto: RegisterCustomerDto) {
    const email = dto.email.toLowerCase();
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new BadRequestException('Email already registered');

    const passwordHash = await bcrypt.hash(dto.password, 10);
    const result = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: dto.organizationName,
          legalName: dto.organizationName,
          pntn: dto.pntn,
          qbo: { create: {} },
          pra: { create: { environment: 'sandbox' } },
          branches: {
            create: [{ name: 'Head Office', isDefault: true }],
          },
        },
      });
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          fullName: dto.fullName,
          role: Role.CUSTOMER_ADMIN,
          organizationId: org.id,
        },
        include: { organization: true },
      });

      await tx.auditLog.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          action: 'REGISTER',
          entity: 'Organization',
        },
      });

      return user;
    });

    const accessToken = await this.sign(result);
    return { accessToken, user: this.sanitize(result) };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { organization: { include: { qbo: true, pra: true } } },
    });
    if (!user) throw new UnauthorizedException();
    return this.sanitize(user);
  }
}
