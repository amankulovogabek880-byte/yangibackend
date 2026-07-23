import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { RedisClientModule } from './common/cache/redis-client.module';
import { REDIS_CLIENT } from './common/cache/cache.constants';
import { RedisThrottlerStorage } from './common/guards/redis-throttler.storage';
import { CronLockModule } from './common/utils/cron-lock.module';
import { TenantContextMiddleware } from './common/tenant/tenant-context.middleware';
import { TenantContextInterceptor } from './common/tenant/tenant-context.interceptor';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { PrismaModule } from './prisma/prisma.module';
import { AppCacheModule } from './common/cache/cache.module';

// ─── GLOBAL (v4) ─────────────────────────────────────────────
import { EncryptionModule } from './common/encryption/encryption.module';
import { EmailModule } from './modules/email/email.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuditModule } from './modules/audit/audit.module';

// ─── FEATURES ────────────────────────────────────────────────
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { ClientsModule } from './modules/clients/clients.module';
import { PipelineModule } from './modules/pipeline/pipeline.module';
import { OffersModule } from './modules/offers/offers.module';
import { InstagramModule } from './modules/instagram/instagram.module';
import { FacebookLeadsModule } from './modules/facebook-leads/facebook-leads.module';   // ← YANGI
import { BookingsModule } from './modules/bookings/bookings.module';
import { PaymentsModule } from './modules/payments/payments.module';
// v11 FIX: TelegramPersonalModule (eski) olib tashlandi — u UserTelegramModule
// bilan bitta shaxsiy Telegram akkauntga PARALLEL ikkinchi MTProto ulanish
// ochib, xabarlarni ikki marta/nomuvofiq mantiq bilan qayta ishlar edi.
// Bu — dublikat suhbatlar, "hammasi Bot" ko'rinishi, o'z xabari begonaga
// o'xshab qolishi va ulanish beqarorligining bosh sababi edi.
import { TelegramModule } from './modules/telegram/telegram.module';
import { UserTelegramModule } from './modules/telegram/user-telegram.module';
import { ReportsModule } from './modules/reports/reports.module';
import { OwnerModule } from './modules/owner/owner.module';
import { FollowUpsModule } from './modules/followups/followups.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { LeadsModule } from './modules/leads/leads.module';
import { CallsModule } from './modules/calls/calls.module';
import { KpiModule } from './modules/kpi/kpi.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { SearchModule } from './modules/search/search.module';
import { AutomationsModule } from './modules/automations/automations.module';
import { BackupModule } from './modules/backup/backup.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { V8Module } from './modules/v8/v8.module';
// v9: Yangi modullar
import { PassengersModule } from './modules/v9/passengers.module';
import { RoundRobinModule } from './modules/v9/round-robin.module';
import { CommandPaletteModule } from './modules/v9/command-palette.module';
import { ServicesModule } from './modules/v9/services.module';
import { PublicLeadsModule } from './modules/v9/public-leads.module';
import { LeadFormsModule } from './modules/v9/lead-forms.module';
import { PhoneProvidersModule } from './modules/phone-providers/phone-providers.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { HealthModule } from './modules/health/health.module';
import { ExchangeRateModule } from './modules/exchange-rate/exchange-rate.module';
// v12: Turlar bozori (marketplace) — tur operatorlar + umumiy turlar + bron so'rovlari
import { MarketplaceModule } from './modules/marketplace/marketplace.module';
// v14: JONLI tur qidiruvi. MUHIM TUZATISH: bu modul fayli oldin ham mavjud edi,
// lekin hech qayerda import qilinmagan edi — ya'ni /tour-search/* barcha
// endpointlari production'da 404 qaytarardi, garchi kod to'liq yozilgan bo'lsa ham.
import { TourSearchModule } from './modules/tour-search/tour-search.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot({ maxListeners: 50 }),
    ScheduleModule.forRoot(),
    // v12.5: hisoblagich Redis'da — bir nechta instansda limit UMUMIY
    // bo'ladi. Redis yo'q bo'lsa avtomatik xotira rejimiga tushadi.
    ThrottlerModule.forRootAsync({
      imports: [RedisClientModule],
      inject: [REDIS_CLIENT],
      useFactory: (redis: any) => ({
        throttlers: [
          {
            ttl: parseInt(process.env.THROTTLE_TTL || '60') * 1000,
            limit: parseInt(process.env.THROTTLE_LIMIT || '100'),
          },
        ],
        storage: new RedisThrottlerStorage(redis),
      }),
    }),
    // Cache: Redis (ioredis) bilan ishlaydigan global cache — REDIS_URL bo'lsa
    // Redis'ga, bo'lmasa in-memory'ga tushadi. CacheService ni butun ilovaga beradi.
    AppCacheModule,
    PrismaModule,

    // v12.7: cron ishlarini bir nechta instansda takrorlanmasligi uchun
    CronLockModule,

    // Global - tartib muhim (Encryption -> Email -> Realtime -> Notifications)
    EncryptionModule,
    EmailModule,
    RealtimeModule,
    NotificationsModule,
    AuditModule,

    // Features
    AuthModule,
    UsersModule,
    TenantsModule,
    ClientsModule,
    PipelineModule,
    OffersModule,
    InstagramModule,
    FacebookLeadsModule,   // ← YANGI
    BookingsModule,
    PaymentsModule,
    TelegramModule,
    UserTelegramModule,
    ReportsModule,
    OwnerModule,
    FollowUpsModule,
    TasksModule,
    LeadsModule,
    CallsModule,
    KpiModule,
    DocumentsModule,
    SearchModule,
    AutomationsModule,
    BackupModule,
    InvoicesModule,
    UploadsModule,
    V8Module,
    // v9:
    PassengersModule,
    RoundRobinModule,
    CommandPaletteModule,
    ServicesModule,
    PublicLeadsModule,
    LeadFormsModule,
    PhoneProvidersModule,
    HealthModule,
    WhatsAppModule, // BUG1 FIX
    ExchangeRateModule, // v10: CBU.uz valyuta kursi (offer/booking currency konvertatsiyasi)
    MarketplaceModule,  // v12: Turlar bozori
    TourSearchModule,   // v14: Jonli tur qidiruvi — ← YANGI (avval ro'yxatga olinmagan edi)
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // v12.7: har bir so'rovga tenant kontekstini yozadi
    // (guard'lardan KEYIN ishlaydi, ya'ni req.user tayyor bo'ladi)
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class AppModule implements NestModule {
  /**
   * TenantContextMiddleware BARCHA marshrutlarga qo'llanadi.
   *
   * U so'rov boshida bo'sh AsyncLocalStorage konteksti ochadi;
   * TenantContextInterceptor esa guard'lardan keyin uni to'ldiradi.
   * Shu ikkisi birgalikda Prisma tenant-guard'ini ta'minlaydi.
   */
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantContextMiddleware).forRoutes('*');
  }
}