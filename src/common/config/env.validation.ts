import { Logger } from '@nestjs/common';

const logger = new Logger('EnvValidation');

interface EnvConfig {
  required: string[];
  optional: Record<string, string>;
}

const config: EnvConfig = {
  required: ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY'],
  optional: {
    PORT: '3000',
    NODE_ENV: 'development',
    CORS_ORIGINS: '(production-da MAJBURIY, masalan: https://crm.example.uz)',
    COOKIE_DOMAIN: '(ixtiyoriy, masalan: .omoncrm.uz)',
    COOKIE_SAMESITE: 'lax',
    JWT_ACCESS_EXPIRES: '15m',
    JWT_REFRESH_EXPIRES: '7d',
    THROTTLE_TTL: '60',
    THROTTLE_LIMIT: '100',
    REDIS_URL: '(ixtiyoriy, masalan: redis://localhost:6379)',
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
    // ── Meta (Facebook + Instagram) ──
    FACEBOOK_APP_ID: '(Facebook Lead Ads uchun)',
    FACEBOOK_APP_SECRET: '(Facebook Lead Ads uchun — MAJBURIY)',
    FACEBOOK_VERIFY_TOKEN: 'omoncrm_fb_verify',
    FACEBOOK_OAUTH_REDIRECT_URI: '(https://api.domen.uz/api/v1/facebook-leads/oauth/callback)',
    INSTAGRAM_APP_SECRET: '(Instagram DM uchun)',
    META_SINGLE_APP: 'false',
    // ── Instagram orqali TO'G'RIDAN-TO'G'RI ulanish (Facebook Page shart emas) ──
    // Meta App Dashboard → App → Instagram → "API setup with Instagram login"
    // bo'limida ko'rsatilgan qiymatlar. Agar bo'sh qoldirilsa, tizim
    // INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET'ga qaytadi (bir xil Meta App
    // ichida ular ko'pincha bir xil bo'ladi).
    INSTAGRAM_LOGIN_APP_ID: "(Instagram to'g'ridan-to'g'ri ulanish uchun)",
    INSTAGRAM_LOGIN_APP_SECRET: "(bo'sh bo'lsa INSTAGRAM_APP_SECRET ishlatiladi)",
    INSTAGRAM_LOGIN_REDIRECT_URI:
      '(https://api.domen.uz/api/v1/instagram/oauth/callback)',
    LEAD_SLA_MINUTES: '15',
  },
};

export function validateEnv(): void {
  const isProd = process.env.NODE_ENV === 'production';
  const missing: string[] = [];
  const warnings: string[] = [];
  const critical: string[] = [];

  for (const key of config.required) {
    const val = process.env[key];
    if (!val || val.trim() === '') {
      missing.push(key);
    } else if (
      isProd &&
      (val.includes('change-me') || val.includes('change-this') || val.includes('paste-64'))
    ) {
      missing.push(`${key} (placeholder deyarli o'zgartirilmagan)`);
    }
  }

  if (missing.length > 0) {
    const msg = `\n\n❌ MUHIM: Quyidagi ENV o'zgaruvchilar to'ldirilmagan:\n${missing
      .map((k) => `   - ${k}`)
      .join('\n')}\n\n.env faylini tekshiring!\n`;
    if (isProd) throw new Error(msg);
    else logger.warn(msg);
  }

  const encKey = process.env.ENCRYPTION_KEY || '';
  if (encKey && encKey.length < 32) {
    const w = `ENCRYPTION_KEY kamida 32 belgi bo'lishi kerak (hozir: ${encKey.length})`;
    if (isProd) throw new Error(w);
    else warnings.push(w);
  }

  for (const jwtKey of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    const val = process.env[jwtKey] || '';
    if (val && val.length < 32) {
      warnings.push(`${jwtKey} kamida 32 belgi bo'lishi kerak`);
    }
  }

  const cors = (process.env.CORS_ORIGINS || '').trim();
  if (isProd && (!cors || cors === '*')) {
    throw new Error(
      "CORS_ORIGINS production'da majburiy va '*' bo'lishi mumkin emas. " +
        'Masalan: CORS_ORIGINS=https://crm.example.uz',
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // META WEBHOOK SIRLARI — QAYTA YOZILDI (v14)
  // ═══════════════════════════════════════════════════════════════
  //
  // ILGARI QANDAY EDI (va nima uchun xato edi):
  //
  //   if (!fbToken && !igToken) { warnings.push("FACEBOOK_APP_SECRET yo'q") }
  //
  //   Ya'ni INSTAGRAM_APP_SECRET bor, FACEBOOK_APP_SECRET yo'q bo'lsa —
  //   HECH QANDAY ogohlantirish chiqmasdi. Bu esa aynan ENG XAVFLI holat:
  //   webhook imzosi fail-closed ishlaydi, demak har bir Facebook lead
  //   403 bilan rad etiladi va tizim "hammasi joyida" ko'rinadi.
  //
  //   Ikkita alohida Meta App ishlatilganda esa Instagram siri bilan
  //   hisoblangan imzo hech qachon mos kelmaydi — natija bir xil.
  //
  // ENDI:
  //   - Ikkalasi ham alohida tekshiriladi
  //   - Fallback faqat META_SINGLE_APP=true bo'lganda ruxsat etiladi
  //   - Production'da yetishmasa — ILOVA ISHGA TUSHMAYDI. Ataylab shunday:
  //     jimgina ishlamaydigan integratsiyadan ko'ra, aniq xato bilan
  //     to'xtagan server ancha yaxshi.
  // ═══════════════════════════════════════════════════════════════

  const igSecret = process.env.INSTAGRAM_APP_SECRET;
  const fbSecret = process.env.FACEBOOK_APP_SECRET;
  const singleApp = process.env.META_SINGLE_APP === 'true';

  // Facebook integratsiyasi umuman yoqilganmi? (App ID bor = yoqilgan)
  const facebookEnabled = !!process.env.FACEBOOK_APP_ID;

  if (facebookEnabled) {
    if (!fbSecret && !(singleApp && igSecret)) {
      critical.push(
        "FACEBOOK_APP_SECRET sozlanmagan — Facebook lead webhook'lari 403 bilan RAD ETILADI. " +
          "Leadlar CRM'ga UMUMAN TUSHMAYDI. " +
          "(Agar Facebook va Instagram BITTA Meta App'da bo'lsa, META_SINGLE_APP=true qo'ying.)",
      );
    }
    if (!process.env.FACEBOOK_OAUTH_REDIRECT_URI) {
      warnings.push(
        "FACEBOOK_OAUTH_REDIRECT_URI sozlanmagan — 'Facebook orqali ulash' tugmasi ishlamaydi.",
      );
    }
    if (!process.env.FACEBOOK_VERIFY_TOKEN) {
      warnings.push(
        "FACEBOOK_VERIFY_TOKEN sozlanmagan — standart 'omoncrm_fb_verify' ishlatiladi. " +
          "Meta Dashboard'dagi Verify Token AYNAN shu qiymat bo'lishi shart.",
      );
    }
  }

  if (!igSecret && !(singleApp && fbSecret)) {
    warnings.push(
      "INSTAGRAM_APP_SECRET sozlanmagan — Instagram webhook'lari RAD ETILADI. DM'lar CRM'ga tushmaydi.",
    );
  }

  // Instagram orqali TO'G'RIDAN-TO'G'RI ulanish ("Instagram Login for
  // Business") — Facebook Page talab qilmaydigan alohida oqim. App ID
  // bo'lsa demak admin shu tugmani ko'radi, shuning uchun redirect URI
  // ham sozlanganini tekshiramiz.
  const igLoginAppId = process.env.INSTAGRAM_LOGIN_APP_ID || process.env.INSTAGRAM_APP_ID;
  if (igLoginAppId && !process.env.INSTAGRAM_LOGIN_REDIRECT_URI) {
    warnings.push(
      "INSTAGRAM_LOGIN_REDIRECT_URI sozlanmagan — 'Instagram orqali ulash' " +
        "(to'g'ridan-to'g'ri) tugmasi ishlamaydi.",
    );
  }

  // Frontend manzili — OAuth callback shu yerga qaytadi
  if (facebookEnabled && !process.env.FRONTEND_URL) {
    warnings.push(
      "FRONTEND_URL sozlanmagan — Facebook OAuth'dan keyin foydalanuvchi localhost'ga qaytariladi.",
    );
  }

  for (const w of warnings) logger.warn(`⚠️  ${w}`);

  if (critical.length > 0) {
    const msg =
      `\n\n🔴 JIDDIY SOZLAMA XATOSI:\n${critical.map((c) => `   - ${c}`).join('\n')}\n`;
    if (isProd) throw new Error(msg);
    else logger.error(msg);
  }

  if (missing.length === 0 && critical.length === 0) {
    logger.log('✅ ENV validatsiya muvaffaqiyatli');
  }
}