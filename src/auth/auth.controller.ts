import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto, RegisterCustomerDto } from './dto';
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
