/**
 * ── MUAMMO 1 FIX: Bot API va GramJS (MTProto) turli chatId formatidan
 *    foydalanadi ──────────────────────────────────────────────────────
 *
 * - Bot API (node-telegram-bot-api): guruh/superguruh/kanal ID'lari har doim
 *   "-100" prefiksli MANFIY son bo'lib keladi (masalan -1001234567890).
 *   Shaxsiy chatlar uchun oddiy musbat son.
 * - GramJS (MTProto, shaxsiy akkaunt orqali): guruh/kanal ID'lari "-100"
 *   PREFIKSSIZ, oddiy musbat son bo'lib keladi (masalan 1234567890).
 *   Shaxsiy chatlar uchun ham musbat son.
 *
 * Agar ikkalasi xom holda solishtirilsa (masalan bitta real guruhga bot ham,
 * agentning shaxsiy accounti ham a'zo bo'lsa), ikkita TURLI externalChatId
 * hosil bo'lib, bazada bitta guruh uchun IKKITA alohida Conversation
 * yaratilib qoladi — bu "dublikat suhbatlar" muammosining bosh sababi.
 *
 * Bu funksiya har doim BOT-uslubidagi formatga (guruh/kanal uchun -100
 * prefiksli) normalizatsiya qiladi — shunda ikkala manbadan kelgan bir xil
 * real suhbat bir xil externalChatId bilan saqlanadi.
 *
 * MUHIM: `isGroupOrChannel` chaqiruvchi tomonidan ANIQ berilishi kerak
 * (magnitudaga qarab taxmin qilish ishonchsiz — Telegram ID'lari vaqt
 * o'tishi bilan uzunlashib bormoqda). Bot API uchun `msg.chat.type !==
 * 'private'`, GramJS uchun `msg.isGroup || msg.isChannel` orqali olinadi.
 */
export function normalizeChatId(
  rawId: string | number | bigint | undefined | null,
  source: 'bot' | 'gramjs',
  isGroupOrChannel: boolean,
): string {
  if (rawId === undefined || rawId === null) return '';
  const raw = String(rawId).trim();
  if (!raw) return raw;

  if (source === 'bot') {
    // Bot API allaqachon to'g'ri formatda keladi — o'zgartirmaymiz.
    return raw;
  }

  // source === 'gramjs'
  if (isGroupOrChannel) {
    if (raw.startsWith('-100')) return raw; // allaqachon to'g'ri formatda
    const positive = raw.startsWith('-') ? raw.slice(1) : raw;
    return '-100' + positive;
  }

  // Shaxsiy chat (private) — ikkala manbada ham bir xil musbat son bo'ladi,
  // o'zgartirish shart emas.
  return raw.startsWith('-') ? raw.slice(1) : raw;
}

/**
 * ── MUAMMO 2 uchun yordamchi: Bot API xabaridan chatType ni aniqlash ──
 * Bot API `msg.chat.type` orqali to'g'ridan-to'g'ri beradi:
 * 'private' | 'group' | 'supergroup' | 'channel'
 */
export type ChatType = 'private' | 'group' | 'supergroup' | 'channel';

/**
 * ── MUAMMO 2 uchun yordamchi: GramJS xabaridan chatType ni aniqlash ──
 * GramJS Message klassida `.isPrivate` / `.isGroup` / `.isChannel` tayyor
 * getter'lari bor (Api.PeerUser / Api.PeerChat / Api.PeerChannel asosida).
 * GramJS oddiy guruh bilan superguruhni bir xil `.isGroup=true` deb beradi
 * (Bot API kabi alohida "supergroup" turi yo'q) — shuning uchun bu yerda
 * 'group' qaytariladi, superguruh farqini kerak bo'lsa kelajakda
 * `chat.className === 'Channel' && chat.megagroup` orqali aniqlash mumkin.
 */
export function inferChatTypeFromGramjs(msg: any): ChatType {
  if (msg?.isChannel && !msg?.isGroup) return 'channel';
  if (msg?.isGroup) return 'group';
  return 'private';
}