import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  LoginDto,
  RegisterCustomerDto,
  RequestPasswordResetDto,
  ResetPasswordDto,
  VerifyPasswordResetOtpDto,
} from './dto';
import { JwtAuthGuard, Public } from '../common/guards';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @Post('admin/login')
  adminLogin(@Body() dto: LoginDto) {
    return this.auth.login(dto, 'admin');
  }

  @Public()
  @Post('customer/login')
  customerLogin(@Body() dto: LoginDto) {
    return this.auth.login(dto, 'customer');
  }

  @Public()
  @Post('customer/request-password-reset')
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.auth.requestPasswordReset(dto);
  }

  @Public()
  @Post('customer/verify-password-reset-otp')
  verifyPasswordResetOtp(@Body() dto: VerifyPasswordResetOtpDto) {
    return this.auth.verifyPasswordResetOtp(dto);
  }

  @Public()
  @Post('customer/reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto);
  }

  @Public()
  @Post('customer/register')
  register(@Body() dto: RegisterCustomerDto) {
    return this.auth.registerCustomer(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: any) {
    return this.auth.me(req.user.id);
  }
}
