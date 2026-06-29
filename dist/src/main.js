"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const env_validation_1 = require("./common/config/env.validation");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const platform_socket_io_1 = require("@nestjs/platform-socket.io");
const helmet_1 = __importDefault(require("helmet"));
const compression_1 = __importDefault(require("compression"));
const cookie_parser_1 = __importDefault(require("cookie-parser"));
const app_module_1 = require("./app.module");
const swagger_1 = require("@nestjs/swagger");
const all_exceptions_filter_1 = require("./common/filters/all-exceptions.filter");
const audit_interceptor_1 = require("./common/interceptors/audit.interceptor");
const prisma_service_1 = require("./prisma/prisma.service");
const telegram_personal_module_1 = require("./modules/telegram-personal/telegram-personal.module");
async function bootstrap() {
    (0, env_validation_1.validateEnv)();
    const app = await core_1.NestFactory.create(app_module_1.AppModule, {
        logger: process.env.NODE_ENV === 'production'
            ? ['error', 'warn', 'log']
            : ['error', 'warn', 'log', 'debug', 'verbose'],
    });
    const config = app.get(config_1.ConfigService);
    const port = config.get('PORT', 3000);
    if (process.env.NODE_ENV === 'production') {
        const requiredEnv = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL'];
        const missing = requiredEnv.filter(k => !process.env[k] || process.env[k] === 'change-me');
        if (missing.length > 0) {
            throw new Error('Missing required env vars: ' + missing.join(', '));
        }
    }
    app.use((0, helmet_1.default)({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        contentSecurityPolicy: process.env.NODE_ENV === 'production',
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    }));
    app.use((0, compression_1.default)());
    app.use((0, cookie_parser_1.default)());
    const corsOrigins = process.env.CORS_ORIGINS || '*';
    app.enableCors({
        origin: corsOrigins === '*'
            ? true
            : (origin, cb) => {
                const allowed = corsOrigins.split(',').map((s) => s.trim());
                if (!origin || allowed.includes(origin))
                    return cb(null, true);
                cb(null, false);
            },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-refresh-token'],
    });
    app.useWebSocketAdapter(new platform_socket_io_1.IoAdapter(app));
    app.useGlobalPipes(new common_1.ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
        stopAtFirstError: false,
    }));
    app.useGlobalFilters(new all_exceptions_filter_1.AllExceptionsFilter());
    const prisma = app.get(prisma_service_1.PrismaService);
    app.useGlobalInterceptors(new audit_interceptor_1.AuditInterceptor(prisma));
    app.setGlobalPrefix('api/v1', {
        exclude: ['health'],
    });
    const express = require('express');
    const uploadDir = config.get('UPLOAD_DIR', './uploads');
    app.use('/uploads', (req, res, next) => {
        const authHeader = req.headers.authorization;
        const tokenQuery = req.query?.token;
        if ((authHeader && authHeader.startsWith('Bearer ')) ||
            (tokenQuery && typeof tokenQuery === 'string' && tokenQuery.length > 10)) {
            return next();
        }
        return res.status(401).json({ message: 'Unauthorized' });
    }, express.static(uploadDir));
    const swaggerConfig = new swagger_1.DocumentBuilder()
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
    const document = swagger_1.SwaggerModule.createDocument(app, swaggerConfig);
    swagger_1.SwaggerModule.setup('api/docs', app, document, {
        swaggerOptions: { persistAuthorization: true },
        customSiteTitle: 'Omon CRM API Docs',
    });
    try {
        const tgPersonal = app.get(telegram_personal_module_1.TelegramPersonalService, { strict: false });
        if (tgPersonal)
            await tgPersonal.restoreAllSessions();
    }
    catch { }
    await app.listen(port);
    common_1.Logger.log(`🚀 Omon CRM API: http://localhost:${port}/api/v1`, 'Bootstrap');
    common_1.Logger.log(`📚 Swagger Docs: http://localhost:${port}/api/docs`, 'Bootstrap');
    common_1.Logger.log(`📡 WebSocket: ws://localhost:${port}`, 'Bootstrap');
    common_1.Logger.log(`🌡 Health: http://localhost:${port}/health`, 'Bootstrap');
}
bootstrap();
//# sourceMappingURL=main.js.map