import * as crypto from 'crypto';

/**
 * ═══════════════════════════════════════════════════════════════
 * META WEBHOOK IMZOSINI TEKSHIRISH (v13.0)
 * ═══════════════════════════════════════════════════════════════
 *
 * MUAMMO (tuzatishdan oldin):
 *   Instagram va Facebook modullarida imzo tekshiruvi shunday edi:
 *
 *     if (signature && appSecret && rawBody) { ...tekshir... }
 *     // ↓ kod DAVOM ETADI
 *
 *   Ya'ni hujumchi `X-Hub-Signature-256` sarlavhasini UMUMAN
 *   YUBORMASA, butun tekshiruv o'tkazib yuborilardi. Bundan tashqari
 *   `catch` bloki xatoni yutib, kodni davom ettirardi.
 *
 *   Natijada istalgan odam soxta webhook yuborib:
 *     - soxta suhbat va lead yaratishi
 *     - agentga bildirishnoma jo'natishi
 *     - tizimni O'Z Meta tokeningiz bilan javob xabar yuborishga
 *       majburlashi (spam → Page bloklanadi)
 *     mumkin edi.
 *
 * YECHIM:
 *   FAIL-CLOSED. Imzo yo'q, kalit yo'q yoki mos kelmasa — RAD ETILADI.
 *   Hech qanday "davom etish" yo'li qoldirilmagan.
 *
 * TAQQOSLASH:
 *   `timingSafeEqual` ishlatiladi — oddiy `===` bilan solishtirish
 *   javob vaqti orqali imzoni bit-bit taxmin qilish imkonini beradi
 *   (timing attack).
 */
export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  appSecret: string | undefined,
): { ok: boolean; reason?: string } {
  if (!appSecret) return { ok: false, reason: 'APP_SECRET sozlanmagan' };
  if (!rawBody || !rawBody.length) return { ok: false, reason: "rawBody yo'q" };
  if (!signature) return { ok: false, reason: "imzo sarlavhasi yo'q" };

  let expected: string;
  try {
    expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  } catch (e: any) {
    return { ok: false, reason: `imzo hisoblanmadi: ${e?.message}` };
  }

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  // Uzunlik farqi bo'lsa timingSafeEqual xato tashlaydi — oldindan tekshiramiz
  if (a.length !== b.length) return { ok: false, reason: 'imzo uzunligi mos emas' };

  try {
    return crypto.timingSafeEqual(a, b)
      ? { ok: true }
      : { ok: false, reason: "imzo noto'g'ri" };
  } catch (e: any) {
    return { ok: false, reason: `taqqoslash xatosi: ${e?.message}` };
  }
}

/**
 * Development'da qulaylik uchun YAGONA chekinish yo'li.
 *
 * Production'da HECH QACHON ishlamaydi — bu qattiq shart, env bilan
 * chetlab o'tib bo'lmaydi. Ataylab shunday: aks holda kimdir
 * production'ga `META_WEBHOOK_SKIP_SIGNATURE=true` qo'yib qo'yishi
 * va teshikni qaytarib ochishi mumkin edi.
 */
export function canSkipSignature(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.META_WEBHOOK_SKIP_SIGNATURE === 'true'
  );
}