/**
 * fix-avatar-urls.ts
 *
 * MUAMMO 6: production'da avval API_BASE_URL to'g'ri sozlanmagan bo'lsa,
 * Telegramdan yuklab olingan profil rasmlarining avatarUrl'lari
 * "http://localhost:3000/..." bilan saqlanib qolgan bo'lishi mumkin — bu
 * URL'lar brauzerda hech qachon ochilmaydi (production foydalanuvchisi
 * o'z localhost'iga ega emas).
 *
 * Bu skript bazadagi Conversation.avatarUrl (va bor bo'lsa boshqa
 * fayl-URL maydonlarini) topib, "localhost:3000" qismini haqiqiy
 * API_BASE_URL bilan almashtiradi — FAYLNING O'ZINI QAYTA YUKLAMAYDI,
 * faqat noto'g'ri saqlangan domen qismini tuzatadi (fayl diskda/Supabase'da
 * allaqachon mavjud, faqat manzili noto'g'ri yozilgan edi).
 *
 * ⚠️ AVTOMATIK ISHGA TUSHMAYDI. Qo'lda, .env da API_BASE_URL to'g'ri
 * sozlangandan KEYIN ishga tushiring:
 *
 *   npx ts-node prisma/fix-avatar-urls.ts
 *
 * Xavfsiz — faqat "localhost:3000" ni topib almashtiradi, boshqa hech
 * narsaga tegmaydi. Ishga tushirishdan oldin bazadan backup oling.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const correctBaseUrl = process.env.API_BASE_URL;
  if (!correctBaseUrl || correctBaseUrl.includes('localhost')) {
    console.error(
      '❌ API_BASE_URL .env faylida to\'g\'ri sozlanmagan (yoki localhost bo\'lib turibdi). ' +
      'Avval haqiqiy backend domeningizni API_BASE_URL ga yozing, keyin bu skriptni qayta ishga tushiring.',
    );
    process.exit(1);
  }

  const staleConversations = await prisma.conversation.findMany({
    where: { avatarUrl: { contains: 'localhost:3000' } },
    select: { id: true, avatarUrl: true },
  });

  console.log(`🔍 ${staleConversations.length} ta Conversation'da localhost:3000 bilan saqlangan avatarUrl topildi.`);

  let updated = 0;
  for (const conv of staleConversations) {
    if (!conv.avatarUrl) continue;
    const fixedUrl = conv.avatarUrl.replace(/https?:\/\/localhost:3000/g, correctBaseUrl);
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { avatarUrl: fixedUrl },
    });
    updated++;
  }

  console.log(`✅ ${updated} ta Conversation.avatarUrl "${correctBaseUrl}" bilan yangilandi.`);

  // Hujjatlar (Document.fileUrl) da ham xuddi shu muammo bo'lishi mumkin —
  // shu birgalikda tekshirib, tuzatib ketamiz.
  const staleDocs = await prisma.document.findMany({
    where: { fileUrl: { contains: 'localhost:3000' } },
    select: { id: true, fileUrl: true },
  }).catch(() => [] as any[]);

  let updatedDocs = 0;
  for (const doc of staleDocs) {
    if (!doc.fileUrl) continue;
    const fixedUrl = doc.fileUrl.replace(/https?:\/\/localhost:3000/g, correctBaseUrl);
    await prisma.document.update({
      where: { id: doc.id },
      data: { fileUrl: fixedUrl },
    });
    updatedDocs++;
  }
  console.log(`✅ ${updatedDocs} ta Document.fileUrl "${correctBaseUrl}" bilan yangilandi.`);
}

main()
  .catch((e) => {
    console.error('❌ Xato:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());