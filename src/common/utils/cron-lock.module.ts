import { Global, Module } from '@nestjs/common';
import { CronLockService } from './cron-lock.service';
import { RedisClientModule } from '../cache/redis-client.module';

/**
 * Global — barcha modullar CronLockService'ni import qilmasdan
 * ishlata olsin (RealtimeGateway, NotificationsService kabi).
 */
@Global()
@Module({
  imports: [RedisClientModule],
  providers: [CronLockService],
  exports: [CronLockService],
})
export class CronLockModule {}