import { IntegrationMode } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

export const FBR_DEFAULT_BASE_URL = 'https://gw.fbr.gov.pk';

export function fbrApiPaths(environment: string) {
  if (environment === 'production') {
    return {
      validate: '/di_data/v1/di/validateinvoicedata',
      post: '/di_data/v1/di/postinvoicedata',
    };
  }
  return {
    validate: '/di_data/v1/di/validateinvoicedata_sb',
    post: '/di_data/v1/di/postinvoicedata_sb',
  };
}

export function parseIntegrationMode(value?: string | null): IntegrationMode {
  if (value?.toUpperCase() === 'FBR') return IntegrationMode.FBR;
  return IntegrationMode.PRA;
}

export function assertModeMatch(
  expected: IntegrationMode,
  actual: IntegrationMode | null | undefined,
  label = 'resource',
) {
  if (actual && actual !== expected) {
    throw new BadRequestException(
      `${label} belongs to ${actual} mode; switch to the ${actual} portal`,
    );
  }
}

export function sanitizeFbr<T extends { apiToken?: string | null } | null | undefined>(
  fbr: T,
) {
  if (!fbr) return null;
  const { apiToken, ...rest } = fbr;
  return { ...rest, hasToken: Boolean(apiToken) };
}
