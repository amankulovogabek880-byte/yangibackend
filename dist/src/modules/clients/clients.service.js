"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClientsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
;
const helpers_1 = require("../../common/utils/helpers");
const event_emitter_1 = require("@nestjs/event-emitter");
const notifications_service_1 = require("../notifications/notifications.service");
const round_robin_module_1 = require("../v9/round-robin.module");
const encryption_service_1 = require("../../common/encryption/encryption.service");
const CLIENT_STATUSES = ['ACTIVE', 'INACTIVE', 'BLACKLISTED'];
const TIERS = ['REGULAR', 'SILVER', 'GOLD', 'VIP'];
const SOURCES = [
    'TELEGRAM', 'INSTAGRAM', 'WHATSAPP', 'REFERRAL',
    'WALKIN', 'WEBSITE', 'CALL', 'FACEBOOK', 'GOOGLE_ADS', 'OTHER',
];
const LANGUAGES = ['UZ', 'RU', 'EN'];
let ClientsService = class ClientsService {
    constructor(prisma, eventEmitter, notifications, encryption, roundRobin) {
        this.prisma = prisma;
        this.eventEmitter = eventEmitter;
        this.notifications = notifications;
        this.encryption = encryption;
        this.roundRobin = roundRobin;
        this.logger = new common_1.Logger('Clients');
    }
    decryptClient(client) {
        if (!client)
            return client;
        return {
            ...client,
            passportNo: client.passportNo ? this.encryption.decrypt(client.passportNo) || client.passportNo : null,
            passportMasked: client.passportNo ? this.encryption.mask(this.encryption.decrypt(client.passportNo) || '') : null,
            address: client.address ? this.encryption.decrypt(client.address) || client.address : null,
        };
    }
    encryptClientData(data) {
        const out = { ...data };
        if (data.passportNo)
            out.passportNo = this.encryption.encrypt(data.passportNo);
        if (data.address)
            out.address = this.encryption.encrypt(data.address);
        return out;
    }
    where(tenantId, userId, role, extra = {}) {
        const base = { tenantId, ...extra };
        if (role === 'AGENT')
            base.assignedAgentId = userId;
        return base;
    }
    async findAll(tenantId, userId, role, params) {
        const { skip, take, page, limit } = (0, helpers_1.paginate)(params.page, params.limit);
        const where = this.where(tenantId, userId, role);
        if (params.status && CLIENT_STATUSES.includes(params.status)) {
            where.status = params.status;
        }
        if (params.tier && TIERS.includes(params.tier)) {
            where.tier = params.tier;
        }
        if (params.source && SOURCES.includes(params.source)) {
            where.source = params.source;
        }
        if (params.stage)
            where.pipelineStage = params.stage;
        if (params.agentId && role !== 'AGENT')
            where.assignedAgentId = params.agentId;
        if (params.tag)
            where.tags = { has: params.tag };
        if (params.search?.trim()) {
            const s = params.search.trim();
            where.OR = [
                { fullName: { contains: s, mode: 'insensitive' } },
                { phone: { contains: s } },
                { email: { contains: s, mode: 'insensitive' } },
                { passportNo: { contains: s } },
                { telegramUsername: { contains: s, mode: 'insensitive' } },
            ];
        }
        let orderBy = [
            { lastContactAt: { sort: 'desc', nulls: 'last' } },
            { createdAt: 'desc' },
        ];
        if (params.sortBy === 'name')
            orderBy = { fullName: 'asc' };
        else if (params.sortBy === 'revenue')
            orderBy = { totalRevenue: 'desc' };
        else if (params.sortBy === 'score')
            orderBy = { leadScore: 'desc' };
        const [data, total] = await Promise.all([
            this.prisma.client.findMany({
                where,
                skip,
                take,
                include: {
                    assignedAgent: { select: { id: true, name: true, avatarUrl: true } },
                    _count: { select: { bookings: true } },
                },
                orderBy,
            }),
            this.prisma.client.count({ where }),
        ]);
        return { data, meta: (0, helpers_1.meta)(total, page, limit) };
    }
    async findOne(tenantId, id, userId, role) {
        const where = this.where(tenantId, userId, role, { id });
        const client = await this.prisma.client.findFirst({
            where,
            include: {
                assignedAgent: { select: { id: true, name: true, avatarUrl: true } },
                bookings: {
                    orderBy: { createdAt: 'desc' },
                    take: 10,
                    include: {
                        agent: { select: { id: true, name: true } },
                    },
                },
                payments: { orderBy: { paidAt: 'desc' }, take: 10 },
                timeline: { orderBy: { createdAt: 'desc' }, take: 30 },
                followUps: {
                    where: { done: false },
                    orderBy: { dueAt: 'asc' },
                    take: 10,
                },
                documents: { orderBy: { createdAt: 'desc' }, take: 20 },
                _count: {
                    select: {
                        bookings: true,
                        payments: true,
                        documents: true,
                        calls: true,
                        followUps: true,
                    },
                },
            },
        });
        if (!client)
            throw new common_1.NotFoundException('Klient topilmadi');
        return this.decryptClient(client);
    }
    async create(tenantId, userId, data) {
        if (!data.fullName?.trim()) {
            throw new common_1.BadRequestException('To\'liq ism majburiy');
        }
        const fullName = String(data.fullName).trim();
        let phone = null;
        if (data.phone?.trim()) {
            phone = String(data.phone).trim();
            if (!phone.match(/^[0-9\+\-\(\) ]{5,20}$/)) {
                throw new common_1.BadRequestException('Telefon raqam noto\'g\'ri formatda');
            }
        }
        if (phone) {
            const dup = await this.prisma.client.findFirst({
                where: { tenantId, phone },
            });
            if (dup) {
                await this.addTimeline(dup.id, 'duplicate_attempt', 'Yana lead keldi (duplikat)', data.note, { source: data.source });
                throw new common_1.BadRequestException("Bu telefon raqam allaqachon mavjud");
            }
        }
        let assignedAgentId = data.assignedAgentId || null;
        if (!assignedAgentId) {
            const tenant = await this.prisma.tenant.findUnique({
                where: { id: tenantId },
                select: { leadAssignmentStrategy: true },
            });
            const strategy = tenant?.leadAssignmentStrategy || 'ROUND_ROBIN';
            if (strategy !== 'MANUAL') {
                if (this.roundRobin) {
                    assignedAgentId = await this.roundRobin.getNextAgent(tenantId);
                }
                else {
                    assignedAgentId = await (0, helpers_1.pickNextAgent)(this.prisma, tenantId);
                }
                if (assignedAgentId) {
                    this.logger.log(`[ROUND ROBIN] Lead → Agent: ${assignedAgentId} | Tenant: ${tenantId}`);
                }
            }
            else {
                this.logger.log(`[CLIENTS] MANUAL strategiya — agent tayinlanmadi | Tenant: ${tenantId}`);
            }
        }
        const score = (0, helpers_1.calculateLeadScore)({
            source: data.source,
            tier: data.tier,
            email: data.email,
            passportNo: data.passportNo,
        });
        const client = await this.prisma.client.create({
            data: {
                tenantId,
                fullName: fullName,
                phone: phone || null,
                phone2: data.phone2?.trim() || null,
                email: data.email?.trim().toLowerCase() || null,
                passportNo: data.passportNo ? this.encryption.encrypt(data.passportNo) : undefined,
                passportExpiry: data.passportExpiry ? new Date(data.passportExpiry) : undefined,
                dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : undefined,
                nationality: data.nationality?.trim() || null,
                country: data.country?.trim() || null,
                gender: data.gender,
                address: data.address ? this.encryption.encrypt(data.address.trim()) : undefined,
                city: data.city?.trim() || null,
                language: (0, helpers_1.safeEnum)(data.language, LANGUAGES, 'UZ'),
                source: (0, helpers_1.safeEnum)(data.source, SOURCES, 'OTHER'),
                tier: (0, helpers_1.safeEnum)(data.tier, TIERS, 'REGULAR'),
                sourceCampaign: data.sourceCampaign?.trim() || null,
                utmSource: data.utmSource?.trim() || null,
                utmMedium: data.utmMedium?.trim() || null,
                utmCampaign: data.utmCampaign?.trim() || null,
                utmTerm: data.utmTerm?.trim() || null,
                utmContent: data.utmContent?.trim() || null,
                referrerUrl: data.referrerUrl?.trim() || null,
                notes: data.notes?.trim() || null,
                tags: Array.isArray(data.tags) ? data.tags.filter((t) => t?.trim()) : [],
                assignedAgentId: assignedAgentId,
                telegramId: data.telegramId || null,
                telegramUsername: data.telegramUsername?.trim() || null,
                instagramHandle: data.instagramHandle?.trim() || null,
                familyMembers: data.familyMembers || [],
                preferences: data.preferences || {},
                leadScore: score,
                firstContactAt: new Date(),
                lastContactAt: new Date(),
            },
        });
        await this.addTimeline(client.id, 'created', 'Klient yaratildi', undefined, {
            userId,
            source: client.source,
        });
        try {
            this.eventEmitter.emit('lead.created', {
                tenantId: client.tenantId,
                clientId: client.id,
                assignedAgentId: client.assignedAgentId,
            });
        }
        catch { }
        if (client.assignedAgentId && client.assignedAgentId !== userId) {
            await this.notifications.create({
                tenantId,
                userId: client.assignedAgentId,
                type: 'LEAD_ASSIGNED',
                title: '🔥 Yangi klient sizga tayinlandi',
                body: `${client.fullName} • ${client.phone}`,
                link: `/clients/${client.id}`,
                metadata: { clientId: client.id },
            });
        }
        return client;
    }
    async update(tenantId, id, userId, role, data) {
        await this.findOne(tenantId, id, userId, role);
        const { id: _id, tenantId: _t, createdAt: _c, updatedAt: _u, totalBookings: _tb, totalRevenue: _tr, totalSpent: _ts, leadScore: _ls, pipelineStage: _ps, ...safe } = data;
        if (safe.dateOfBirth)
            safe.dateOfBirth = new Date(safe.dateOfBirth);
        if (safe.passportExpiry)
            safe.passportExpiry = new Date(safe.passportExpiry);
        if (safe.language)
            safe.language = (0, helpers_1.safeEnum)(safe.language, LANGUAGES, 'UZ');
        if (safe.source)
            safe.source = (0, helpers_1.safeEnum)(safe.source, SOURCES, 'OTHER');
        if (safe.tier)
            safe.tier = (0, helpers_1.safeEnum)(safe.tier, TIERS, 'REGULAR');
        if (safe.status)
            safe.status = (0, helpers_1.safeEnum)(safe.status, CLIENT_STATUSES, 'ACTIVE');
        if (safe.passportNo)
            safe.passportNo = this.encryption.encrypt(safe.passportNo);
        if (safe.address)
            safe.address = this.encryption.encrypt(safe.address);
        return this.prisma.client.update({
            where: { id },
            data: (0, helpers_1.clean)(safe),
        });
    }
    async delete(tenantId, id, userId, role) {
        if (role === 'AGENT') {
            throw new common_1.BadRequestException("Agentlar klientlarni o'chira olmaydi");
        }
        await this.findOne(tenantId, id, userId, role);
        await this.prisma.client.delete({ where: { id } });
        return { ok: true };
    }
    async getTimeline(tenantId, id, userId, role) {
        await this.findOne(tenantId, id, userId, role);
        return this.prisma.clientTimeline.findMany({
            where: { clientId: id },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
    }
    async addNote(tenantId, id, userId, role, note) {
        if (!note?.trim())
            throw new common_1.BadRequestException("Izoh bo'sh");
        await this.findOne(tenantId, id, userId, role);
        return this.addTimeline(id, 'note', 'Izoh qoldirildi', note.trim(), { userId });
    }
    async setTier(tenantId, id, userId, role, tier) {
        if (role === 'AGENT') {
            throw new common_1.BadRequestException("Agentlar tier o'zgartira olmaydi");
        }
        const t = (0, helpers_1.safeEnum)(tier, TIERS, 'REGULAR');
        const client = await this.prisma.client.update({
            where: { id },
            data: { tier: t },
        });
        await this.addTimeline(id, 'tier_changed', `Daraja: ${t}`, undefined, { tier: t, userId });
        return client;
    }
    async findOrCreateConversation(tenantId, clientId, userId, role) {
        const client = await this.prisma.client.findFirst({
            where: this.where(tenantId, userId, role, { id: clientId }),
        });
        if (!client)
            throw new common_1.NotFoundException('Klient topilmadi');
        let conv = await this.prisma.conversation.findFirst({
            where: {
                tenantId,
                clientId,
                ...(role === 'AGENT' ? {
                    OR: [{ assignedAgentId: userId }, { assignedAgentId: null }],
                } : {}),
            },
            orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        });
        if (conv) {
            return { conversationId: conv.id, isNew: false };
        }
        if (!client.telegramId && !client.telegramUsername && !client.phone) {
            throw new common_1.BadRequestException("Klient bilan suhbat boshlash uchun Telegram yoki telefon kerak");
        }
        conv = await this.prisma.conversation.create({
            data: {
                tenantId,
                clientId,
                channel: client.telegramId ? 'TELEGRAM' : 'WHATSAPP',
                externalChatId: client.telegramId || client.phone || `manual-${clientId}`,
                externalUserId: client.telegramId || undefined,
                firstName: client.fullName.split(' ')[0],
                lastName: client.fullName.split(' ').slice(1).join(' ') || undefined,
                username: client.telegramUsername || undefined,
                assignedAgentId: role === 'AGENT' ? userId : client.assignedAgentId,
            },
        });
        return { conversationId: conv.id, isNew: true };
    }
    async getExistingConversation(tenantId, clientId, userId, role) {
        const client = await this.prisma.client.findFirst({
            where: this.where(tenantId, userId, role, { id: clientId }),
        });
        if (!client)
            throw new common_1.NotFoundException('Klient topilmadi');
        const conv = await this.prisma.conversation.findFirst({
            where: {
                tenantId, clientId,
                ...(role === 'AGENT' ? {
                    OR: [{ assignedAgentId: userId }, { assignedAgentId: null }],
                } : {}),
            },
            orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
            select: {
                id: true, channel: true, lastMessageAt: true, lastMessageText: true,
                unreadCount: true, isResolved: true,
            },
        });
        if (!conv) {
            return { exists: false, conversationId: null };
        }
        return { exists: true, conversationId: conv.id, conversation: conv };
    }
    async initiateCall(tenantId, clientId, userId, role) {
        const client = await this.prisma.client.findFirst({
            where: this.where(tenantId, userId, role, { id: clientId }),
        });
        if (!client)
            throw new common_1.NotFoundException('Klient topilmadi');
        if (!client.phone)
            throw new common_1.BadRequestException("Klientning telefon raqami yo'q");
        const call = await this.prisma.call.create({
            data: {
                tenantId,
                clientId,
                agentId: userId,
                toMasked: client.phone.slice(0, -5) + '***' + client.phone.slice(-2),
                direction: 'OUTBOUND',
                status: 'QUEUED',
            },
        });
        await this.addTimeline(clientId, 'call_initiated', "Qo'ng'iroq qilindi", undefined, {
            callId: call.id, userId,
        });
        return {
            callId: call.id,
            id: call.id,
            phone: client.phone,
            message: "Qo'ng'iroq /api/v1/calls/initiate orqali phone provider'dan o'tkazilishi mumkin",
        };
    }
    async addTimeline(clientId, type, title, description, metadata) {
        return this.prisma.clientTimeline.create({
            data: {
                clientId,
                userId: metadata?.userId,
                type,
                title,
                description,
                metadata: (metadata || {}),
            },
        });
    }
    async getStats(tenantId, userId, role) {
        const where = this.where(tenantId, userId, role);
        const monthStart = new Date(new Date().setDate(1));
        monthStart.setHours(0, 0, 0, 0);
        const [total, bySource, byTier, byStage, newThisMonth] = await Promise.all([
            this.prisma.client.count({ where }),
            this.prisma.client.groupBy({ by: ['source'], where, _count: { id: true } }),
            this.prisma.client.groupBy({ by: ['tier'], where, _count: { id: true } }),
            this.prisma.client.groupBy({ by: ['pipelineStage'], where, _count: { id: true } }),
            this.prisma.client.count({ where: { ...where, createdAt: { gte: monthStart } } }),
        ]);
        return { total, newThisMonth, bySource, byTier, byStage };
    }
    async recalcStats(clientId) {
        const [bookings, payments] = await Promise.all([
            this.prisma.booking.aggregate({
                where: { clientId, status: { not: 'CANCELLED' } },
                _count: { id: true },
                _sum: { totalPrice: true },
            }),
            this.prisma.payment.aggregate({
                where: { clientId, status: 'COMPLETED' },
                _sum: { amount: true },
            }),
        ]);
        const totalBookings = bookings._count.id || 0;
        const totalRevenue = bookings._sum.totalPrice || 0;
        const totalSpent = payments._sum.amount || 0;
        const avg = totalBookings > 0 ? totalRevenue / totalBookings : 0;
        await this.prisma.client.update({
            where: { id: clientId },
            data: {
                totalBookings,
                totalRevenue,
                totalSpent,
                avgBookingValue: avg,
                lifetimeValue: totalSpent,
            },
        });
    }
    async exportCsv(tenantId, userId, role) {
        const where = { tenantId };
        if (role === 'AGENT')
            where.assignedAgentId = userId;
        const clients = await this.prisma.client.findMany({
            where,
            include: { assignedAgent: { select: { name: true } } },
            orderBy: { createdAt: 'desc' },
        });
        const headers = ['Ism', 'Telefon', 'Email', 'Manba', 'Bosqich', 'Tier', 'Mamlakat', 'Agent', 'Bookings', 'Daromad', 'Yaratilgan'];
        const csv = [
            headers.join(','),
            ...clients.map((c) => [
                (c.fullName || '').replace(/,/g, ';'),
                c.phone || '',
                c.email || '',
                c.source || '',
                c.pipelineStage || '',
                c.tier || '',
                c.country || '',
                (c.assignedAgent?.name || '').replace(/,/g, ';'),
                c.totalBookings || 0,
                c.totalRevenue || 0,
                c.createdAt.toISOString().slice(0, 10),
            ].join(',')),
        ].join('\n');
        return { csv, count: clients.length };
    }
    async statsBySource(tenantId, userId, role) {
        const where = { tenantId };
        if (role === 'AGENT')
            where.assignedAgentId = userId;
        const grouped = await this.prisma.client.groupBy({
            by: ['source'],
            where,
            _count: { id: true },
            _sum: { totalRevenue: true },
        });
        return grouped.map((g) => ({
            source: g.source || 'UNKNOWN',
            count: g._count.id,
            revenue: g._sum.totalRevenue || 0,
        }));
    }
    async statsByStage(tenantId, userId, role) {
        const where = { tenantId };
        if (role === 'AGENT')
            where.assignedAgentId = userId;
        const grouped = await this.prisma.client.groupBy({
            by: ['pipelineStage'],
            where,
            _count: { id: true },
        });
        return grouped.map((g) => ({
            stage: g.pipelineStage,
            count: g._count.id,
        }));
    }
};
exports.ClientsService = ClientsService;
exports.ClientsService = ClientsService = __decorate([
    (0, common_1.Injectable)(),
    __param(4, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        event_emitter_1.EventEmitter2,
        notifications_service_1.NotificationsService,
        encryption_service_1.EncryptionService,
        round_robin_module_1.RoundRobinService])
], ClientsService);
//# sourceMappingURL=clients.service.js.map