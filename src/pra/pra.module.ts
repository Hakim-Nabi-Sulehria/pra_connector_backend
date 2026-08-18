import { Module } from '@nestjs/common';
import { PraService } from './pra.service';
import { QboModule } from '../qbo/qbo.module';

@Module({
  imports: [QboModule],
  providers: [PraService],
  exports: [PraService],
})
export class PraModule {}
