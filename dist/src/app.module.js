"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const event_emitter_1 = require("@nestjs/event-emitter");
const schedule_1 = require("@nestjs/schedule");
const throttler_1 = require("@nestjs/throttler");
const cache_manager_1 = require("@nestjs/cache-manager");
const core_1 = require("@nestjs/core");
const prisma_module_1 = require("./prisma/prisma.module");
const encryption_module_1 = require("./common/encryption/encryption.module");
const email_module_1 = require("./modules/email/email.module");
const realtime_module_1 = require("./modules/realtime/realtime.module");
const notifications_module_1 = require("./modules/notifications/notifications.module");
const audit_module_1 = require("./modules/audit/audit.module");
const auth_module_1 = require("./modules/auth/auth.module");
const users_module_1 = require("./modules/users/users.module");
const tenants_module_1 = require("./modules/tenants/tenants.module");
const clients_module_1 = require("./modules/clients/clients.module");
const pipeline_module_1 = require("./modules/pipeline/pipeline.module");
const offers_module_1 = require("./modules/offers/offers.module");
const instagram_module_1 = require("./modules/instagram/instagram.module");
const bookings_module_1 = require("./modules/bookings/bookings.module");
const payments_module_1 = require("./modules/payments/payments.module");
const telegram_personal_module_1 = require("./modules/telegram-personal/telegram-personal.module");
const telegram_module_1 = require("./modules/telegram/telegram.module");
const user_telegram_module_1 = require("./modules/telegram/user-telegram.module");
const reports_module_1 = require("./modules/reports/reports.module");
const owner_module_1 = require("./modules/owner/owner.module");
const followups_module_1 = require("./modules/followups/followups.module");
const tasks_module_1 = require("./modules/tasks/tasks.module");
const leads_module_1 = require("./modules/leads/leads.module");
const calls_module_1 = require("./modules/calls/calls.module");
const kpi_module_1 = require("./modules/kpi/kpi.module");
const documents_module_1 = require("./modules/documents/documents.module");
const search_module_1 = require("./modules/search/search.module");
const automations_module_1 = require("./modules/automations/automations.module");
const backup_module_1 = require("./modules/backup/backup.module");
const invoices_module_1 = require("./modules/invoices/invoices.module");
const uploads_module_1 = require("./modules/uploads/uploads.module");
const v8_module_1 = require("./modules/v8/v8.module");
const passengers_module_1 = require("./modules/v9/passengers.module");
const approvals_module_1 = require("./modules/v9/approvals.module");
const round_robin_module_1 = require("./modules/v9/round-robin.module");
const command_palette_module_1 = require("./modules/v9/command-palette.module");
const services_module_1 = require("./modules/v9/services.module");
const public_leads_module_1 = require("./modules/v9/public-leads.module");
const lead_forms_module_1 = require("./modules/v9/lead-forms.module");
const phone_providers_module_1 = require("./modules/phone-providers/phone-providers.module");
const whatsapp_module_1 = require("./modules/whatsapp/whatsapp.module");
const health_module_1 = require("./modules/health/health.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot({ isGlobal: true }),
            event_emitter_1.EventEmitterModule.forRoot({ maxListeners: 50 }),
            schedule_1.ScheduleModule.forRoot(),
            throttler_1.ThrottlerModule.forRoot([
                {
                    ttl: parseInt(process.env.THROTTLE_TTL || '60') * 1000,
                    limit: parseInt(process.env.THROTTLE_LIMIT || '100'),
                },
            ]),
            cache_manager_1.CacheModule.register({ isGlobal: true, ttl: 60000, max: 1000 }),
            prisma_module_1.PrismaModule,
            encryption_module_1.EncryptionModule,
            email_module_1.EmailModule,
            realtime_module_1.RealtimeModule,
            notifications_module_1.NotificationsModule,
            audit_module_1.AuditModule,
            auth_module_1.AuthModule,
            users_module_1.UsersModule,
            tenants_module_1.TenantsModule,
            clients_module_1.ClientsModule,
            pipeline_module_1.PipelineModule,
            offers_module_1.OffersModule,
            instagram_module_1.InstagramModule,
            bookings_module_1.BookingsModule,
            payments_module_1.PaymentsModule,
            telegram_module_1.TelegramModule,
            telegram_personal_module_1.TelegramPersonalModule,
            user_telegram_module_1.UserTelegramModule,
            reports_module_1.ReportsModule,
            owner_module_1.OwnerModule,
            followups_module_1.FollowUpsModule,
            tasks_module_1.TasksModule,
            leads_module_1.LeadsModule,
            calls_module_1.CallsModule,
            kpi_module_1.KpiModule,
            documents_module_1.DocumentsModule,
            search_module_1.SearchModule,
            automations_module_1.AutomationsModule,
            backup_module_1.BackupModule,
            invoices_module_1.InvoicesModule,
            uploads_module_1.UploadsModule,
            v8_module_1.V8Module,
            passengers_module_1.PassengersModule,
            approvals_module_1.ApprovalsModule,
            round_robin_module_1.RoundRobinModule,
            command_palette_module_1.CommandPaletteModule,
            services_module_1.ServicesModule,
            public_leads_module_1.PublicLeadsModule,
            lead_forms_module_1.LeadFormsModule,
            phone_providers_module_1.PhoneProvidersModule,
            health_module_1.HealthModule,
            whatsapp_module_1.WhatsAppModule,
        ],
        providers: [{ provide: core_1.APP_GUARD, useClass: throttler_1.ThrottlerGuard }],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map