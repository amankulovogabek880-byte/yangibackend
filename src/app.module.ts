import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { CacheModule } from '@nestjs/cache-manager';
import { APP_GUARD } from '@nestjs/core';

import { PrismaModule } from './prisma/prisma.module';

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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot({ maxListeners: 50 }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env.THROTTLE_TTL || '60') * 1000,
        limit: parseInt(process.env.THROTTLE_LIMIT || '100'),
      },
    ]),
    CacheModule.register({ isGlobal: true, ttl: 60000, max: 1000 }),
    PrismaModule,

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
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}