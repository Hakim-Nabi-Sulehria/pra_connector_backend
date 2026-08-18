import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { QboModule } from '../qbo/qbo.module';
import { MappingModule } from '../mappings/mapping.module';
import { PraModule } from '../pra/pra.module';

@Module({
  imports: [QboModule, MappingModule, PraModule],
  controllers: [CustomerController],
})
export class CustomerModule {}
