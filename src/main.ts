import { NestFactory } from '@nestjs/core';
import { validateEnv } from './common/config/env.validation';
import { winstonLogger } from './common/logger/winston.logger';
import { getAllowedOrigins } from './common/config/cors.config';
import { createStaticRateLimit } from './common/guards/static-rate-limit';
import { createUploadsAccessGuard } from './common/guards/uploads-access';
import { PrismaService } from './prisma/prisma.service';
import { REDIS_CLIENT } from './common/cache/cache.constants';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import helmet from 'helmet';
import  compression from 'compression';
import  cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
async function bootstrap() {
  // ENV tekshirish
  validateEnv();
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
    // rawBody: true → req.rawBody orqali original bayt oqimi saqlanadi.
    // Instagram/Meta webhook imzosini (X-Hub-Signature-256) tekshirish uchun zarur.
    rawBody: true,
  });
  // ─────────────────────────────────────────────────────────────
  // v17 MUHIM TUZATISH: `enableShutdownHooks()` CHAQIRILMAGANDI.
  //
  // Standart holatda NestJS OS signallarini (SIGTERM/SIGINT) UMUMAN
  // tinglamaydi — shuning uchun Render har bir deploy'da eski jarayonga
  // SIGTERM yuborganda, `onModuleDestroy()` (Telegram bot'larni
  // `stopPolling()` qilish, MTProto sessiyalarini yopish) HECH QACHON
  // ishga tushmasdi. Natijada eski jarayon Telegram bilan getUpdates
  // ulanishini OCHIQ qoldirib "yiqilardi", yangi jarayon esa xuddi shu
  // bot tokeni bilan darhol pollingni boshlar edi — ikkalasi bir necha
  // o'nlab soniya bir vaqtda ishlab, Telegram tarafidan "409 Conflict"
  // qaytarardi (loglarda ko'rilgan uzluksiz konflikt/qayta-urinish
  // tsiklining asosiy sababi aynan shu edi, RAM va CPU sarfini oshirardi).
  //
  // Endi: `enableShutdownHooks()` yoqilgan — SIGTERM kelganda Nest avval
  // barcha modullarning `onModuleDestroy()`sini kutib bo'ladi (bot'lar
  // to'xtaydi, MTProto uzuladi), SHUNDAN KEYIN jarayon chiqadi. Bu deploy
  // paytidagi eski/yangi jarayon bir-biriga zid kelishini deyarli
  // yo'qqa chiqaradi.
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);

  // ─────────────────────────────────────────────────────────────
  // v19 MUHIM TUZATISH: Express standart holatda HAR BIR JSON javobga
  // avtomatik "ETag" qo'shadi. Brauzer keyingi so'rovda shu ETag'ni
  // qaytarsa, server "304 Not Modified" deb javob beradi va JAVOB
  // TANASINI (body) UMUMAN QAYTARMAYDI — brauzer o'zining eski
  // keshidan foydalanishi kerak bo'ladi. Render kabi proksi-server
  // ortida bu mexanizm ba'zan noto'g'ri ishlab, brauzer ESKI
  // (masalan hali yozuv-recordingUrl qo'shilmagan) ma'lumotni
  // ko'rsatishda "qotib qolishi"ga sabab bo'ladi — bu CRM kabi doim
  // o'zgarib turadigan ma'lumot uchun MUTLAQO KERAKSIZ va xavfli.
  // Yechim: ETag'ni butunlay o'chiramiz VA barcha API javoblariga
  // aniq "keshlama" ko'rsatmasini qo'shamiz — shunda brauzer/proksi
  // hech qachon eski javobni qaytarib bermaydi, har doim yangi
  // so'rov ketadi.
  // ─────────────────────────────────────────────────────────────
  app.getHttpAdapter().getInstance().set('etag', false);
  app.use((req: any, res: any, next: any) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // ─── Startup security checks ─────────────────────────────
  if (process.env.NODE_ENV === 'production') {
    const requiredEnv = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL'];
    const missing = requiredEnv.filter(k => !process.env[k] || process.env[k] === 'change-me');
    if (missing.length > 0) {
      throw new Error('Missing required env vars: ' + missing.join(', '));
    }
  }
  // ─── Security ─────────────────────────────────────────────
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: process.env.NODE_ENV === 'production',
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    }),
  );
  app.use(compression());
  app.use(cookieParser());
  // ─── CORS ────────────────────────────────────────────────
  // XAVFSIZLIK: `*` + credentials kombinatsiyasi taqiqlanadi.
  // Production'da CORS_ORIGINS env MAJBURIY (vergul bilan ajratilgan ro'yxat).
  // Development'da faqat localhost'larga ruxsat.
  const isProd = process.env.NODE_ENV === 'production';
  const rawOrigins = (process.env.CORS_ORIGINS || '').trim();
  if (isProd && (!rawOrigins || rawOrigins === '*')) {
    throw new Error(
      "CORS_ORIGINS env production'da majburiy va '*' bo'lishi mumkin emas. " +
      'Masalan: CORS_ORIGINS=https://crm.example.uz,https://app.example.uz',
    );
  }
  // Yagona manba — WebSocket gateway ham SHU ro'yxatdan foydalanadi
  // (cors.config.ts). Ikki joyda alohida yozilsa, biri unutilib qoladi.
  const allowedOrigins = getAllowedOrigins();
  app.enableCors({
    origin: (origin: string | undefined, cb: any) => {
      // Origin'siz so'rovlar (curl, server-to-server, mobil app) — ruxsat,
      // lekin cookie'lar bunda baribir yuborilmaydi.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-refresh-token', 'Cache-Control', 'Pragma'],
  });
  // ─── WebSocket adapter ────────────────────────────────────
  app.useWebSocketAdapter(new IoAdapter(app));
  // ─── Validation pipe ──────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
      stopAtFirstError: false,
    }),
  );
  // ─── Global filters + interceptors ────────────────────────
  app.useGlobalFilters(new AllExceptionsFilter());
  const prisma = app.get(PrismaService);
  app.useGlobalInterceptors(new AuditInterceptor(prisma));
  // ─── API prefix ───────────────────────────────────────────
  app.setGlobalPrefix('api/v1', {
    exclude: ['health'],
  });
  // ─── Static files ─────────────────────────────────────────
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const uploadDir = config.get('UPLOAD_DIR', './uploads');
  // XAVFSIZLIK TUZATISH: oldin har qanday "Bearer xxx" yoki 10+ belgili
  // ?token= qabul qilinardi (soxta token bilan hamma fayl ochiq edi).
  // Endi JWT haqiqiy tekshiriladi.
  //
  // MUAMMO FIX (profil rasmlar ko'rinmasligi): avatarUrl "?v=timestamp" bilan
  // saqlanadi, "?token=" bilan EMAS — chunki bitta avatar barcha agentlar
  // uchun umumiy, bitta agentning shaxsiy tokenini unga qotirib qo'yib
  // bo'lmaydi. Natijada brauzer <img> tegi (Authorization header yubora
  // olmaydi) har doim 401 olardi va rasmlar hech qachon chiqmasdi.
  // Yechim: faqat "tg_avatar_" bilan boshlanuvchi fayllarni (profil rasmlari —
  // sezgir hujjat emas) tokensiz ochiq qilamiz; boshqa barcha fayllar
  // (pasport, viza va h.k.) avvalgidek JWT bilan himoyalangan qoladi.
  // v12.8: fayl yuklab olishga rate limit.
  // Bu Express middleware bo'lgani uchun Nest'ning ThrottlerGuard'i
  // bu yerda ishlamaydi — shuning uchun alohida cheklovchi.
  // Redis bo'lsa barcha instanslar uchun umumiy, bo'lmasa xotirada.
  let staticRedis: any = null;
  try {
    staticRedis = app.get(REDIS_CLIENT, { strict: false });
  } catch {
    /* Redis sozlanmagan — xotira rejimida ishlaydi */
  }
  app.use('/uploads', createStaticRateLimit({ redis: staticRedis }));
  // v12.9 XAVFSIZLIK: ilgari bu yerda faqat JWT HAQIQIYLIGI tekshirilardi.
  // Ya'ni istalgan login qilgan foydalanuvchi, BOSHQA agentlikning fayl
  // nomini bilsa, uni ocha olardi (pasport, viza, shartnoma).
  //
  // Endi fayl egasi bazadan aniqlanadi va so'rovchi tenant'i bilan
  // solishtiriladi. Manzil o'zgarmadi — mavjud havolalar ishlashda
  // davom etadi (batafsil izoh: common/guards/uploads-access.ts).
  app.use(
    '/uploads',
    createUploadsAccessGuard({ prisma, jwt }),
    express.static(uploadDir),
  );
  // ─── Swagger API Documentation ──────────────────────────
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Omon CRM API')
    .setDescription(`
## Omon TourCRM REST API
Barcha endpointlar JWT autentifikatsiyasini talab qiladi.
### Autentifikatsiya
\`\`\`
POST /api/v1/auth/login
{ email, password } → { accessToken, refreshToken }
\`\`\`
Header'ga qo'shing:
\`Authorization: Bearer <accessToken>\`
### IP Telefoniya (OnlinePBX)
Qo'ng'iroq boshlash: \`POST /api/v1/calls/initiate\`
Webhook: \`POST /api/v1/calls/webhook\`
### Telegram Personal Account (MTProto)
1. \`POST /api/v1/user-telegram/auth/send-code\` - Kod yuborish
2. \`POST /api/v1/user-telegram/auth/verify-code\` - Kodni tasdiqlash
3. \`POST /api/v1/user-telegram/send\` - Birinchi xabar yuborish
    `)
    .setVersion('6.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'JWT')
    .addServer(`http://localhost:${port}`, 'Local')
    .build();
  // ── XAVFSIZLIK (v12.5): Swagger production'da YOPIQ ──
  //
  // Ilgari /api/docs har doim ochiq edi — ya'ni istalgan odam butun API
  // strukturasini, barcha endpointlar va DTO'larni ko'ra olardi. Bu
  // hujumchiga tayyor xarita berish demakdir.
  //
  // Endi: development'da har doim ochiq, production'da faqat
  // SWAGGER_ENABLED=true bo'lsa. Standart holat — yopiq.
  const swaggerEnabled = isProd
    ? process.env.SWAGGER_ENABLED === 'true'
    : true;
  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
      customSiteTitle: 'Omon CRM API Docs',
    });
    if (isProd) {
      winstonLogger.warn(
        "DIQQAT: Swagger production'da OCHIQ (SWAGGER_ENABLED=true). Kerak bo'lmasa o'chiring.",
      );
    }
  } else {
    winstonLogger.info("Swagger production'da o'chirilgan (SWAGGER_ENABLED=true bilan yoqiladi)");
  }
  // v11 FIX: Eski TelegramPersonalService orqali sessiya tiklash olib
  // tashlandi. UserTelegramService o'zining onModuleInit()'ida BARCHA
  // shaxsiy Telegram sessiyalarini allaqachon avtomatik tiklaydi — bu yerda
  // ikkinchi marta tiklash faqat bitta akkauntga 2 ta parallel MTProto
  // ulanish ochib, xabarlarni ikki marta/nomuvofiq qayta ishlashga sabab
  // bo'lardi (dublikat suhbatlar, "Bot" bo'lib ko'rinish, va h.k.).
  await app.listen(port);
  Logger.log(`🚀 Omon CRM API: http://localhost:${port}/api/v1`, 'Bootstrap');
  // Swagger manzilini FAQAT u haqiqatan yoqilgan bo'lsa chop etamiz —
  // aks holda log yolg'on ma'lumot berardi.
  if (swaggerEnabled) {
    Logger.log(`📚 Swagger Docs: http://localhost:${port}/api/docs`, 'Bootstrap');
  }
  Logger.log(`📡 WebSocket: ws://localhost:${port}`, 'Bootstrap');
  Logger.log(`🌡 Health: http://localhost:${port}/health`, 'Bootstrap');
}
bootstrap();