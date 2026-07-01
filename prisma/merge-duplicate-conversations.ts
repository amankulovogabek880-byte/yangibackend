/**
 * merge-duplicate-conversations.ts
 *
 * MUAMMO 1: normalizeChatId() qo'shilishidan OLDIN yaratilgan bazada, bitta
 * real Telegram foydalanuvchisi/guruhi uchun bot va shaxsiy akkaunt orqali
 * IKKITA alohida Conversation yozuvi yaratilgan bo'lishi mumkin (chunki
 * ikkalasi turli xil externalChatId formatidan foydalangan).
 *
 * Bu skript quyidagi belgilar bo'yicha ehtimoliy dublikatlarni topadi:
 *   - Bir xil `username` (Telegram username bir xil bo'lsa, deyarli
 *     ishonchli belgidir)
 *   - YOKI bir xil `clientId`ga bog'langan (ikkalasi ham shu CRM klientiga
 *     ulangan bo'lsa)
 *   - VA bir xil tenant ichida
 *   - VA ikkalasining `lastMessageAt` vaqti bir-biriga yaqin (± 30 kun —
 *     tasodifiy mos kelishlarni kamaytirish uchun)
 *
 * Har bir juftlik uchun: KO'PROQ xabarga ega bo'lgani "asosiy" (saqlanadi)
 * deb tanlanadi, ikkinchisining barcha Message'lari asosiyga ko'chiriladi,
 * so'ng dublikat Conversation o'chiriladi.
 *
 * ⚠️ BU SKRIPT AVTOMATIK ISHGA TUSHMAYDI.
 *
 * 1-qadam — avval FAQAT ko'rib chiqish uchun (hech narsani o'zgartirmaydi):
 *   npx ts-node prisma/merge-duplicate-conversations.ts --dry-run
 *
 * 2-qadam — natijalarni tekshirib chiqqach, haqiqatan qo'llash uchun:
 *   npx ts-node prisma/merge-duplicate-conversations.ts --apply
 *
 * Ishga tushirishdan oldin albatta bazadan backup oling.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DRY_RUN = !process.argv.includes('--apply');
const CLOSE_ENOUGH_MS = 30 * 24 * 60 * 60 * 1000; // 30 kun

interface DupPair {
  keep: any;
  remove: any;
  reason: string;
}

async function findDuplicates(): Promise<DupPair[]> {
  const conversations = await prisma.conversation.findMany({
    where: { channel: 'TELEGRAM' },
    include: { _count: { select: { messages: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const pairs: DupPair[] = [];
  const consumed = new Set<string>();

  for (let i = 0; i < conversations.length; i++) {
    const a = conversations[i];
    if (consumed.has(a.id)) continue;

    for (let j = i + 1; j < conversations.length; j++) {
      const b = conversations[j];
      if (consumed.has(b.id)) continue;
      if (a.tenantId !== b.tenantId) continue;
      if (a.externalChatId === b.externalChatId) continue; // bir xil bo'lsa dublikat emas, xuddi shu yozuv

      const sameUsername = !!a.username && !!b.username && a.username.toLowerCase() === b.username.toLowerCase();
      const sameClient = !!a.clientId && !!b.clientId && a.clientId === b.clientId;
      if (!sameUsername && !sameClient) continue;

      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      if (Math.abs(aTime - bTime) > CLOSE_ENOUGH_MS) continue;

      // Ko'proq xabarga ega bo'lgani asosiy (keep) deb tanlanadi
      const aCount = (a as any)._count?.messages || 0;
      const bCount = (b as any)._count?.messages || 0;
      const [keep, remove] = aCount >= bCount ? [a, b] : [b, a];

      pairs.push({
        keep, remove,
        reason: sameUsername ? `bir xil username (@${a.username})` : `bir xil clientId (${a.clientId})`,
      });
      consumed.add(remove.id);
      break;
    }
  }

  return pairs;
}

async function main() {
  console.log(DRY_RUN ? '🔍 DRY RUN — hech narsa o\'zgartirilmaydi\n' : '⚠️ APPLY REJIMI — bazaga yozadi!\n');

  const pairs = await findDuplicates();
  if (!pairs.length) {
    console.log('✅ Dublikat suhbat topilmadi.');
    return;
  }

  console.log(`🔍 ${pairs.length} ta ehtimoliy dublikat juftlik topildi:\n`);
  for (const p of pairs) {
    console.log(
      `  KEEP  ${p.keep.id}  (${p.keep.firstName || ''} ${p.keep.lastName || ''} @${p.keep.username || '-'}, chatId=${p.keep.externalChatId})\n` +
      `  MERGE ${p.remove.id}  (${p.remove.firstName || ''} ${p.remove.lastName || ''} @${p.remove.username || '-'}, chatId=${p.remove.externalChatId})\n` +
      `  Sabab: ${p.reason}\n`,
    );

    if (!DRY_RUN) {
      // Xabarlarni asosiy suhbatga ko'chiramiz
      await prisma.message.updateMany({
        where: { conversationId: p.remove.id },
        data: { conversationId: p.keep.id },
      });
      // O'qilmagan sonini qo'shib, oxirgi xabar sanasini eng so'nggisiga moslaymiz
      const latestAt = [p.keep.lastMessageAt, p.remove.lastMessageAt]
        .filter(Boolean)
        .sort((x, y) => new Date(y as any).getTime() - new Date(x as any).getTime())[0];
      await prisma.conversation.update({
        where: { id: p.keep.id },
        data: {
          unreadCount: { increment: p.remove.unreadCount || 0 },
          ...(latestAt ? { lastMessageAt: latestAt as any } : {}),
        },
      });
      await prisma.conversation.delete({ where: { id: p.remove.id } });
      console.log('  ✅ Birlashtirildi.\n');
    }
  }

  if (DRY_RUN) {
    console.log('\n💡 Yuqoridagi ro\'yxatni tekshirib chiqing. Rozi bo\'lsangiz:');
    console.log('   npx ts-node prisma/merge-duplicate-conversations.ts --apply');
  }
}

main()
  .catch((e) => {
    console.error('❌ Xato:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());