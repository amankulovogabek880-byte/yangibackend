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

import { TelegramPersonalService } from './modules/telegram-personal/telegram-personal.module';
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
  const corsOrigins = process.env.CORS_ORIGINS || '*';
  app.enableCors({
    origin: corsOrigins === '*'
      ? true
      : (origin: string | undefined, cb: any) => {
          const allowed = corsOrigins.split(',').map((s) => s.trim());
          if (!origin || allowed.includes(origin)) return cb(null, true);
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
  // Serve uploads with basic token check (prevent direct access without auth)
  const uploadDir = config.get('UPLOAD_DIR', './uploads');
  app.use('/uploads', (req: any, res: any, next: any) => {
    // Authorization header yoki ?token=... query param orqali ruxsat
    const authHeader = req.headers.authorization;
    const tokenQuery = req.query?.token;
    if (
      (authHeader && authHeader.startsWith('Bearer ')) ||
      (tokenQuery && typeof tokenQuery === 'string' && tokenQuery.length > 10)
    ) {
      return next();
    }
    return res.status(401).json({ message: 'Unauthorized' });
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

  // Restore Telegram personal sessions
  try {
    const tgPersonal = app.get(TelegramPersonalService, { strict: false });
    if (tgPersonal) await tgPersonal.restoreAllSessions();
  } catch {}

  await app.listen(port);

  Logger.log(`🚀 Omon CRM API: http://localhost:${port}/api/v1`, 'Bootstrap');
  Logger.log(`📚 Swagger Docs: http://localhost:${port}/api/docs`, 'Bootstrap');
  Logger.log(`📡 WebSocket: ws://localhost:${port}`, 'Bootstrap');
  Logger.log(`🌡 Health: http://localhost:${port}/health`, 'Bootstrap');
}

bootstrap();
