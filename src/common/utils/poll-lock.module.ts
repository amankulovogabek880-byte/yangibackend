import { Global, Module } from '@nestjs/common';
import { PollLockService } from './poll-lock.service';
import { RedisClientModule } from '../cache/redis-client.module';

/**
 * Global — barcha modullar (telegram.module.ts, jarvis-bot.module.ts va h.k.)
 * PollLockService'ni alohida import qilmasdan ishlata olsin.
 */
@Global()
@Module({
  imports: [RedisClientModule],
  providers: [PollLockService],
  exports: [PollLockService],
})
export class PollLockModule {}