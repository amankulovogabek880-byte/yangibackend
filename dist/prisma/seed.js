"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const argon2 = __importStar(require("argon2"));
const prisma = new client_1.PrismaClient();
async function hashPwd(pwd) {
    return String(await argon2.hash(pwd, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4,
    }));
}
async function main() {
    console.log('\n🌱 TourCRM v4 — Seed boshlandi...\n');
    const platformTenant = await prisma.tenant.upsert({
        where: { slug: '_platform' },
        update: {},
        create: {
            name: 'TourCRM Platform',
            slug: '_platform',
            status: 'ACTIVE',
            plan: 'ENTERPRISE',
        },
    });
    const ownerEmail = process.env.OWNER_EMAIL || 'owner@omoncrm.uz';
    const ownerPassword = process.env.OWNER_PASSWORD || 'Owner@123456!';
    const ownerName = process.env.OWNER_NAME || 'Platform Owner';
    const ownerHash = await hashPwd(ownerPassword);
    await prisma.user.upsert({
        where: { tenantId_email: { tenantId: platformTenant.id, email: ownerEmail } },
        update: {
            passwordHash: ownerHash,
            name: ownerName,
        },
        create: {
            tenantId: platformTenant.id,
            email: ownerEmail,
            passwordHash: ownerHash,
            name: ownerName,
            role: 'PLATFORM_OWNER',
            status: 'ACTIVE',
        },
    });
    console.log(`   ✅ Owner: ${ownerEmail}`);
    const demoTenant = await prisma.tenant.upsert({
        where: { slug: 'demo-travel' },
        update: { leadAssignmentStrategy: 'ROUND_ROBIN' },
        create: {
            name: 'Demo Travel Agency',
            slug: 'demo-travel',
            status: 'ACTIVE',
            plan: 'PROFESSIONAL',
            maxUsers: 20,
            maxClients: 5000,
            maxBookings: 1000,
            leadAssignmentStrategy: 'ROUND_ROBIN',
        },
    });
    const adminHash = await hashPwd('Admin@123456!');
    const agentHash = await hashPwd('Agent@123456!');
    const admin = await prisma.user.upsert({
        where: { tenantId_email: { tenantId: demoTenant.id, email: 'admin@demo.uz' } },
        update: { passwordHash: adminHash, status: 'ACTIVE', mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
        create: {
            tenantId: demoTenant.id,
            email: 'admin@demo.uz',
            passwordHash: adminHash,
            name: 'Bekzod Admin',
            role: 'TENANT_ADMIN',
            status: 'ACTIVE',
            mustChangePassword: false,
            phone: '+998901234567',
        },
    });
    const aziz = await prisma.user.upsert({
        where: { tenantId_email: { tenantId: demoTenant.id, email: 'aziz@demo.uz' } },
        update: { passwordHash: agentHash, status: 'ACTIVE', mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
        create: {
            tenantId: demoTenant.id,
            email: 'aziz@demo.uz',
            passwordHash: agentHash,
            name: 'Aziz Karimov',
            role: 'AGENT',
            status: 'ACTIVE',
            phone: '+998901111111',
        },
    });
    const malika = await prisma.user.upsert({
        where: { tenantId_email: { tenantId: demoTenant.id, email: 'malika@demo.uz' } },
        update: { passwordHash: agentHash, status: 'ACTIVE', mustChangePassword: false, failedLoginCount: 0, lockedUntil: null },
        create: {
            tenantId: demoTenant.id,
            email: 'malika@demo.uz',
            passwordHash: agentHash,
            name: 'Malika Yusupova',
            role: 'AGENT',
            status: 'ACTIVE',
            phone: '+998902222222',
        },
    });
    const pipeline = await prisma.pipeline.findFirst({
        where: { tenantId: demoTenant.id, isDefault: true },
    });
    if (!pipeline) {
        await prisma.pipeline.create({
            data: {
                tenantId: demoTenant.id,
                name: "Asosiy savdo pipeline'i",
                isDefault: true,
            },
        });
    }
    const sampleClients = [
        { fullName: 'Karim Toshev', phone: '+998935551111', source: 'TELEGRAM', stage: 'NEW_LEAD', tier: 'REGULAR', agent: aziz.id },
        { fullName: 'Dilshod Salimov', phone: '+998935551112', source: 'INSTAGRAM', stage: 'CONTACTED', tier: 'REGULAR', agent: aziz.id },
        { fullName: 'Gulnora Yusupova', phone: '+998935551113', source: 'REFERRAL', stage: 'INTERESTED', tier: 'SILVER', agent: malika.id },
        { fullName: 'Sherzod Mirzayev', phone: '+998935551114', source: 'WEBSITE', stage: 'OFFER_SENT', tier: 'REGULAR', agent: aziz.id },
        { fullName: 'Aziza Karimova', phone: '+998935551115', source: 'TELEGRAM', stage: 'NEGOTIATION', tier: 'GOLD', agent: malika.id },
        { fullName: 'Bobur Rakhimov', phone: '+998935551116', source: 'REFERRAL', stage: 'DEPOSIT_PAID', tier: 'VIP', agent: malika.id, leadScore: 95 },
        { fullName: 'Zarina Akhmedova', phone: '+998935551117', source: 'INSTAGRAM', stage: 'CONFIRMED', tier: 'GOLD', agent: aziz.id, leadScore: 80 },
        { fullName: 'Jasur Ergashev', phone: '+998935551118', source: 'WALKIN', stage: 'COMPLETED', tier: 'VIP', agent: malika.id, leadScore: 90 },
        { fullName: 'Nilufar Tursunova', phone: '+998935551119', source: 'CALL', stage: 'LOST', tier: 'REGULAR', agent: aziz.id, lostReason: 'PRICE' },
    ];
    for (const c of sampleClients) {
        const existing = await prisma.client.findFirst({
            where: { tenantId: demoTenant.id, phone: c.phone },
        });
        if (!existing) {
            const client = await prisma.client.create({
                data: {
                    tenantId: demoTenant.id,
                    assignedAgentId: c.agent,
                    fullName: c.fullName,
                    phone: c.phone,
                    source: c.source,
                    tier: c.tier,
                    pipelineStage: c.stage,
                    leadScore: c.leadScore || 50,
                    lostReason: c.lostReason,
                    status: 'ACTIVE',
                    language: 'UZ',
                    firstContactAt: new Date(),
                    lastContactAt: new Date(),
                },
            });
            await prisma.clientTimeline.create({
                data: {
                    clientId: client.id,
                    type: 'created',
                    title: 'Klient yaratildi',
                    description: `Manba: ${c.source}`,
                },
            });
        }
    }
    const templates = [
        { name: 'Salomlashish', category: 'greeting', language: 'UZ',
            text: "Assalomu alaykum {client_name}! 👋\n\nBizning sayohat agentligimizga xush kelibsiz. Sizga qanday yordam bera olamiz?\n\n✈️ Tur paketlar\n🏨 Mehmonxonalar\n🛂 Viza yordami\n💼 Korporativ sayohat" },
        { name: 'Приветствие', category: 'greeting', language: 'RU',
            text: "Здравствуйте {client_name}! 👋\n\nДобро пожаловать в наше туристическое агентство. Чем мы можем вам помочь?" },
        { name: '🏨 Mehmonxona — Dubai (Premium)', category: 'hotel', language: 'UZ',
            text: "🏨 *Atlantis The Palm Dubai* ⭐⭐⭐⭐⭐\n\n📍 Manzil: Palm Jumeirah, Dubay\n🛏 Xona: Deluxe Sea View\n🍽 Ovqatlanish: All Inclusive\n💰 Narx: 2 kishi / 7 kun — $2,500\n\n✨ *Imkoniyatlar:*\n• Aquaventure Waterpark — bepul\n• 13 ta restoran\n• Spa va fitness\n• Xususiy plyaj\n\nQiziqsangiz, batafsil ma'lumot beraman 📞" },
        { name: '🏨 Otel — Antalya (O\'rta)', category: 'hotel', language: 'UZ',
            text: "🏨 *Delphin Imperial Hotel* ⭐⭐⭐⭐⭐\n\n📍 Antalya, Lara plyaj\n🛏 Xona: Standard Land View\n🍽 Ultra All Inclusive\n💰 2 kishi / 7 kun — $1,200\n\n🏖 Plyaj, 5 ta basseyn\n🎢 Akvapark bepul\n🍴 8 ta restoran\n👶 Bolalar klubi" },
        { name: '🏨 Гостиница — Стамбул', category: 'hotel', language: 'RU',
            text: "🏨 *CVK Park Bosphorus Hotel* ⭐⭐⭐⭐⭐\n\n📍 Стамбул, Таксим\n🛏 Номер: Deluxe Bosphorus View\n🍽 Завтрак включён\n💰 2 чел / 5 ночей — $850\n\n🌉 Вид на Босфор\n🚇 5 мин до метро\n🛍 Рядом Истикляль" },
        { name: 'Booking tasdiqlandi', category: 'booking', language: 'UZ',
            text: "✅ *{tour_name}* buyurtmangiz tasdiqlandi!\n\n📋 Booking raqami: *{booking_ref}*\n📅 Sana: {departure_date}\n💰 Jami: ${total_price}\n💳 To'langan: ${paid_amount}\n\nHujjatlaringizni 3 kun ichida tayyorlab beramiz." },
        { name: 'Бронь подтверждена', category: 'booking', language: 'RU',
            text: "✅ Ваша бронь *{tour_name}* подтверждена!\n\n📋 Номер брони: *{booking_ref}*\n📅 Дата: {departure_date}\n💰 Сумма: ${total_price}" },
        { name: "To'lov eslatmasi", category: 'payment', language: 'UZ',
            text: "Hurmatli {client_name} 👋\n\n*{tour_name}* uchun qolgan summa: *${payment_balance}*\n\nIltimos {due_date} sanasigacha to'lab qo'yishingizni so'raymiz.\n\n💳 To'lov usullari:\n• Naqd\n• Karta\n• Payme / Click / Uzum" },
        { name: 'Напоминание об оплате', category: 'payment', language: 'RU',
            text: "Здравствуйте {client_name}!\n\nОстаток по брони *{tour_name}*: *${payment_balance}*\nПросьба оплатить до {due_date}." },
        { name: '3 kun qoldi', category: 'reminder', language: 'UZ',
            text: "Hurmatli {client_name} ✈️\n\nSayohatingizga 3 kun qoldi!\n\n📋 Tekshiring:\n☑ Passport (kamida 6 oy amal qiladi)\n☑ Viza (agar kerak bo'lsa)\n☑ Bilet va voucher\n☑ Sug'urta polisi\n\nHar qanday savol bo'lsa yozing 📞" },
        { name: '3 дня до вылета', category: 'reminder', language: 'RU',
            text: "Уважаемый {client_name}!\n\nДо вылета 3 дня! Проверьте документы." },
        { name: 'Viza muvaffaqiyatli', category: 'visa', language: 'UZ',
            text: "🎉 Tabriklaymiz {client_name}!\n\nVizangiz tasdiqlandi ✅\n\n📅 Berilgan: {visa_issue_date}\n📅 Muddati: {visa_expiry_date}\n\nVoucher va biletlar tez orada yuboriladi." },
        { name: 'Sayohatdan keyin', category: 'feedback', language: 'UZ',
            text: "Assalomu alaykum {client_name}! 🌟\n\nSayohatingiz qanday o'tdi? Bizga 1-5 baholaringizni yuboring va 10% chegirma yutib oling 🎁" },
    ];
    for (const t of templates) {
        const ex = await prisma.messageTemplate.findFirst({
            where: { tenantId: demoTenant.id, name: t.name },
        });
        if (!ex) {
            await prisma.messageTemplate.create({
                data: { tenantId: demoTenant.id, ...t },
            });
        }
    }
    console.log('💼 Demo bookings + payments yaratilmoqda...');
    const allClients = await prisma.client.findMany({
        where: { tenantId: demoTenant.id, pipelineStage: { in: ['DEPOSIT_PAID', 'CONFIRMED', 'TRAVELING', 'COMPLETED'] } },
        take: 5,
    });
    const demoBookings = [
        { tourName: 'Dubay 7 kunlik tur', destination: 'Dubay, BAA', totalPrice: 3500, supplierCost: 2200, adults: 2, children: 0 },
        { tourName: 'Antalya All-Inclusive', destination: 'Antalya, Turkiya', totalPrice: 2800, supplierCost: 1900, adults: 2, children: 1 },
        { tourName: 'Tashkent City Tour', destination: 'Toshkent, Oʻzbekiston', totalPrice: 1200, supplierCost: 700, adults: 4, children: 2 },
        { tourName: 'Samarkand Heritage', destination: 'Samarqand, Oʻzbekiston', totalPrice: 1800, supplierCost: 1100, adults: 2, children: 0 },
        { tourName: 'Bali Honeymoon', destination: 'Bali, Indoneziya', totalPrice: 5200, supplierCost: 3400, adults: 2, children: 0 },
    ];
    let bookingsCreated = 0;
    let paymentsCreated = 0;
    for (let i = 0; i < Math.min(allClients.length, demoBookings.length); i++) {
        const client = allClients[i];
        const d = demoBookings[i];
        const departure = new Date();
        departure.setDate(departure.getDate() + 30 + i * 7);
        const returnD = new Date(departure);
        returnD.setDate(returnD.getDate() + 7);
        const profit = d.totalPrice - d.supplierCost;
        try {
            const booking = await prisma.booking.create({
                data: {
                    tenantId: demoTenant.id,
                    clientId: client.id,
                    agentId: client.assignedAgentId,
                    bookingRef: `BK-${new Date().getFullYear()}-${(1000 + i).toString()}`,
                    tourName: d.tourName,
                    destination: d.destination,
                    tourType: 'PACKAGE',
                    adults: d.adults,
                    children: d.children,
                    totalPrice: d.totalPrice,
                    supplierCost: d.supplierCost,
                    profit: profit,
                    discount: 0,
                    currency: 'USD',
                    status: client.pipelineStage === 'COMPLETED' ? 'COMPLETED' : 'CONFIRMED',
                    departureDate: departure,
                    returnDate: returnD,
                },
            });
            bookingsCreated++;
            const advance = Math.round(d.totalPrice * 0.3);
            await prisma.payment.create({
                data: {
                    tenantId: demoTenant.id,
                    clientId: client.id,
                    bookingId: booking.id,
                    amount: advance,
                    currency: 'USD',
                    method: 'CASH',
                    status: 'COMPLETED',
                    paidAt: new Date(),
                    note: 'Avans to\'lov (30%)',
                },
            });
            paymentsCreated++;
            if (client.pipelineStage === 'COMPLETED') {
                await prisma.payment.create({
                    data: {
                        tenantId: demoTenant.id,
                        clientId: client.id,
                        bookingId: booking.id,
                        amount: d.totalPrice - advance,
                        currency: 'USD',
                        method: 'CARD',
                        status: 'COMPLETED',
                        paidAt: new Date(),
                        note: 'Qoldiq to\'lov',
                    },
                });
                paymentsCreated++;
            }
        }
        catch (e) {
            console.log(`   ⚠ Booking yaratilmadi (${d.tourName}): ${e.message?.substring(0, 60)}`);
        }
    }
    console.log(`   ✅ ${bookingsCreated} ta booking, ${paymentsCreated} ta to'lov yaratildi`);
    try {
        await prisma.tenant.update({
            where: { id: demoTenant.id },
            data: { agentCommissionPercent: 8 },
        });
        console.log('   ✅ Agent komissiya foizi: 8% o\'rnatildi');
    }
    catch (e) {
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ✅ TourCRM v6 — Seed yakunlandi!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  🔑 PLATFORM OWNER:');
    console.log('     owner@omoncrm.uz  /  Owner@123456!');
    console.log('  🏢 TENANT ADMIN:');
    console.log('     admin@demo.uz     /  Admin@123456!');
    console.log('  👤 AGENTS:');
    console.log('     aziz@demo.uz      /  Agent@123456!');
    console.log('     malika@demo.uz    /  Agent@123456!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  📊 Demo data:');
    console.log('     - 9 klient (pipeline\'ning turli bosqichlarida)');
    console.log('     - 8 tour paket');
    console.log('     - 5 xabar shabloni');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    try {
        await prisma.user.updateMany({
            where: { tenantId: demoTenant.id, role: { in: ['AGENT', 'MANAGER'] } },
            data: { lastAssignedAt: null },
        });
        console.log('  ✅ Round-Robin navbati tozalandi (lastAssignedAt = null)');
    }
    catch (e) {
        console.log('  ⚠️  lastAssignedAt reset muvaffaqiyatsiz (npx prisma db push qiling!):', e?.message);
    }
}
main()
    .catch((e) => {
    console.error('❌ Seed xatolik:', e);
    process.exit(1);
})
    .finally(() => prisma.$disconnect());
//# sourceMappingURL=seed.js.map