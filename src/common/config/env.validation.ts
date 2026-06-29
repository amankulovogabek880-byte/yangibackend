import { Logger } from '@nestjs/common';

const logger = new Logger('EnvValidation');

interface EnvConfig {
  required: string[];
  optional: Record<string, string>; // key: defaultValue description
}

const config: EnvConfig = {
  required: ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY'],
  optional: {
    PORT: '3000',
    NODE_ENV: 'development',
    CORS_ORIGINS: '*',
    JWT_ACCESS_EXPIRES: '15m',
    JWT_REFRESH_EXPIRES: '7d',
    THROTTLE_TTL: '60',
    THROTTLE_LIMIT: '100',
    MIN_PASSWORD_LENGTH: '8',
    MAX_LOGIN_ATTEMPTS: '5',
    LOGIN_LOCK_MINUTES: '15',
    UPLOAD_DIR: './uploads',
    UPLOAD_MAX_SIZE: '10485760',
    LOG_DIR: './logs',
    BACKUP_ENABLED: 'false',
    SENDGRID_API_KEY: '(optional)',
    OWNER_EMAIL: 'owner@omoncrm.uz',
    OWNER_PASSWORD: 'Owner@123456!',
  },
};

export function validateEnv(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const missing: string[] = [];
  const warnings: string[] = [];

  for (const key of config.required) {
    const val = process.env[key];
    if (!val || val.trim() === '') {
      missing.push(key);
    } else if (isProd && (val.includes('change-me') || val.includes('change-this') || val.includes('paste-64'))) {
      missing.push(`${key} (placeholder deyarli o'zgartirilmagan)`);
    }
  }

  if (missing.length > 0) {
    const msg = `\n\n❌ MUHIM: Quyidagi ENV o'zgaruvchilar to'ldirilmagan:\n${missing.map(k => `   - ${k}`).join('\n')}\n\n.env faylini tekshiring!\n`;
    if (isProd) throw new Error(msg);
    else logger.warn(msg);
  }

  // ENCRYPTION_KEY uzunligini tekshirish
  const encKey = process.env.ENCRYPTION_KEY || '';
  if (encKey && encKey.length < 32) {
    const w = `ENCRYPTION_KEY kamida 32 belgi bo'lishi kerak (hozir: ${encKey.length})`;
    if (isProd) throw new Error(w);
    else warnings.push(w);
  }

  // JWT secrets uzunligi
  for (const jwtKey of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    const val = process.env[jwtKey] || '';
    if (val && val.length < 32) {
      warnings.push(`${jwtKey} kamida 32 belgi bo'lishi kerak`);
    }
  }

  for (const w of warnings) logger.warn(`⚠️  ${w}`);

  if (missing.length === 0) {
    logger.log('✅ ENV validatsiya muvaffaqiyatli');
  }
}
