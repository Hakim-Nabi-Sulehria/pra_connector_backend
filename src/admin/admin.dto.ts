import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateCompanyDto {
  @IsString()
  companyName!: string;

  @IsEmail()
  companyEmail!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  praApiUrl?: string;

  @IsOptional()
  @IsString()
  praToken?: string;

  @IsIn(['sandbox', 'production'])
  environment!: string;
}

export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  companyName?: string;

  @IsOptional()
  @IsEmail()
  companyEmail?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;

  @IsOptional()
  @IsString()
  praApiUrl?: string;

  /** Empty or omitted keeps the existing token. */
  @IsOptional()
  @IsString()
  praToken?: string;

  @IsOptional()
  @IsIn(['sandbox', 'production'])
  environment?: string;
}

export class UpdateQboConfigDto {
  @IsIn(['sandbox', 'production'])
  environment!: string;

  @IsOptional()
  @IsIn(['sandbox', 'production'])
  activeEnvironment?: string;

  @IsString()
  clientId!: string;

  /**
   * If blank/omitted, backend keeps the existing secret for this environment.
   * Note: this project stores secrets in DB (demo mode). Production should encrypt.
   */
  @IsOptional()
  @IsString()
  clientSecret?: string;
}
