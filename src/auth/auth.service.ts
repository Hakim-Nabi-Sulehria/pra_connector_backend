import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { createHash, randomInt } from 'crypto';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  LoginDto,
  RegisterCustomerDto,
  ResetPasswordDto,
  RequestPasswordResetDto,
  VerifyPasswordResetOtpDto,
} from './dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  private otpHash(otp: string) {
    // Hash so OTP isn't stored in plain text.
    return createHash('sha256').update(otp).digest('hex');
  }

  private nowPlusMinutes(minutes: number) {
    return new Date(Date.now() + minutes * 60 * 1000);
  }

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
    if (expectedPortal === 'customer') {
      if (!dto.captcha || dto.captcha.trim().length < 1) {
        throw new BadRequestException('Captcha is required');
      }
    }
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

  async requestPasswordReset(dto: RequestPasswordResetDto) {
    if (!dto.captcha || dto.captcha.trim().length < 1) {
      throw new BadRequestException('Captcha is required');
    }

    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Requirement: allow login only for existing emails.
    if (!user || !user.isActive || user.role === Role.SUPER_ADMIN) {
      throw new UnauthorizedException('Invalid email or reset request');
    }

    const otp = String(randomInt(100000, 1000000));
    const expiresAt = this.nowPlusMinutes(10);

    await this.prisma.passwordResetOtp.create({
      data: {
        email,
        otpHash: this.otpHash(otp),
        expiresAt,
        verifiedAt: null,
        usedAt: null,
      },
    });

    // NOTE: No email transport is configured in this repo.
    // Return OTP so the UI flow can be tested end-to-end.
    return { ok: true, message: 'OTP sent', otp };
  }

  async verifyPasswordResetOtp(dto: VerifyPasswordResetOtpDto) {
    const email = dto.email.toLowerCase();
    const otpHash = this.otpHash(dto.otp.trim());

    const token = await this.prisma.passwordResetOtp.findFirst({
      where: {
        email,
        expiresAt: { gt: new Date() },
        usedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token || token.otpHash !== otpHash) {
      throw new UnauthorizedException('Invalid or expired OTP');
    }

    await this.prisma.passwordResetOtp.update({
      where: { id: token.id },
      data: { verifiedAt: new Date() },
    });

    return { ok: true };
  }

  async resetPassword(dto: ResetPasswordDto) {
    const email = dto.email.toLowerCase();
    const otpHash = this.otpHash(dto.otp.trim());

    const token = await this.prisma.passwordResetOtp.findFirst({
      where: {
        email,
        otpHash,
        expiresAt: { gt: new Date() },
        usedAt: null,
        verifiedAt: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!token) {
      throw new UnauthorizedException('OTP not verified or expired');
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.isActive || user.role === Role.SUPER_ADMIN) {
      throw new UnauthorizedException('Invalid reset request');
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash },
      });
      await tx.passwordResetOtp.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      });
    });

    return { ok: true, message: 'Password updated successfully' };
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
