import { NestFactory } from '@nestjs/core';
import { validateEnv } from './common/config/env.validation';
import { winstonLogger } from './common/logger/winston.logger';
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
import { PrismaService } from './prisma/prisma.service';

async function bootstrap() {
  // ENV tekshirish
  validateEnv();

  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production'
      ? ['error', 'warn', 'log']
      : ['error', 'warn', 'log', 'debug', 'verbose'],
  });
  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);

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

  const allowedOrigins = rawOrigins && rawOrigins !== '*'
    ? rawOrigins.split(',').map((s) => s.trim()).filter(Boolean)
    : ['http://localhost:3001', 'http://127.0.0.1:3001']; // dev fallback

  app.enableCors({
    origin: (origin: string | undefined, cb: any) => {
      // Origin'siz so'rovlar (curl, server-to-server, mobil app) — ruxsat,
      // lekin cookie'lar bunda baribir yuborilmaydi.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-refresh-token'],
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
  app.use('/uploads', (req: any, res: any, next: any) => {
    const fileName = (req.path || '').replace(/^\/+/, '');
    if (fileName.startsWith('tg_avatar_')) return next();

    const authHeader = req.headers.authorization as string | undefined;
    const tokenQuery = typeof req.query?.token === 'string' ? req.query.token : undefined;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : tokenQuery;

    if (!token) return res.status(401).json({ message: 'Unauthorized' });
    try {
      jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      return next();
    } catch {
      return res.status(401).json({ message: 'Unauthorized' });
    }
  }, express.static(uploadDir));

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

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
    customSiteTitle: 'Omon CRM API Docs',
  });

  // v11 FIX: Eski TelegramPersonalService orqali sessiya tiklash olib
  // tashlandi. UserTelegramService o'zining onModuleInit()'ida BARCHA
  // shaxsiy Telegram sessiyalarini allaqachon avtomatik tiklaydi — bu yerda
  // ikkinchi marta tiklash faqat bitta akkauntga 2 ta parallel MTProto
  // ulanish ochib, xabarlarni ikki marta/nomuvofiq qayta ishlashga sabab
  // bo'lardi (dublikat suhbatlar, "Bot" bo'lib ko'rinish, va h.k.).

  await app.listen(port);

  Logger.log(`🚀 Omon CRM API: http://localhost:${port}/api/v1`, 'Bootstrap');
  Logger.log(`📚 Swagger Docs: http://localhost:${port}/api/docs`, 'Bootstrap');
  Logger.log(`📡 WebSocket: ws://localhost:${port}`, 'Bootstrap');
  Logger.log(`🌡 Health: http://localhost:${port}/health`, 'Bootstrap');
}

bootstrap();