import { Module } from '@nestjs/common';
import { MappingService } from './mapping.service';
import { QboModule } from '../qbo/qbo.module';

@Module({
  imports: [QboModule],
  providers: [MappingService],
  exports: [MappingService],
})
export class MappingModule {}
