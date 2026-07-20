import { Logger } from '@nestjs/common';

/**
 * ═══════════════════════════════════════════════════════════════
 * /uploads — TENANT TEKSHIRUVI (v12.9)
 * ═══════════════════════════════════════════════════════════════
 *
 * MUAMMO:
 *   Ilgari statik-fayl middleware faqat JWT HAQIQIYLIGINI tekshirardi.
 *   Ya'ni A agentligining xodimi, B agentligining fayl nomini bilsa,
 *   uni bemalol ocha olardi — pasport, viza, shartnoma nusxalari.
 *   Fayl nomlari tasodifiy bo'lgani bilan, bu "yashirinlik orqali
 *   xavfsizlik" — haqiqiy himoya emas (nom log'larga, havolalarga,
 *   brauzer tarixiga tushib qolishi mumkin).
 *
 * YECHIM:
 *   Fayl kimga tegishli ekanini BAZADAN tekshiramiz va so'rovchining
 *   tenant'i bilan solishtiramiz.
 *
 * NEGA URL'LAR O'ZGARTIRILMADI:
 *   `/uploads/:fileId` ko'rinishiga o'tish barcha saqlangan
 *   `fileUrl` qiymatlarini (Document va Message jadvallarida) va
 *   frontenddagi havolalarni buzardi — mavjud fayllar ochilmay
 *   qolardi. Shu sababli manzil o'sha-o'sha qoldi, faqat tekshiruv
 *   qo'shildi. Xavfsizlik natijasi bir xil.
 *
 * FAYL TURLARI:
 *   1. `tg_avatar_*`        → ochiq (profil rasmlari, sezgir emas)
 *   2. `{uuid}.ext`         → Document.tenantId
 *   3. `{vaqt}-{tasodif}-*` → Message → Conversation.tenantId
 *   4. Hech qayerda yo'q    → rad etiladi
 */

const logger = new Logger('UploadsAccess');

/** Nechta so'rovda bir xil fayl qayta-qayta so'ralishi mumkin — keshlaymiz */
const cache = new Map<string, { tenantId: string | null; at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (now - v.at > CACHE_TTL_MS) cache.delete(k);
  }
}, CACHE_TTL_MS);

/**
 * Fayl qaysi tenant'ga tegishli ekanini aniqlaydi.
 * @returns tenantId | null (topilmadi)
 */
async function resolveFileTenant(prisma: any, fileName: string): Promise<string | null> {
  const cached = cache.get(fileName);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tenantId;

  let tenantId: string | null = null;

  try {
    // 1) Hujjat sifatida qidiramiz
    const doc = await prisma.document.findFirst({
      where: {
        OR: [
          { fileName },
          { fileUrl: { endsWith: `/uploads/${fileName}` } },
        ],
      },
      select: { tenantId: true },
    });

    if (doc) {
      tenantId = doc.tenantId;
    } else {
      // 2) Chat media sifatida qidiramiz (Message → Conversation)
      const msg = await prisma.message.findFirst({
        where: {
          OR: [
            { fileUrl: { endsWith: `/uploads/${fileName}` } },
            { thumbnailUrl: { endsWith: `/uploads/${fileName}` } },
          ],
        },
        select: { conversation: { select: { tenantId: true } } },
      });
      tenantId = msg?.conversation?.tenantId ?? null;
    }
  } catch (e: any) {
    logger.error(`Fayl egasini aniqlashda xato (${fileName}): ${e?.message}`);
    return null;
  }

  cache.set(fileName, { tenantId, at: Date.now() });
  return tenantId;
}

export interface UploadsAccessOptions {
  prisma: any;
  jwt: any;
  /**
   * true bo'lsa — bazada topilmagan fayl RAD ETILADI (qat'iy).
   * false bo'lsa — faqat log yoziladi va ruxsat beriladi.
   *
   * Birinchi deploy'da `false` bilan chiqing: log'da qanday fayllar
   * "egasiz" ekanini ko'rasiz. Log toza bo'lgach `true` ga o'ting.
   * UPLOADS_STRICT env orqali boshqariladi.
   */
  strict?: boolean;
}

export function createUploadsAccessGuard(opts: UploadsAccessOptions) {
  const { prisma, jwt } = opts;
  const strict = opts.strict ?? process.env.UPLOADS_STRICT === 'true';

  logger.log(
    `/uploads tenant tekshiruvi yoqildi — rejim: ${strict ? 'QATIY (rad etadi)' : 'YUMSHOQ (faqat log)'}`,
  );

  return async function uploadsAccess(req: any, res: any, next: () => void) {
    const fileName = decodeURIComponent((req.path || '').replace(/^\/+/, ''));

    // Yo'l bo'ylab yuqoriga chiqishga urinish (../) — darhol rad
    if (!fileName || fileName.includes('..') || fileName.includes('/')) {
      if (fileName.includes('..')) {
        logger.warn(`Yo'l manipulyatsiyasiga urinish: ${fileName}`);
        return res.status(400).json({ message: "Noto'g'ri fayl nomi" });
      }
    }

    // ── 1) Avatarlar ochiq (avvalgidek) ──
    if (fileName.startsWith('tg_avatar_')) return next();

    // ── 2) JWT tekshiruvi ──
    const authHeader = req.headers?.authorization as string | undefined;
    const tokenQuery = typeof req.query?.token === 'string' ? req.query.token : undefined;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : tokenQuery;

    if (!token) return res.status(401).json({ message: 'Unauthorized' });

    let payload: any;
    try {
      payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    } catch {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Platforma egasi barcha fayllarni ko'radi (qo'llab-quvvatlash uchun)
    if (payload?.role === 'PLATFORM_OWNER') return next();

    const userTenant = payload?.tenantId;
    if (!userTenant) {
      logger.warn("Token'da tenantId yo'q — fayl rad etildi");
      return res.status(403).json({ message: 'Ruxsat yo\'q' });
    }

    // ── 3) Fayl egasini aniqlaymiz ──
    const fileTenant = await resolveFileTenant(prisma, fileName);

    if (fileTenant === null) {
      // Bazada topilmadi
      if (strict) {
        logger.warn(`Egasi aniqlanmagan fayl rad etildi: ${fileName}`);
        return res.status(404).json({ message: 'Fayl topilmadi' });
      }
      logger.warn(
        `Egasi aniqlanmagan fayl (yumshoq rejim, ruxsat berildi): ${fileName}. ` +
        `UPLOADS_STRICT=true qilishdan oldin bu turdagi log yo'qolishini kuting.`,
      );
      return next();
    }

    // ── 4) Tenant solishtiruvi ──
    if (fileTenant !== userTenant) {
      logger.error(
        `TENANT SIZISHI TO'XTATILDI: "${userTenant}" tenant'i "${fileTenant}" ` +
        `tenant'ining faylini so'radi (${fileName})`,
      );
      return res.status(403).json({ message: 'Bu faylga ruxsatingiz yo\'q' });
    }

    return next();
  };
}