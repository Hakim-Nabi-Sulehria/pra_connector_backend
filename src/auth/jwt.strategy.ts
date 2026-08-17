import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { IntegrationMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'pra-connector-dev-secret',
    });
  }

  async validate(payload: {
    sub: string;
    role: string;
    integrationMode?: IntegrationMode;
  }) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        organization: { include: { qbo: true, pra: true, fbr: true } },
      },
    });
    if (!user || !user.isActive) return null;
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      integrationMode: user.integrationMode,
      organizationId: user.organizationId,
      organization: user.organization,
    };
  }
}
