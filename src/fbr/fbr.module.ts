import { Module } from '@nestjs/common';
import { FbrService } from './fbr.service';
import { FbrCustomerController } from './fbr-customer.controller';
import { QboModule } from '../qbo/qbo.module';

@Module({
  imports: [QboModule],
  controllers: [FbrCustomerController],
  providers: [FbrService],
  exports: [FbrService],
})
export class FbrModule {}
