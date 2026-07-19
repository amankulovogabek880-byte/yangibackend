/**
 * CORS uchun ruxsat etilgan manbalar (origins) — YAGONA manba.
 *
 * NEGA ALOHIDA FAYL: ilgari HTTP CORS qat'iy sozlangan edi (production'da
 * CORS_ORIGINS majburiy), lekin Socket.IO gateway'da `origin: '*'` turardi.
 * Ya'ni HTTP eshigi qulflangan, WebSocket eshigi ochiq qolgan edi —
 * hujumchi istalgan saytdan WebSocket ulanishi mumkin edi.
 *
 * Endi ikkalasi ham SHU funksiyadan foydalanadi, demak siyosat bitta.
 */

/** Production'da CORS_ORIGINS majburiy; development'da localhost'ga ruxsat */
export function getAllowedOrigins(): string[] {
  const isProd = process.env.NODE_ENV === 'production';
  const raw = (process.env.CORS_ORIGINS || '').trim();

  if (raw && raw !== '*') {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (isProd) {
    // main.ts bootstrap'da bu holat allaqachon xato tashlaydi.
    // Bu yerda bo'sh ro'yxat qaytaramiz — ya'ni hech kimga ruxsat yo'q
    // (xavfsiz standart holat, "hammaga ruxsat" emas).
    return [];
  }

  return ['http://localhost:3001', 'http://127.0.0.1:3001'];
}

/**
 * Origin ruxsat etilganmi.
 *
 * Origin bo'lmasa (server-server so'rovlari, Postman, mobil ilovalar)
 * ruxsat beramiz — brauzer xavfsizlik siyosati bu holatlarga taalluqli emas.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  return getAllowedOrigins().includes(origin);
}