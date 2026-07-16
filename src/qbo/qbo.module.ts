import { Module } from '@nestjs/common';
import { QboService } from './qbo.service';
import { QboController } from './qbo.controller';

@Module({
  controllers: [QboController],
  providers: [QboService],
  exports: [QboService],
})
export class QboModule {}
