import {
  Module, Injectable, Controller, Get, Post, Patch, Delete, Body, Param,
  UseGuards, Logger, BadRequestException, NotFoundException,
  OnModuleInit, OnModuleDestroy, Optional, Inject,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Cron } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import TelegramBot from 'node-telegram-bot-api';
import type Redis from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { REDIS_CLIENT } from '../../common/cache/cache.constants';
import { RedisClientModule } from '../../common/cache/redis-client.module';
import { CronLockService } from '../../common/utils/cron-lock.service';
import { PollLockService } from '../../common/utils/poll-lock.service';
import { AiAssistantModule, AiAssistantService } from '../ai-assistant/ai-assistant.module';
import { BriefingModule, BriefingService } from '../briefing/briefing.module';
// v42: Jarvis'ga OVOZLI XABAR yuborilsa — qo'ng'iroq yozuvlarini matnga
// o'giradigan XUDDI SHU Whisper xizmatidan foydalanamiz (yangi kod
// yozilmadi, mavjud infratuzilma qayta ishlatildi).
import { TranscriptionModule, TranscriptionService } from '../transcription/transcription.module';

/**
 * ═══════════════════════════════════════════════════════════════
 * v41: JARVIS BOT — har bir tenant uchun BITTA ICHKI Telegram bot
 * ═══════════════════════════════════════════════════════════════
 *
 * G'OYA: `telegram.module.ts`dagi botlar — MIJOZLAR bilan gaplashadi.
 * Bu modul BUTUNLAY BOSHQA narsa: faqat CRM XODIMLARI uchun ICHKI bot.
 *
 *   1) Har bir qo'ng'iroq AI tahlili tugagach — ADMINGA (va
 *      MANAGERlarga) darhol yuboriladi.
 *   2) Har kuni ertalab (sozlanadigan soat, standart 09:00 Tashkent)
 *      har bir AGENTGA shaxsiy AI brifing, ADMINGA esa jamoaviy
 *      brifing yuboriladi — bu `BriefingService`dan (kuniga BIR
 *      MARTA generatsiya qilinib keshlangan) o'qiladi, ya'ni bot
 *      ORQALI yuborish o'ZI qo'shimcha AI xarajat QILMAYDI.
 *   3) Botga FAQAT ADMIN (TENANT_ADMIN yoki MANAGER) to'g'ridan-to'g'ri
 *      savol yozib Jarvis (tool-use AI yordamchi)dan javob olishi
 *      mumkin. Oddiy AGENT botdan faqat bildirishnoma oladi — biror
 *      narsa yozsa, bot buni ochiq tushuntiradi va javob bermaydi
 *      (demak AGENT'lar hech qachon qo'shimcha AI xarajat qildirmaydi).
 *
 * IZOLYATSIYA (MUHIM): bitta tenantning boti FAQAT o'zining
 * tenantId'siga tegishli foydalanuvchilar bilan ishlaydi:
 *   - Har bir bot instansi `startBot(tenantId, botId, token)` orqali
 *     yaratiladi va shu tenantId uni yopib turadi (JS closure) — bot
 *     hech qachon "boshqa tenantId" bilan biror amal bajarolmaydi,
 *     chunki bunday parametr umuman mavjud emas.
 *   - Ulanish (`JarvisBotLink`) `@@unique([botId, chatId])` bilan
 *     himoyalangan — bitta chat faqat BITTA botga (demak BITTA
 *     tenantga) bog'lanishi mumkin.
 *   - Ulash faqat CRM ichida (login qilingan holda) generatsiya
 *     qilingan bir martalik kod orqali sodir bo'ladi — token yoki
 *     chatId qo'lda kiritilmaydi, shuning uchun boshqa firma
 *     xodimi tasodifan yoki ataylab boshqa botga ulanolmaydi.
 *
 * XARAJATNI NAZORAT QILISH:
 *   - Kunlik brifing — allaqachon kuniga bir marta keshlangan
 *     ma'lumotdan o'qiladi (qo'shimcha AI so'rov yo'q).
 *   - Qo'ng'iroq tahlili push'i — AI so'rov QILMAYDI, faqat
 *     `analyzeCall` allaqachon hisoblagan natijani matn qilib
 *     yuboradi.
 *   - Faqat ADMIN botga savol yozganda AI so'rov ketadi, va u ham
 *     `ai-assistant.module.ts`dagi KUNLIK KVOTA bilan cheklangan
 *     (standart: kuniga 50 so'rov, veb-chat bilan UMUMIY hisoblanadi
 *     — demak bot orqali "cheksiz" so'rov yuborib bo'lmaydi).
 */

const CODE_TTL_SEC = 600; // 10 daqiqa
const memoryCodes = new Map<string, { userId: string; role: string; expiresAt: number }>();

type TelegramMsg = {
  message_id?: number | string;
  chat: { id: number | string };
  text?: string;
  from?: { id: number | string; first_name?: string };
};

type TelegramVoiceMsg = {
  message_id?: number | string;
  chat: { id: number | string };
  voice?: { file_id: string; file_size?: number; duration?: number };
};

// v46 TUZATISH: TAKRORLANGAN XABAR MUAMMOSI.
// SABAB: agar server 2 nusxada ishga tushirilsa (masalan deploy paytida
// eski jarayon hali to'liq o'chmagan, yoki hosting 2 ta instans/replika
// bilan ishlaydi) — HAR BIR nusxa BIR XIL bot tokeni bilan `polling: true`
// rejimida Telegram'dan getUpdates so'rайdi. Bunday holatda Telegram bir
// xil yangilanishni (update) ikkala jarayonga ham yuborishi mumkin —
// natijada bitta ovozli xabar UCHUN `handleVoice` IKKI MARTA chaqiriladi
// (foydalanuvchi "🎙 Eshitdim" xabarini 2 marta ko'radi, ai-assistant
// so'rovi ham 2 marta ketadi — bekorga xarajat).
// YECHIM: har bir kiruvchi update'ni (botId+chatId+message_id bo'yicha)
// QAYTA ISHLASHDAN OLDIN "ko'rilganlar" ro'yxatiga tekshiramiz — agar
// so'nggi 2 daqiqa ichida xuddi shu message_id allaqachon qayta
// ishlangan bo'lsa, jim o'tkazib yuboramiz. Bu tub sababni (bir nechta
// instans) TUZATMAYDI, lekin foydalanuvchiga ta'sirini (takroriy javob,
// ikki barobar AI xarajati) TO'LIQ yo'q qiladi — va agar tub sabab
// bitta instans/getUpdates retry bo'lsa ham, bir xil himoya ishlaydi.
const processedUpdates = new Map<string, number>();
const DEDUP_TTL_MS = 2 * 60 * 1000;
function alreadyProcessed(key: string): boolean {
  const now = Date.now();
  // vaqti o'tgan yozuvlarni tozalab boramiz (xotira sizmasin)
  if (processedUpdates.size > 500) {
    for (const [k, t] of processedUpdates) {
      if (now - t > DEDUP_TTL_MS) processedUpdates.delete(k);
    }
  }
  const seenAt = processedUpdates.get(key);
  if (seenAt && now - seenAt < DEDUP_TTL_MS) return true;
  processedUpdates.set(key, now);
  return false;
}

@Injectable()
export class JarvisBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('JarvisBot');
  // tenantId → aktiv TelegramBot instansi (har biri FAQAT o'z tenantId'sini biladi)
  private bots = new Map<string, TelegramBot>();
  // v20 FIX (XOTIRA/CPU SIZISHI — ASOSIY SABAB, telegram.module.ts'dagi
  // bilan bir xil muammo): `startBot()` bir nechta manbadan (onModuleInit,
  // polling_error qayta urinishi, qulf-kutish setTimeout'i) bir-birini
  // KUTMASDAN parallel chaqirilishi mumkin edi — natijada ba'zan IKKITA
  // TelegramBot(polling:true) bir vaqtda yaratilib, faqat BITTASI
  // `this.bots` Map'ida qolardi, ikkinchisi esa hech qachon
  // `stopPolling()` qilinmagan holda xotirada abadiy pollashda qolib
  // ketardi ("orfan" bot — doimiy ulanish + xotira + CPU). Endi berilgan
  // tenantId uchun bir vaqtda FAQAT bitta `startBot()` ishlaydi.
  private startingBots = new Set<string>();
  // tenantId → JarvisBot.id (tezkor qidiruv uchun)
  private botIds = new Map<string, string>();
  // v46 FIX: telegram.module.ts'dagi bilan bir xil bag — bu yerda ham
  // `lastErrorTime` startBot() ICHIDA local `let` edi, shuning uchun har
  // 409-qayta-ishga-tushirishda yo'qolib, HAR DOIM 15s'dan qayta
  // boshlanardi (haqiqiy backoff yo'q edi). Endi tenantId bo'yicha klassda
  // saqlanadi.
  private conflictState = new Map<string, { count: number; lastAt: number }>();
  // v46 FIX (poll lock): qulf band bo'lgani haqidagi ogohlantirishni throttle qilamiz
  private lockWaitWarned = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private aiAssistant: AiAssistantService,
    private briefing: BriefingService,
    private cronLock: CronLockService,
    private transcription: TranscriptionService,
    // v46 FIX: bir nechta instans bir xil tokenni pollamasin (409 loop tub sababi)
    private pollLock: PollLockService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis: Redis | null = null,
  ) {}

  async onModuleInit() {
    try {
      const bots = await this.prisma.jarvisBot.findMany({ where: { isActive: true } });
      for (const b of bots) {
        await this.startBot(b.tenantId, b.id, b.botToken).catch((e) =>
          this.logger.error(`Jarvis bot start xato [tenant ${b.tenantId}]: ${e.message}`),
        );
      }
      this.logger.log(`${bots.length} ta Jarvis bot ishga tushirildi`);
    } catch (e: any) {
      this.logger.error(`Init xato: ${e.message}`);
    }
  }

  async onModuleDestroy() {
    for (const [tenantId, bot] of this.bots.entries()) {
      try {
        await bot.stopPolling();
        this.logger.log(`Jarvis bot to'xtatildi: ${tenantId}`);
      } catch {}
      await this.pollLock.release(`jarvis-bot:${tenantId}`).catch(() => {});
    }
    this.bots.clear();
  }

  // ─── BOT HAYOT SIKLI ────────────────────────────────────────────

  private async startBot(tenantId: string, botId: string, token: string) {
    // v20 FIX: qayta-kirish (re-entrancy) himoyasi — yuqoridagi izohga qarang.
    if (this.startingBots.has(tenantId)) {
      this.logger.log(`Jarvis bot ${tenantId}: startBot() allaqachon jarayonda — takroriy chaqiruv o'tkazib yuborildi (orfan bot yaratilmasin uchun)`);
      return;
    }
    this.startingBots.add(tenantId);
    try {
      await this.startBotInner(tenantId, botId, token);
    } finally {
      this.startingBots.delete(tenantId);
    }
  }

  private async startBotInner(tenantId: string, botId: string, token: string) {
    const existing = this.bots.get(tenantId);
    if (existing) {
      try { await existing.stopPolling(); } catch {}
      this.bots.delete(tenantId);
    }

    // v46 TUZATISH (tub sabab): ilgari faqat DEDUP (processedUpdates) bilan
    // takroriy xabarning TA'SIRI yashirilardi, lekin 2+ instans BARIBIR bir
    // xil tokenni pollashda davom etardi — shuning uchun loglarda 409
    // Conflict cheksiz takrorlanardi (30+ urinish). Endi qulf orqali FAQAT
    // BITTA instans haqiqiy pollingni boshlaydi; qolganlari band bo'lgan
    // qulfni davriy tekshirib turadi.
    const lockName = `jarvis-bot:${tenantId}`;
    const gotLock = await this.pollLock.acquire(lockName, 30);
    if (!gotLock) {
      const now = Date.now();
      const lastWarned = this.lockWaitWarned.get(tenantId) || 0;
      if (now - lastWarned > 5 * 60 * 1000) {
        this.lockWaitWarned.set(tenantId, now);
        this.logger.log(`Jarvis bot ${tenantId}: boshqa instansda allaqachon ishlamoqda — kutilmoqda`);
      }
      setTimeout(() => {
        this.startBot(tenantId, botId, token).catch((e) =>
          this.logger.error(`Jarvis bot start (qulf kutish) xato [${tenantId}]: ${e.message}`),
        );
      }, 20000);
      return;
    }

    try {
      const tempBot = new TelegramBot(token, { polling: false });
      await tempBot.deleteWebhook({ drop_pending_updates: true });
    } catch {}

    const bot = new TelegramBot(token, { polling: true });

    // MUHIM: bu yopiq funksiya (closure) ICHIDA `tenantId` va `botId`
    // O'ZGARMAS — shuning uchun shu bot hech qachon boshqa tenant
    // uchun amal bajarolmaydi.
    bot.on('message', (msg: TelegramMsg) =>
      this.handleIncoming(tenantId, botId, bot, msg).catch((e) =>
        this.logger.error(`handleIncoming xato [${tenantId}]: ${e.message}`),
      ),
    );
    // v42: OVOZLI XABAR — matn bilan BIR QATORDA qo'llab-quvvatlanadi.
    // Telegram voice notlar alohida 'voice' hodisasi bilan keladi
    // ('message' hodisasida ham keladi, lekin u yerda `msg.text` bo'sh
    // bo'lgani uchun `handleIncoming` uni jim o'tkazib yuboradi).
    bot.on('voice', (msg: TelegramVoiceMsg) =>
      this.handleVoice(tenantId, botId, bot, msg).catch((e) =>
        this.logger.error(`handleVoice xato [${tenantId}]: ${e.message}`),
      ),
    );

    let lastErrorTime = 0;
    bot.on('polling_error', (e: any) => {
      const msg = e?.message || String(e);
      const now = Date.now();
      if (now - lastErrorTime < 60000) return;
      lastErrorTime = now;
      if (msg.includes('409') || msg.includes('Conflict')) {
        // v46 FIX: haqiqiy o'sib boruvchi backoff (15s → 30s → ... → 120s),
        // holat tenantId bo'yicha klassda saqlanadi (restart'da yo'qolmaydi).
        const prev = this.conflictState.get(tenantId);
        const count = prev && now - prev.lastAt < 5 * 60 * 1000 ? prev.count + 1 : 1;
        this.conflictState.set(tenantId, { count, lastAt: now });
        const delay = Math.min(15000 * count, 120000);
        this.logger.warn(`Jarvis bot ${tenantId}: 409 Conflict (${count}-urinish) — ${delay/1000}s dan keyin restart`);
        setTimeout(() => { this.startBot(tenantId, botId, token).catch(() => {}); }, delay);
      } else if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) {
        setTimeout(() => { this.startBot(tenantId, botId, token).catch(() => {}); }, 60000);
      } else {
        this.logger.error(`Jarvis bot ${tenantId}: ${msg}`);
      }
    });

    this.bots.set(tenantId, bot);
    this.botIds.set(tenantId, botId);
  }

  private async stopBot(tenantId: string) {
    const bot = this.bots.get(tenantId);
    if (bot) {
      try { await bot.stopPolling(); } catch {}
      this.bots.delete(tenantId);
    }
    this.botIds.delete(tenantId);
    this.conflictState.delete(tenantId);
    await this.pollLock.release(`jarvis-bot:${tenantId}`).catch(() => {});
  }

  // ─── ULASH KODI (CRM ichida generatsiya qilinadi) ──────────────

  private codeKey(tenantId: string, code: string) {
    return `jarvis-link:${tenantId}:${code}`;
  }

  private genCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // chalkash belgilarsiz (0/O, 1/I yo'q)
    let out = '';
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  /** CRM ichida (login qilingan holda) chaqiriladi — bir martalik ulanish kodi beradi */
  async createLinkCode(tenantId: string, userId: string, role: string) {
    const bot = await this.prisma.jarvisBot.findUnique({ where: { tenantId } });
    if (!bot || !bot.isActive) {
      throw new BadRequestException("Bu kompaniyada Jarvis bot hali ulanmagan. Avval administrator botni ulasin.");
    }
    const code = this.genCode();
    const value = JSON.stringify({ userId, role });

    if (this.redis) {
      try {
        await this.redis.set(this.codeKey(tenantId, code), value, 'EX', CODE_TTL_SEC);
      } catch {
        memoryCodes.set(this.codeKey(tenantId, code), { userId, role, expiresAt: Date.now() + CODE_TTL_SEC * 1000 });
      }
    } else {
      memoryCodes.set(this.codeKey(tenantId, code), { userId, role, expiresAt: Date.now() + CODE_TTL_SEC * 1000 });
    }

    return {
      code,
      botUsername: bot.botUsername,
      deepLink: bot.botUsername ? `https://t.me/${bot.botUsername}?start=${code}` : null,
      expiresInSec: CODE_TTL_SEC,
    };
  }

  private async consumeLinkCode(tenantId: string, code: string): Promise<{ userId: string; role: string } | null> {
    const key = this.codeKey(tenantId, code.toUpperCase().trim());
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (!raw) return null;
        await this.redis.del(key).catch(() => {});
        return JSON.parse(raw);
      } catch {
        // fallthrough — xotira zaxirasiga
      }
    }
    const entry = memoryCodes.get(key);
    if (!entry || entry.expiresAt < Date.now()) return null;
    memoryCodes.delete(key);
    return { userId: entry.userId, role: entry.role };
  }

  // ─── KIRUVCHI XABARLARNI QAYTA ISHLASH ─────────────────────────

  private async handleIncoming(tenantId: string, botId: string, bot: TelegramBot, msg: TelegramMsg) {
    const chatId = String(msg.chat.id);
    const text = String(msg.text || '').trim();
    if (!text) return;
    if (msg.message_id != null && alreadyProcessed(`${botId}:${chatId}:msg:${msg.message_id}`)) {
      this.logger.warn(`Takroriy update o'tkazib yuborildi (message_id=${msg.message_id}, tenant=${tenantId})`);
      return;
    }

    if (text.startsWith('/start')) {
      const parts = text.split(/\s+/);
      const code = parts[1];

      if (!code) {
        const existing = await this.prisma.jarvisBotLink.findUnique({ where: { botId_chatId: { botId, chatId } } as any }).catch(() => null);
        if (existing) {
          await bot.sendMessage(chatId, "👋 Salom! Siz allaqachon ulangansiz.");
        } else {
          await bot.sendMessage(chatId, "👋 Salom! Bu — Jarvis, CRM'ning ichki AI yordamchisi.\n\nUlanish uchun CRM'da: Sozlamalar → Jarvis Bot bo'limidan \"Ulash\" tugmasini bosing (yoki kod oling).");
        }
        return;
      }

      const payload = await this.consumeLinkCode(tenantId, code);
      if (!payload) {
        await bot.sendMessage(chatId, "❌ Kod noto'g'ri yoki muddati o'tgan. CRM'dan yangi kod oling.");
        return;
      }
      const user = await this.prisma.user.findFirst({ where: { id: payload.userId, tenantId, status: 'ACTIVE' as any } });
      if (!user) {
        await bot.sendMessage(chatId, "❌ Foydalanuvchi topilmadi.");
        return;
      }

      await this.prisma.jarvisBotLink.upsert({
        where: { userId: user.id },
        create: { tenantId, botId, userId: user.id, chatId, role: user.role },
        update: { botId, chatId, role: user.role, isActive: true },
      });

      const isAdmin = ['TENANT_ADMIN', 'MANAGER'].includes(user.role);
      await bot.sendMessage(
        chatId,
        isAdmin
          ? `✅ Ulandingiz, ${user.name}!\n\nEndi har bir qo'ng'iroq tahlili va kunlik jamoaviy brifing shu yerga keladi. Savolingiz bo'lsa — shunchaki yozing, Jarvis javob beradi.`
          : `✅ Ulandingiz, ${user.name}!\n\nEndi har kuni ertalab shaxsiy AI brifingingiz shu yerga keladi. (Savol yozish faqat administratorga ochiq.)`,
      );
      return;
    }

    const link = await this.prisma.jarvisBotLink.findUnique({ where: { botId_chatId: { botId, chatId } } as any }).catch(() => null);
    if (!link || !link.isActive) {
      await bot.sendMessage(chatId, "Siz hali ulanmagansiz. CRM'da Sozlamalar → Jarvis Bot bo'limidan ulanish kodini oling.");
      return;
    }

    if (!['TENANT_ADMIN', 'MANAGER'].includes(link.role)) {
      await bot.sendMessage(chatId, "Bu bot orqali faqat bildirishnomalar (qo'ng'iroq tahlili, kunlik brifing) yuboriladi. Savol-javob faqat administratorga ochiq.");
      return;
    }

    // Faqat ADMIN/MANAGER — Jarvis AI yordamchisiga yo'naltiramiz
    await this.runJarvisTurn(bot, chatId, tenantId, link, text);
  }

  /**
   * v42: ADMIN/MANAGER Jarvis'ga OVOZLI XABAR yuborsa — avval mavjud
   * Whisper pipeline (`TranscriptionService`, `calls.module.ts`dagi
   * qo'ng'iroq yozuvlarini matnga o'giruvchi XIZMAT BILAN BIR XIL)
   * orqali matnga o'giramiz, so'ng xuddi yozma xabar kabi Jarvis AI
   * yordamchisiga yo'naltiramiz — shuning uchun ovozli buyruq
   * ("Ahmadning bosqichini Muzokara qil" kabi) ham TO'LIQ ishlaydi,
   * chunki tool-use agent ikkalasida ham BIR XIL kod yo'lidan o'tadi.
   * Qo'shimcha AI (Claude) so'rovi qo'shilmaydi — faqat STT (Whisper)
   * so'rovi qo'shiladi, u ham faqat ADMIN/MANAGER uchun ishlaydi.
   */
  private async handleVoice(tenantId: string, botId: string, bot: TelegramBot, msg: TelegramVoiceMsg) {
    const chatId = String(msg.chat.id);
    const voice = msg.voice;
    if (!voice?.file_id) return;
    if (msg.message_id != null && alreadyProcessed(`${botId}:${chatId}:voice:${msg.message_id}`)) {
      this.logger.warn(`Takroriy ovozli update o'tkazib yuborildi (message_id=${msg.message_id}, tenant=${tenantId})`);
      return;
    }

    const link = await this.prisma.jarvisBotLink.findUnique({ where: { botId_chatId: { botId, chatId } } as any }).catch(() => null);
    if (!link || !link.isActive) {
      await bot.sendMessage(chatId, "Siz hali ulanmagansiz. CRM'da Sozlamalar → Jarvis Bot bo'limidan ulanish kodini oling.");
      return;
    }
    if (!['TENANT_ADMIN', 'MANAGER'].includes(link.role)) {
      await bot.sendMessage(chatId, "Bu bot orqali faqat bildirishnomalar yuboriladi. Ovozli buyruq berish faqat administratorga ochiq.");
      return;
    }
    if (!this.transcription.isConfigured()) {
      await bot.sendMessage(chatId, "⚠️ Ovozli xabarlarni matnga o'girish sozlanmagan (GROQ_API_KEY/OPENAI_API_KEY yo'q). Iltimos, matn bilan yozing.");
      return;
    }
    // 25MB Whisper limitidan xavfsiz chegara (Telegram voice notlar odatda juda kichik)
    if (voice.file_size && voice.file_size > 24 * 1024 * 1024) {
      await bot.sendMessage(chatId, "⚠️ Ovozli xabar juda katta (limit 25MB).");
      return;
    }

    try {
      await bot.sendChatAction(chatId, 'typing').catch(() => {});
      const fileUrl = await bot.getFileLink(voice.file_id);
      const stt = await this.transcription.transcribeFromUrl(fileUrl);
      if (!stt.text) {
        await bot.sendMessage(chatId, `⚠️ Ovozli xabarni tushunolmadim${stt.error ? `: ${stt.error}` : '.'} Iltimos, qayta urinib ko'ring yoki matn bilan yozing.`);
        return;
      }
      await bot.sendMessage(chatId, `🎙 Eshitdim: "${stt.text.slice(0, 300)}"`);
      await this.runJarvisTurn(bot, chatId, tenantId, link, stt.text);
    } catch (e: any) {
      this.logger.warn(`Ovozli xabar xato [${tenantId}]: ${e.message}`);
      await bot.sendMessage(chatId, "⚠️ Ovozli xabarni qayta ishlab bo'lmadi. Matn bilan yozib ko'ring.");
    }
  }

  /** Matn (yoki ovozdan aylantirilgan matn)ni Jarvis AI yordamchisiga yuboradi va javobni botga qaytaradi. */
  private async runJarvisTurn(
    bot: TelegramBot,
    chatId: string,
    tenantId: string,
    link: { id: string; userId: string; role: string; aiConversationId?: string | null },
    text: string,
  ) {
    try {
      await bot.sendChatAction(chatId, 'typing').catch(() => {});
      const result = await this.aiAssistant.chat(
        { tenantId, userId: link.userId, role: link.role },
        link.aiConversationId || undefined,
        text,
        'telegram',
      );
      if (result.conversationId !== link.aiConversationId) {
        await this.prisma.jarvisBotLink.update({
          where: { id: link.id },
          data: { aiConversationId: result.conversationId },
        }).catch(() => {});
      }
      await bot.sendMessage(chatId, (result.reply || "Javob tayyorlay olmadim.").slice(0, 4000));
    } catch (e: any) {
      const msg = e?.response?.message || e?.message || "Jarvis hozir javob bera olmadi.";
      await bot.sendMessage(chatId, `⚠️ ${msg}`);
    }
  }

  // ─── ADMIN CRM'DAN BOTNI BOSHQARISH ────────────────────────────

  async connect(tenantId: string, token: string) {
    if (!token?.trim()) throw new BadRequestException('Bot token kerak');
    token = token.trim();

    const tempBot = new TelegramBot(token, { polling: false });
    const info = await tempBot.getMe().catch(() => {
      throw new BadRequestException("Token noto'g'ri — Telegram bu tokenni tanimadi");
    });

    // Global tekshiruv: bu token boshqa tenantda ALLAQACHON ishlatilmayaptimi
    // (izolyatsiyani buzmasin — bitta bot faqat bitta firmaga tegishli bo'lsin)
    const dup = await this.prisma.jarvisBot.findFirst({ where: { botToken: token, NOT: { tenantId } } });
    if (dup) throw new BadRequestException('Bu bot allaqachon boshqa kompaniyada ulangan');

    const bot = await this.prisma.jarvisBot.upsert({
      where: { tenantId },
      create: { tenantId, botToken: token, botUsername: info.username, isActive: true },
      update: { botToken: token, botUsername: info.username, isActive: true },
    });

    await this.startBot(tenantId, bot.id, token);
    return { connected: true, botUsername: bot.botUsername };
  }

  async disconnect(tenantId: string) {
    const bot = await this.prisma.jarvisBot.findUnique({ where: { tenantId } });
    if (!bot) throw new NotFoundException('Jarvis bot topilmadi');
    await this.stopBot(tenantId);
    await this.prisma.jarvisBot.update({ where: { tenantId }, data: { isActive: false } });
    return { connected: false };
  }

  async updateSettings(tenantId: string, data: { notifyAdminOnAnalysis?: boolean; dailyDigestEnabled?: boolean; dailyDigestHour?: number }) {
    const bot = await this.prisma.jarvisBot.findUnique({ where: { tenantId } });
    if (!bot) throw new NotFoundException('Jarvis bot topilmadi');
    const patch: any = {};
    if (typeof data.notifyAdminOnAnalysis === 'boolean') patch.notifyAdminOnAnalysis = data.notifyAdminOnAnalysis;
    if (typeof data.dailyDigestEnabled === 'boolean') patch.dailyDigestEnabled = data.dailyDigestEnabled;
    if (typeof data.dailyDigestHour === 'number' && data.dailyDigestHour >= 0 && data.dailyDigestHour <= 23) {
      patch.dailyDigestHour = data.dailyDigestHour;
    }
    return this.prisma.jarvisBot.update({ where: { tenantId }, data: patch });
  }

  async getStatus(tenantId: string, userId: string) {
    const bot = await this.prisma.jarvisBot.findUnique({
      where: { tenantId },
      include: { links: { select: { userId: true, role: true, isActive: true, linkedAt: true, user: { select: { name: true } } } } },
    });
    const myLink = bot?.links.find((l) => l.userId === userId) || null;
    return {
      connected: !!bot?.isActive,
      botUsername: bot?.botUsername || null,
      notifyAdminOnAnalysis: bot?.notifyAdminOnAnalysis ?? true,
      dailyDigestEnabled: bot?.dailyDigestEnabled ?? true,
      dailyDigestHour: bot?.dailyDigestHour ?? 9,
      links: bot?.links.map((l) => ({ userId: l.userId, name: l.user?.name, role: l.role, isActive: l.isActive, linkedAt: l.linkedAt })) || [],
      myLinked: !!myLink?.isActive,
    };
  }

  async unlink(tenantId: string, targetUserId: string) {
    const link = await this.prisma.jarvisBotLink.findFirst({ where: { tenantId, userId: targetUserId } });
    if (!link) throw new NotFoundException('Ulanish topilmadi');
    await this.prisma.jarvisBotLink.delete({ where: { id: link.id } });
    return { success: true };
  }

  // ─── QO'NG'IROQ TAHLILI → ADMINGA PUSH (AI so'rov QILMAYDI) ────

  /**
   * `calls.module.ts`dagi `analyzeCall` muvaffaqiyatli tugagach
   * `call.analyzed` hodisasini chiqaradi — biz shu yerda tinglaymiz.
   * TO'G'RIDAN-TO'G'RI IMPORT emas, hodisa orqali — bu CallsModule
   * bilan JarvisBotModule (u BriefingModule'ni ishlatadi, u esa
   * `calls.module.ts`dan OBJECTION_CATEGORIES'ni import qiladi)
   * o'rtasida aylanma bog'liqlik (circular import) yaratmaydi.
   */
  @OnEvent('call.analyzed')
  async notifyCallAnalyzed(payload: {
    tenantId: string;
    id: string;
    agentId?: string | null;
    agentName?: string | null;
    clientName?: string | null;
    aiSummary?: string | null;
    aiSentiment?: string | null;
    aiFeedback?: any;
    callType?: string;
  }) {
    const { tenantId, ...call } = payload;
    try {
      const bot = await this.prisma.jarvisBot.findUnique({ where: { tenantId } });
      if (!bot || !bot.isActive || !bot.notifyAdminOnAnalysis) return;
      const botInstance = this.bots.get(tenantId);
      if (!botInstance) return;

      const admins = await this.prisma.jarvisBotLink.findMany({
        where: { tenantId, botId: bot.id, isActive: true, role: { in: ['TENANT_ADMIN', 'MANAGER'] } },
      });
      if (!admins.length) return;

      // v46: `overallScore` 0-100 shkalada — avval "X/10" deb noto'g'ri
      // ko'rsatilardi (masalan overallScore=8 bo'lsa "8/10" chiqib, aslida
      // "8/100" ekanini yashirardi va deyarli har doim past-o'rtacha bir xil
      // raqam ko'rinib, AI "doim bir xil baho beryapti" degan taassurot
      // qoldirardi). Endi to'g'ri "/100" bilan ko'rsatiladi.
      const sentimentEmoji = call.aiSentiment === 'positive' ? '🟢' : call.aiSentiment === 'negative' ? '🔴' : '🟡';
      const score = call.aiFeedback?.overallScore != null ? `${call.aiFeedback.overallScore}/100` : '—';

      // callType — agent haqiqatda gaplashmagan qo'ng'iroqlarni (IVR/avtomatik
      // javob, javobsiz) alohida belgilaymiz, shunda admin ballarni sotuv
      // ko'nikmasi bilan aralashtirib tushunmaydi.
      const callType = call.callType || call.aiFeedback?.callType;
      const callTypeLabel: Record<string, string> = {
        ivr_or_voicemail: "🤖 Avtomatik javob (IVR) — agent gaplashmadi",
        no_answer_or_hangup: "📵 Javobsiz / uzilgan qo'ng'iroq",
        short_offtopic: "💬 Mavzudan tashqari qisqa suhbat",
      };
      const typeNote = callType && callTypeLabel[callType] ? callTypeLabel[callType] : null;

      const lines = [
        `📞 Yangi qo'ng'iroq tahlili`,
        ``,
        `Agent: ${call.agentName || 'Noma\'lum'}`,
        `Mijoz: ${call.clientName || 'Noma\'lum'}`,
        `Kayfiyat: ${sentimentEmoji}  Baho: ${score}`,
        ...(typeNote ? [typeNote] : []),
        ``,
        call.aiSummary ? call.aiSummary.slice(0, 600) : 'Xulosa yo\'q.',
      ];
      const text = lines.join('\n');

      for (const link of admins) {
        await botInstance.sendMessage(link.chatId, text).catch((e) =>
          this.logger.warn(`Push yuborilmadi [${tenantId} → ${link.chatId}]: ${e.message}`),
        );
      }
    } catch (e: any) {
      this.logger.warn(`notifyCallAnalyzed xato: ${e.message}`);
    }
  }

  // ─── KUNLIK BRIFING → CRON (AI qo'shimcha so'rov QILMAYDI — keshdan o'qiydi) ───

  private todayKeyTashkent(): string {
    const tashkent = new Date(Date.now() + 5 * 3600 * 1000);
    return tashkent.toISOString().slice(0, 10);
  }
  private currentHourTashkent(): number {
    const tashkent = new Date(Date.now() + 5 * 3600 * 1000);
    return tashkent.getUTCHours();
  }

  /**
   * v43: KUNLIK AI BRIFING O'CHIRILDI — token sarfini kamaytirish uchun
   * bu avtomatik kunlik digest (ertalabki shaxsiy/jamoaviy xabar)
   * butunlay to'xtatildi. Jarvisning QOLGAN barcha funksiyalari
   * (qo'ng'iroq tahlili tugagach darhol xabar, admin savol-javob)
   * o'zgarishsiz ishlab turadi — faqat shu avtomatik AI so'rovi
   * (soatiga bir marta tekshirilib, "vaqti kelgan" botlarga
   * yuborilardi) o'chirildi.
   */
  @Cron('0 * * * *')
  async hourlyDigestTick() {
    return;
  }

  private async sendDailyDigest(tenantId: string, botId: string) {
    const botInstance = this.bots.get(tenantId);
    if (!botInstance) return;

    const links = await this.prisma.jarvisBotLink.findMany({ where: { tenantId, botId, isActive: true } });
    for (const link of links) {
      try {
        // v41: keshlangan brifingdan o'qiydi — agar bugun hali generatsiya
        // qilinmagan bo'lsa shu yerda BIR MARTA generatsiya qilinadi va
        // keyin dashboard ochilganda ham xuddi shu natija ko'rinadi
        // (aksincha ham to'g'ri) — ya'ni ikki marta AI xarajat qilinmaydi.
        const data = await this.briefing.getBriefing(tenantId, link.userId, link.role, false);
        if ((data as any)?.disabled || (data as any)?.error) continue;

        const isAgent = link.role === 'AGENT';
        const heading = isAgent ? "🌅 Bugungi shaxsiy ustuvorliklaringiz" : "🌅 Jamoaning bugungi holati";
        const parts = [heading];
        if (data.greeting) parts.push(data.greeting);
        parts.push('');
        const items = Array.isArray(data.items) ? data.items.slice(0, 6) : [];
        if (items.length) {
          items.forEach((it: any, i: number) => {
            parts.push(`${i + 1}. ${it.title}${it.clientName ? ` — ${it.clientName}` : ''}`);
            if (it.reason) parts.push(`   ↳ ${it.reason}`);
          });
        } else {
          parts.push("Bugun ustuvor ochiq ish topilmadi 👍");
        }
        if (data.weakSpot) {
          parts.push('', `💡 ${data.weakSpot.title}: ${data.weakSpot.detail}`);
          if (data.weakSpot.tip) parts.push(`   Tavsiya: ${data.weakSpot.tip}`);
        }

        await botInstance.sendMessage(link.chatId, parts.join('\n').slice(0, 4000));
      } catch (e: any) {
        this.logger.warn(`Digest yuborilmadi [${tenantId} → ${link.userId}]: ${e.message}`);
      }
    }
  }
}

@ApiTags('Jarvis Bot')
@ApiBearerAuth()
@Controller('jarvis-bot')
@UseGuards(JwtAuthGuard)
export class JarvisBotController {
  constructor(private svc: JarvisBotService) {}

  @ApiOperation({ summary: "Jarvis bot holati (ulanganmi, kim ulangan, o'zim ulanganmanmi)" })
  @Get('status')
  status(@CurrentUser() u: any) {
    return this.svc.getStatus(u.tenantId, u.sub);
  }

  @ApiOperation({ summary: "Jarvis botni ulash (bitta tenantda FAQAT bitta bot)" })
  @Post('connect')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  connect(@CurrentUser() u: any, @Body() body: { token: string }) {
    return this.svc.connect(u.tenantId, body?.token);
  }

  @ApiOperation({ summary: "Jarvis botni uzish" })
  @Post('disconnect')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  disconnect(@CurrentUser() u: any) {
    return this.svc.disconnect(u.tenantId);
  }

  @ApiOperation({ summary: "Bildirishnoma sozlamalarini yangilash" })
  @Patch('settings')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  updateSettings(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.updateSettings(u.tenantId, body);
  }

  @ApiOperation({ summary: "O'zimni Jarvis botga ulash uchun bir martali kod olish" })
  @Post('link-code')
  linkCode(@CurrentUser() u: any) {
    return this.svc.createLinkCode(u.tenantId, u.sub, u.role);
  }

  @ApiOperation({ summary: "Boshqa foydalanuvchini botdan uzish" })
  @Delete('links/:userId')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  unlink(@CurrentUser() u: any, @Param('userId') userId: string) {
    return this.svc.unlink(u.tenantId, userId);
  }
}

@Module({
  imports: [PrismaModule, RedisClientModule, AiAssistantModule, BriefingModule, TranscriptionModule],
  controllers: [JarvisBotController],
  providers: [JarvisBotService],
  exports: [JarvisBotService],
})
export class JarvisBotModule {}