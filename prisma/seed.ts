import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────
// XAVFSIZLIK TUZATISH:
//   Ilgari OWNER_PASSWORD / demo parollar KODDA hardcoded edi
//   (masalan "Owner@123456!"). Bu repo public/shared bo'lsa —
//   har kim production'dagi super-admin parolini biladi.
//
//   ENDI:
//   1) Production'da OWNER_PASSWORD/OWNER_EMAIL ENV orqali MAJBURIY
//      berilishi kerak — standart qiymat yo'q, bo'lmasa seed to'xtaydi.
//   2) Demo (o'ynash uchun) ma'lumotlar — foydalanuvchilar, mijozlar,
//      bookinglar — ENDI standart holatda YARATILMAYDI. Faqat
//      SEED_DEMO_DATA=true bo'lsa va NODE_ENV !== 'production' bo'lsa
//      yaratiladi. Production'da hech qachon, hatto flag qo'yilsa ham.
//   3) Parollar konsolga CHIQARILMAYDI (loglar, CI screenshotlar,
//      terminal tarixi orqali sizib chiqishining oldi olinadi).
// ─────────────────────────────────────────────────────────────

const isProd = process.env.NODE_ENV === 'production';

function randomPassword(): string {
  // Faqat demo (dev) rejimda, aniq parol berilmagan bo'lsa ishlatiladi.
  return crypto.randomBytes(12).toString('base64url');
}

async function hashPwd(pwd: string): Promise<string> {
  return String(
    await argon2.hash(pwd, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
    }),
  );
}

async function main() {
  console.log('\n🌱 TourCRM v4 — Seed boshlandi...\n');
  console.log(`   Muhit: ${isProd ? 'PRODUCTION' : 'development'}\n`);

  // ── 1. PLATFORM tenant ─────────────────────────────────────────
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

  // ── 2. PLATFORM OWNER ──────────────────────────────────────────
  // XAVFSIZLIK: hardcoded standart parol OLIB TASHLANDI. Owner
  // email/parol FAQAT ENV orqali beriladi — kodda hech qanday
  // qiymat (hatto "standart/demo" ko'rinishida ham) saqlanmaydi.
  const ownerEmail = process.env.OWNER_EMAIL;
  const ownerPassword = process.env.OWNER_PASSWORD;
  const ownerName = process.env.OWNER_NAME || 'Platform Owner';

  if (!ownerEmail || !ownerPassword) {
    throw new Error(
      '\n\n❌ OWNER_EMAIL va OWNER_PASSWORD ENV orqali berilishi SHART.\n' +
      '   Kodda standart/hardcoded parol endi yo\'q (xavfsizlik).\n' +
      '   Masalan:\n' +
      '     OWNER_EMAIL=owner@sizningdomeningiz.uz\n' +
      '     OWNER_PASSWORD=$(openssl rand -base64 24)\n' +
      '   ...keyin qayta ishga tushiring: npm run db:seed\n',
    );
  }
  if (ownerPassword.length < 12) {
    throw new Error('❌ OWNER_PASSWORD kamida 12 belgidan iborat bo\'lishi kerak.');
  }
  if (isProd && /^(owner@123456!?|admin@123456!?|password|123456)$/i.test(ownerPassword)) {
    throw new Error('❌ OWNER_PASSWORD juda oddiy/taxmin qilinadigan. Production uchun kuchli, tasodifiy parol tanlang.');
  }

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

  // ── 3. DEMO DATA (ixtiyoriy) ─────────────────────────────────────
  // XAVFSIZLIK: demo tenant/userlar/mijozlar ENDI standart holatda
  // yaratilmaydi. Faqat lokal/dev muhitda, ATAYLAB SEED_DEMO_DATA=true
  // qo'yilganda ishlaydi. Production'da (NODE_ENV=production) — HECH
  // QACHON, hatto flag qo'yilgan bo'lsa ham (pastdagi shart buni tekshiradi).
  const seedDemo = process.env.SEED_DEMO_DATA === 'true' && !isProd;
  if (!seedDemo) {
    console.log(
      isProd
        ? '   ℹ️  Production muhit — demo ma\'lumotlar yaratilmadi (bu to\'g\'ri xatti-harakat).'
        : '   ℹ️  Demo ma\'lumotlar o\'tkazib yuborildi (yoqish uchun: SEED_DEMO_DATA=true).',
    );
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ✅ Owner yaratildi: ${ownerEmail}`);
    console.log('  (Parol siz bergan OWNER_PASSWORD qiymati — konsolga chiqarilmaydi)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    return;
  }

  const demoTenant = await prisma.tenant.upsert({
    where: { slug: 'demo-travel' },
    update: { leadAssignmentStrategy: 'ROUND_ROBIN' as any },
    create: {
      name: 'Demo Travel Agency',
      slug: 'demo-travel',
      status: 'ACTIVE',
      plan: 'PROFESSIONAL',
      maxUsers: 20,
      maxClients: 5000,
      maxBookings: 1000,
      leadAssignmentStrategy: 'ROUND_ROBIN' as any,
    },
  });

  // ── 4. USERS ────────────────────────────────────────────────────
  // XAVFSIZLIK: parollar endi hardcoded emas — har seed ishga
  // tushganda tasodifiy generatsiya qilinadi va FAQAT shu terminalga
  // bir marta chiqariladi (pastda). Bu blok faqat dev muhitda ishlaydi.
  const adminPassword = process.env.DEMO_ADMIN_PASSWORD || randomPassword();
  const agentPassword = process.env.DEMO_AGENT_PASSWORD || randomPassword();
  const adminHash = await hashPwd(adminPassword);
  const agentHash = await hashPwd(agentPassword);

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

  // ── 5. DEFAULT PIPELINE ────────────────────────────────────────
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

  // ── 6. SAMPLE CLIENTS (pipeline'ning turli bosqichlarida) ──────
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
          source: c.source as any,
          tier: c.tier as any,
          pipelineStage: c.stage as any,
          leadScore: c.leadScore || 50,
          lostReason: c.lostReason as any,
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

  // ── 7. MESSAGE TEMPLATES (v6: kategoriyalar + mehmonxona shablonlari) ──
  const templates = [
    // Salomlashish
    { name: 'Salomlashish', category: 'greeting', language: 'UZ',
      text: "Assalomu alaykum {client_name}! 👋\n\nBizning sayohat agentligimizga xush kelibsiz. Sizga qanday yordam bera olamiz?\n\n✈️ Tur paketlar\n🏨 Mehmonxonalar\n🛂 Viza yordami\n💼 Korporativ sayohat" },
    { name: 'Приветствие', category: 'greeting', language: 'RU',
      text: "Здравствуйте {client_name}! 👋\n\nДобро пожаловать в наше туристическое агентство. Чем мы можем вам помочь?" },

    // Mehmonxona tariflari (v6 — bu shablonlar agentlar uchun asosiy ish quroli)
    { name: '🏨 Mehmonxona — Dubai (Premium)', category: 'hotel', language: 'UZ',
      text: "🏨 *Atlantis The Palm Dubai* ⭐⭐⭐⭐⭐\n\n📍 Manzil: Palm Jumeirah, Dubay\n🛏 Xona: Deluxe Sea View\n🍽 Ovqatlanish: All Inclusive\n💰 Narx: 2 kishi / 7 kun — $2,500\n\n✨ *Imkoniyatlar:*\n• Aquaventure Waterpark — bepul\n• 13 ta restoran\n• Spa va fitness\n• Xususiy plyaj\n\nQiziqsangiz, batafsil ma'lumot beraman 📞" },
    { name: '🏨 Otel — Antalya (O\'rta)', category: 'hotel', language: 'UZ',
      text: "🏨 *Delphin Imperial Hotel* ⭐⭐⭐⭐⭐\n\n📍 Antalya, Lara plyaj\n🛏 Xona: Standard Land View\n🍽 Ultra All Inclusive\n💰 2 kishi / 7 kun — $1,200\n\n🏖 Plyaj, 5 ta basseyn\n🎢 Akvapark bepul\n🍴 8 ta restoran\n👶 Bolalar klubi" },
    { name: '🏨 Гостиница — Стамбул', category: 'hotel', language: 'RU',
      text: "🏨 *CVK Park Bosphorus Hotel* ⭐⭐⭐⭐⭐\n\n📍 Стамбул, Таксим\n🛏 Номер: Deluxe Bosphorus View\n🍽 Завтрак включён\n💰 2 чел / 5 ночей — $850\n\n🌉 Вид на Босфор\n🚇 5 мин до метро\n🛍 Рядом Истикляль" },

    // Booking confirmation
    { name: 'Booking tasdiqlandi', category: 'booking', language: 'UZ',
      text: "✅ *{tour_name}* buyurtmangiz tasdiqlandi!\n\n📋 Booking raqami: *{booking_ref}*\n📅 Sana: {departure_date}\n💰 Jami: ${total_price}\n💳 To'langan: ${paid_amount}\n\nHujjatlaringizni 3 kun ichida tayyorlab beramiz." },
    { name: 'Бронь подтверждена', category: 'booking', language: 'RU',
      text: "✅ Ваша бронь *{tour_name}* подтверждена!\n\n📋 Номер брони: *{booking_ref}*\n📅 Дата: {departure_date}\n💰 Сумма: ${total_price}" },

    // Payment
    { name: "To'lov eslatmasi", category: 'payment', language: 'UZ',
      text: "Hurmatli {client_name} 👋\n\n*{tour_name}* uchun qolgan summa: *${payment_balance}*\n\nIltimos {due_date} sanasigacha to'lab qo'yishingizni so'raymiz.\n\n💳 To'lov usullari:\n• Naqd\n• Karta\n• Payme / Click / Uzum" },
    { name: 'Напоминание об оплате', category: 'payment', language: 'RU',
      text: "Здравствуйте {client_name}!\n\nОстаток по брони *{tour_name}*: *${payment_balance}*\nПросьба оплатить до {due_date}." },

    // Travel reminder
    { name: '3 kun qoldi', category: 'reminder', language: 'UZ',
      text: "Hurmatli {client_name} ✈️\n\nSayohatingizga 3 kun qoldi!\n\n📋 Tekshiring:\n☑ Passport (kamida 6 oy amal qiladi)\n☑ Viza (agar kerak bo'lsa)\n☑ Bilet va voucher\n☑ Sug'urta polisi\n\nHar qanday savol bo'lsa yozing 📞" },
    { name: '3 дня до вылета', category: 'reminder', language: 'RU',
      text: "Уважаемый {client_name}!\n\nДо вылета 3 дня! Проверьте документы." },

    // Visa
    { name: 'Viza muvaffaqiyatli', category: 'visa', language: 'UZ',
      text: "🎉 Tabriklaymiz {client_name}!\n\nVizangiz tasdiqlandi ✅\n\n📅 Berilgan: {visa_issue_date}\n📅 Muddati: {visa_expiry_date}\n\nVoucher va biletlar tez orada yuboriladi." },

    // Goodbye / Survey
    { name: 'Sayohatdan keyin', category: 'feedback', language: 'UZ',
      text: "Assalomu alaykum {client_name}! 🌟\n\nSayohatingiz qanday o'tdi? Bizga 1-5 baholaringizni yuboring va 10% chegirma yutib oling 🎁" },
  ];
  for (const t of templates) {
    const ex = await prisma.messageTemplate.findFirst({
      where: { tenantId: demoTenant.id, name: t.name },
    });
    if (!ex) {
      await prisma.messageTemplate.create({
        data: { tenantId: demoTenant.id, ...(t as any) },
      });
    }
  }

  // ── 8. (Tour Packages olib tashlandi v5'da) ───────────────────

  // ─────────────────────────────────────────────────────────────
  // v9-FINAL: Demo BOOKINGS + PAYMENTS yaratish
  // ─────────────────────────────────────────────────────────────
  // Bu hisobotlar va profit ko'rish uchun real ma'lumotlar bo'lib xizmat qiladi
  console.log('💼 Demo bookings + payments yaratilmoqda...');

  const allClients = await prisma.client.findMany({
    where: { tenantId: demoTenant.id, pipelineStage: { in: ['DEPOSIT_PAID', 'CONFIRMED', 'TRAVELING', 'COMPLETED'] as any } },
    take: 5,
  });

  const demoBookings = [
    { tourName: 'Dubay 7 kunlik tur', destination: 'Dubay, BAA',     totalPrice: 3500, supplierCost: 2200, adults: 2, children: 0 },
    { tourName: 'Antalya All-Inclusive', destination: 'Antalya, Turkiya', totalPrice: 2800, supplierCost: 1900, adults: 2, children: 1 },
    { tourName: 'Tashkent City Tour',  destination: 'Toshkent, Oʻzbekiston', totalPrice: 1200, supplierCost: 700, adults: 4, children: 2 },
    { tourName: 'Samarkand Heritage',  destination: 'Samarqand, Oʻzbekiston', totalPrice: 1800, supplierCost: 1100, adults: 2, children: 0 },
    { tourName: 'Bali Honeymoon',      destination: 'Bali, Indoneziya', totalPrice: 5200, supplierCost: 3400, adults: 2, children: 0 },
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
          agentId: client.assignedAgentId!,
          bookingRef: `BK-${new Date().getFullYear()}-${(1000 + i).toString()}`,
          tourName: d.tourName,
          destination: d.destination,
          tourType: 'PACKAGE' as any,
          adults: d.adults,
          children: d.children,
          totalPrice: d.totalPrice,
          supplierCost: d.supplierCost,
          profit: profit,
          discount: 0,
          currency: 'USD' as any,
          status: client.pipelineStage === 'COMPLETED' ? 'COMPLETED' as any : 'CONFIRMED' as any,
          departureDate: departure,
          returnDate: returnD,
        },
      });
      bookingsCreated++;

      // Avans to'lovi (30%)
      const advance = Math.round(d.totalPrice * 0.3);
      await prisma.payment.create({
        data: {
          tenantId: demoTenant.id,
          clientId: client.id,
          bookingId: booking.id,
          amount: advance,
          currency: 'USD' as any,
          method: 'CASH' as any,
          status: 'COMPLETED' as any,
          paidAt: new Date(),
          note: 'Avans to\'lov (30%)',
        },
      });
      paymentsCreated++;

      // Agar Completed bo'lsa — qoldiq to'lov ham
      if (client.pipelineStage === 'COMPLETED') {
        await prisma.payment.create({
          data: {
            tenantId: demoTenant.id,
            clientId: client.id,
            bookingId: booking.id,
            amount: d.totalPrice - advance,
            currency: 'USD' as any,
            method: 'CARD' as any,
            status: 'COMPLETED' as any,
            paidAt: new Date(),
            note: 'Qoldiq to\'lov',
          },
        });
        paymentsCreated++;
      }
    } catch (e: any) {
      console.log(`   ⚠ Booking yaratilmadi (${d.tourName}): ${e.message?.substring(0, 60)}`);
    }
  }

  console.log(`   ✅ ${bookingsCreated} ta booking, ${paymentsCreated} ta to'lov yaratildi`);

  // KPI komissiya foizi
  try {
    await prisma.tenant.update({
      where: { id: demoTenant.id },
      data: { agentCommissionPercent: 8 } as any,  // 8% foydadan
    });
    console.log('   ✅ Agent komissiya foizi: 8% o\'rnatildi');
  } catch (e: any) {
    // agentCommissionPercent field bo'lmasa - o'tkazib yuboramiz
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ✅ TourCRM v6 — Seed yakunlandi!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  🔑 PLATFORM OWNER:');
  console.log(`     ${ownerEmail}  (parol — siz bergan OWNER_PASSWORD)`);
  console.log("  🏢 TENANT ADMIN (faqat DEV, har seed'da yangi tasodifiy parol):");
  console.log(`     admin@demo.uz     /  ${adminPassword}`);
  console.log('  👤 AGENTS (faqat DEV):');
  console.log(`     aziz@demo.uz      /  ${agentPassword}`);
  console.log(`     malika@demo.uz    /  ${agentPassword}`);
  console.log('  ⚠️  Bu parollar FAQAT lokal dev muhitda ishlatiladi. Hech qachon');
  console.log('     production bazasida SEED_DEMO_DATA=true ishlatmang.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  📊 Demo data:');
  console.log('     - 9 klient (pipeline\'ning turli bosqichlarida)');
  console.log('     - 8 tour paket');
  console.log('     - 5 xabar shabloni');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Round-Robin navbatini reset qilamiz
  try {
    await prisma.user.updateMany({
      where: { tenantId: demoTenant.id, role: { in: ['AGENT', 'MANAGER'] } },
      data: { lastAssignedAt: null },
    });
    console.log('  ✅ Round-Robin navbati tozalandi (lastAssignedAt = null)');
  } catch (e: any) {
    console.log('  ⚠️  lastAssignedAt reset muvaffaqiyatsiz (npx prisma db push qiling!):', e?.message);
  }
}

main()
  .catch((e) => {
    console.error('❌ Seed xatolik:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());