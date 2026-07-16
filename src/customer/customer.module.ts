import { Module } from '@nestjs/common';
import { CustomerController } from './customer.controller';
import { QboModule } from '../qbo/qbo.module';
import { MappingModule } from '../mappings/mapping.module';

@Module({
  imports: [QboModule, MappingModule],
  controllers: [CustomerController],
})
export class CustomerModule {}
