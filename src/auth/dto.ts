import { IsEmail, IsEnum, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  /** PRA or FBR — keeps sessions and records isolated per integration mode. */
  @IsOptional()
  @IsIn(['PRA', 'FBR'])
  integrationMode?: 'PRA' | 'FBR';

  // Captcha is enforced for customer portal login.
  @IsOptional()
  @IsString()
  @MinLength(1)
  captcha?: string;
}

export class RegisterCustomerDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  fullName!: string;

  @IsString()
  organizationName!: string;

  @IsOptional()
  @IsString()
  pntn?: string;

  @IsOptional()
  @IsIn(['PRA', 'FBR'])
  integrationMode?: 'PRA' | 'FBR';
}

export class CreateOrgUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  @IsString()
  fullName!: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}

export class RequestPasswordResetDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  captcha!: string;
}

export class VerifyPasswordResetOtpDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(4)
  otp!: string;
}

export class ResetPasswordDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(4)
  otp!: string;

  @IsString()
  @MinLength(6)
  newPassword!: string;
}
