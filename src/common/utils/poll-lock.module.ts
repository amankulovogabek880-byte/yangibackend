import { Global, Module } from '@nestjs/common';
import { PollLockService } from './poll-lock.service';
import { RedisClientModule } from '../cache/redis-client.module';
import { PrismaModule } from '../../prisma/prisma.module';

/**
 * Global — barcha modullar (telegram.module.ts, jarvis-bot.module.ts va h.k.)
 * PollLockService'ni alohida import qilmasdan ishlata olsin.
 *
 * v19: PrismaModule ham import qilindi — PollLockService endi Redis
 * mavjud bo'lmagan holatda DB (PlatformSetting) orqali fallback qulfdan
 * foydalanadi (PrismaModule allaqachon @Global, lekin aniqlik uchun
 * shu yerda ham ko'rsatilgan).
 */
@Global()
@Module({
  imports: [RedisClientModule, PrismaModule],
  providers: [PollLockService],
  exports: [PollLockService],
})
export class PollLockModule {}