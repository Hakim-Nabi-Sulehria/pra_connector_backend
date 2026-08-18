import { Module } from '@nestjs/common';
import { FbrService } from './fbr.service';
import { FbrCustomerController } from './fbr-customer.controller';
import { QboModule } from '../qbo/qbo.module';
import { MappingModule } from '../mappings/mapping.module';

@Module({
  imports: [QboModule, MappingModule],
  controllers: [FbrCustomerController],
  providers: [FbrService],
  exports: [FbrService],
})
export class FbrModule {}
