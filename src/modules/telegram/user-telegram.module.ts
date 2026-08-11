/**
 * UserTelegram Module — MTProto orqali shaxsiy Telegram accountini boshqarish
 * 
 * Bu modul agentlarga o'z shaxsiy Telegram accountlari orqali
 * inbox'dan birinchi bo'lib xabar yuborish imkonini beradi.
 * 
 * Flow:
 * 1. Agent telefon raqamini kiritadi (POST /user-telegram/auth/send-code)
 * 2. SMS/app code keladi → agent kiritadi (POST /user-telegram/auth/verify-code)
 * 3. 2FA parol bo'lsa → (POST /user-telegram/auth/2fa)
 * 4. Session saqlandi → agent endi inbox'dan xabar yubora oladi
 */

import {
  Module, Injectable, Controller,
  Post, Get, Delete, Body, Param,
  UseGuards, BadRequestException, NotFoundException,
  OnModuleInit, OnModuleDestroy, Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { Api } from 'telegram/tl';
import { NewMessage, NewMessageEvent } from 'telegram/events';
import { PrismaService } from '../../prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { normalizeChatId, inferChatTypeFromGramjs } from './chat-id.util';
import { uploadBufferToStorage } from '../../common/utils/media-storage';
import { toOggOpus } from '../../common/utils/voice-convert';
import { swallow } from '../../common/utils/swallow';

// Telegram API credentials - admin tomonidan sozlanadi (my.telegram.org dan olinadi)
// Default: demo credentials (faqat test uchun)
const DEFAULT_API_ID = parseInt(process.env.TELEGRAM_API_ID || '2040');
const DEFAULT_API_HASH = process.env.TELEGRAM_API_HASH || 'b18441a1ff607e10a989891a5462e627';

// Active client sessions (memory cache)
const activeSessions = new Map<string, TelegramClient>();
// Pending auth state (phone → {phoneCodeHash, client})
const pendingAuth = new Map<string, { phoneCodeHash: string; client: TelegramClient; phone: string; createdAt: number }>();
// Telegramning SMS/app kodi odatda bir necha daqiqa amal qiladi — shundan
// ancha ortiq kutib turgan "tashlab ketilgan" login urinishlarini eskirgan
// deb hisoblaymiz.
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

// XOTIRA SIZISHI TUZATILDI: `sendCode()` har chaqirilganda ULANGAN
// (connect() qilingan) TelegramClient yaratib, uni shu Map'da saqlaydi —
// lekin bu client faqat verifyCode()/verify2FA() MUVAFFAQIYATLI
// tugaganda `disconnect()` qilinardi. Agar agent kodni noto'g'ri
// kiritsa va boshqa urinmasa, kod muddati o'tib ketsa, yoki jarayonni
// shunchaki tashlab ketsa — o'sha ulangan client (soketi va GramJS'ning
// ichki timer/listenerlari bilan) hech qachon uzilmasdan Map'da
// ABADIY qolardi. Xuddi shunday, agar agent bir xil raqam uchun
// "Kod yuborish"ni qayta bossa, eski (hali ulangan) client yangisi
// bilan JIMGINA almashtirilib, eskisi hech qachon uzilmasdi.
// Bu — activeSessions/restoreSession() uchun yuqorida (v16 FIX) allaqachon
// tuzatilgan bilan AYNAN bir xil turdagi sizish, faqat pendingAuth uchun
// hali tuzatilmagan edi.
setInterval(() => {
  const now = Date.now();
  for (const [key, pending] of pendingAuth.entries()) {
    if (now - pending.createdAt > PENDING_AUTH_TTL_MS) {
      pendingAuth.delete(key);
      pending.client.disconnect().catch(() => {});
    }
  }
}, 5 * 60 * 1000);

// XOTIRA SIZISHI TUZATILDI (v46): `verifyCode()`/`verify2FA()` muvaffaqiyatli
// login'dan so'ng `activeSessions.set(account.id, client)` deb YANGI client'ni
// to'g'ridan-to'g'ri yozib qo'yardi — agar shu account.id uchun Map'da
// ALLAQACHON (masalan avvalgi seans, yoki server qayta ishga tushganda
// onModuleInit orqali tiklangan) ULANGAN eski client bo'lsa, o'sha eski
// client hech qachon `disconnect()` qilinmasdan xotirada (o'z soketi,
// GramJS timer/listenerlari bilan) ABADIY qolardi. Agent Telegram
// akkauntini bir necha marta qayta ulasa (yoki kodni ikki marta yuborsa),
// har safar YANGI "zombi" ulanish qo'shilib borar, natijada RAM asta-sekin
// to'lib, server (Render) xotira limitiga urilib qayta ishga tushardi
// ("uxlab qolgandek" ko'rinardi). Yechim — restoreSession()/disconnect()da
// allaqachon qo'llanilgan naqsh: yangisini yozishdan OLDIN eskisini uzamiz.
function replaceActiveSession(accountId: string, client: TelegramClient) {
  const prev = activeSessions.get(accountId);
  if (prev && prev !== client) {
    prev.disconnect().catch(() => {});
  }
  activeSessions.set(accountId, client);
}

// v16 FIX: bitta account uchun bir vaqtda faqat BITTA restoreSession() ishlashi
// kerak. Ilgari bunday himoya yo'q edi — onModuleInit() va 5-daqiqalik
// healthCheckSessions() bir-biriga tegib qolsa (yoki health-check ikki marta
// ustma-ust chaqirilsa), BIR XIL account uchun BIR NECHTA TelegramClient
// (va shu bilan bir nechta TCP socket) ochilib, eskilari hech qachon
// disconnect qilinmasdan xotirada qolardi — vaqt o'tishi bilan RAM to'lib
// borishining asosiy sababi shu edi.
const restoringAccounts = new Set<string>();

// v16 FIX: sessiya BUTUNLAY o'lgan (qayta login talab qiladigan) xatolar.
// Bunday xato chiqsa — qayta-qayta ulanishga urinish MA'NOSIZ: kalit hech
// qachon o'zi tuzalmaydi, faqat Telegram serverlariga behuda so'rov
// yog'diradi va tsikl hosil qiladi (aynan shu narsa loglardagi soniyada
// bir necha marta takrorlanuvchi "Started reconnecting" yozuvlari sababi).
const FATAL_SESSION_ERRORS = /AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|USER_DEACTIVATED|USER_DEACTIVATED_BAN/;

@Injectable()
export class UserTelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('UserTelegramService');
  // v15 FIX: MTProto ulanishi tarmoq uzilishi / Telegram serverining vaqtinchalik
  // muammosi tufayli JIMGINA "o'lik" holatga tushib qolishi mumkin — bunday
  // holatda tinglovchi hech qanday xato bermaydi, lekin YANGI kiruvchi xabarlarni
  // UMUMAN qabul qilmay qo'yadi. Agent CRM'ni ochmagan payt shu holat yuz bersa,
  // o'sha vaqt oralig'ida kelgan xabarlar CRM'ga MUTLAQO kelmaydi (aynan
  // "CRM'dan chiqib ketsam xabar kelmayapti" shikoyatining asosiy sababi).
  // Shu sabab har 5 daqiqada barcha faol sessiyalarning haqiqatan tirikligini
  // tekshirib, o'lik bo'lsa avtomatik qayta ulanamiz.
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private prisma: PrismaService,
    private realtime: RealtimeGateway,
    // v14 XAVFSIZLIK: MTProto session string = parol kuchida. Bazada AES-256-GCM
    // bilan SHIFRLAB saqlaymiz. decrypt() eski shifrlanmagan sessiyalarni ham
    // (backward-compat) o'qiy oladi, shu sabab migratsiya shart emas.
    private enc: EncryptionService,
  ) {}

  async onModuleInit() {
    // Restore saved sessions on startup
    try {
      const accounts = await this.prisma.telegramAccount.findMany({
        where: { isPersonal: true, sessionData: { not: null }, isActive: true },
      });
      this.logger.log(`Restoring ${accounts.length} personal Telegram sessions...`);
      for (const acc of accounts) {
        await this.restoreSession(acc).catch(e =>
          this.logger.warn(`Session restore failed for ${acc.id}: ${e.message}`)
        );
      }
    } catch (e) {
      this.logger.warn('Could not restore sessions on init');
    }

    // v15: davriy salomatlik tekshiruvi (yuqoridagi izohga qarang)
    this.healthCheckTimer = setInterval(
      () => this.healthCheckSessions().catch((e: any) =>
        this.logger.warn(`Health-check xato: ${e?.message || e}`)),
      5 * 60 * 1000,
    );
  }

  async onModuleDestroy() {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
  }

  /**
   * v15: har bir faol (yoki faol bo'lishi kerak) shaxsiy Telegram sessiyasini
   * tekshiradi — agar xotirada yo'q yoki `isUserAuthorized()` yolg'on qaytarsa
   * (ulanish "o'lik"), DB'dagi saqlangan tokendan avtomatik qayta ulanadi.
   */
  private async healthCheckSessions() {
    const accounts = await this.prisma.telegramAccount.findMany({
      where: { isPersonal: true, sessionData: { not: null }, isActive: true },
    });
    for (const acc of accounts) {
      // v16 FIX: agar shu account uchun restoreSession() allaqachon ishlab
      // turgan bo'lsa (masalan onModuleInit hali tugamagan), qo'shimcha
      // client ochib yubormaymiz — bu RAM sizib chiqishining sababi edi.
      if (restoringAccounts.has(acc.id)) continue;

      const client = activeSessions.get(acc.id);
      let healthy = false;
      if (client) {
        healthy = await client.isUserAuthorized().catch(() => false);
      }
      if (!healthy) {
        this.logger.warn(`Shaxsiy Telegram sessiyasi (${acc.name || acc.id}) uzilgan — qayta ulanmoqda...`);
        if (client) {
          try { await client.disconnect(); } catch {}
          activeSessions.delete(acc.id);
        }
        await this.restoreSession(acc).catch((e: any) =>
          this.logger.error(`Qayta ulanish muvaffaqiyatsiz (${acc.id}): ${e?.message || e}`));
      }
    }
  }

  /**
   * v16 FIX (asosiy tuzatish): ilgari bu funksiya HAR QANDAY xatoni jimgina
   * yutib yuborardi (`catch {}`) va shu bilan chaqiruvchiga "muvaffaqiyatsiz
   * bo'ldi" deb qaytarardi — lekin AUTH_KEY_UNREGISTERED kabi FATAL xatolar
   * bilan oddiy tarmoq xatosi orasida farq qilinmasdi. Natijada:
   *   - har 5 daqiqada healthCheckSessions() qayta urinardi,
   *   - bundan tashqari gramjs'ning o'ZINING ichki autoReconnect'i
   *     (standart yoqilgan) ulanish uzilgach soniyasiga bir necha marta
   *     avtomatik qayta ulanishga urinardi — AUTH_KEY o'lik bo'lgani uchun
   *     bu urinishlar HECH QACHON muvaffaqiyatli bo'lmasdi va cheksiz
   *     tsikl (tight loop) hosil bo'lardi (loglarda ko'rilgan holat),
   *     bu esa CPU va xotirani asta-sekin band qilib borardi.
   *
   * ENDI:
   *   1) `autoReconnect: false` — gramjs o'zi ichki qayta ulanmaydi, faqat
   *      bizning 5-daqiqalik nazoratimiz (healthCheckSessions) qayta ulaydi.
   *   2) FATAL_SESSION_ERRORS aniqlansa — akkaunt darhol `isActive:false`
   *      qilib o'chiriladi (keyingi health-check'lar uni umuman
   *      ko'rmaydi — chunki so'rov `isActive:true` bilan filtrlanadi),
   *      va bu haqda agentga bildirishnoma yuboriladi (qayta login kerak).
   *   3) restoringAccounts bilan bir account uchun parallel restore
   *      urinishlarining oldi olinadi.
   */
  private async restoreSession(acc: any): Promise<TelegramClient | null> {
    if (!acc.sessionData) return null;
    if (restoringAccounts.has(acc.id)) return null;
    restoringAccounts.add(acc.id);

    let client: TelegramClient | null = null;
    try {
      const apiId = parseInt(acc.apiId || String(DEFAULT_API_ID));
      const apiHash = acc.apiHash || DEFAULT_API_HASH;
      const session = new StringSession(this.enc.decrypt(acc.sessionData) || '');
      client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 3,
        useWSS: false,
        autoReconnect: false,
      });
      await client.connect();
      if (await client.isUserAuthorized()) {
        replaceActiveSession(acc.id, client);
        this.startListening(client, acc);
        this.logger.log(`Session restored: ${acc.name || acc.phoneNumber}`);
        return client;
      }
      // Ulandi, lekin authorized emas — sessiya yaroqsiz, xuddi fatal
      // xato kabi qayta urinishni to'xtatamiz.
      await this.disableDeadSession(acc, 'Sessiya avtorizatsiyadan o\'tmadi (qayta login kerak)');
    } catch (e: any) {
      const reason = e?.errorMessage || e?.message || String(e);
      if (FATAL_SESSION_ERRORS.test(reason)) {
        this.logger.error(
          `Shaxsiy Telegram sessiyasi (${acc.name || acc.id}) BUTUNLAY o'lgan (${reason}) — qayta urinish to'xtatildi, qayta login talab qilinadi.`,
        );
        await this.disableDeadSession(acc, reason);
      } else {
        this.logger.warn(`restoreSession vaqtinchalik xato (${acc.id}): ${reason}`);
      }
      if (client) {
        try { await client.disconnect(); } catch {}
      }
    } finally {
      restoringAccounts.delete(acc.id);
    }
    return null;
  }

  /** Sessiyani butunlay o'chiradi va agentga bildirishnoma yuboradi — cheksiz retry-loop'ning oldini oladi. */
  private async disableDeadSession(acc: any, reason: string) {
    activeSessions.delete(acc.id);
    try {
      await this.prisma.telegramAccount.update({
        where: { id: acc.id },
        data: { isActive: false },
      });
    } catch (e: any) {
      this.logger.error(`disableDeadSession: DB yangilanmadi (${acc.id}): ${e?.message || e}`);
    }
    try {
      if (acc.userId) {
        this.realtime.emitToUser(acc.userId, 'telegram:session-dead', {
          accountId: acc.id,
          name: acc.name,
          reason,
          message: 'Shaxsiy Telegram sessiyangiz uzildi. Iltimos, qayta ulaning (Sozlamalar → Telegram).',
        });
      }
    } catch {}
  }

  // ─── Telegramdan profil rasmini yuklab olish va saqlash ───────────────────
  private async saveAvatar(client: TelegramClient, entity: any, key: string): Promise<string | undefined> {
    try {
      const buf = await client.downloadProfilePhoto(entity, {} as any) as Buffer;
      if (!buf || !buf.length) return undefined;

      // v12 FIX: avval rasm faylga yozilib, `${API_BASE_URL}/uploads/...jpg`
      // URL qaytarilardi. Ikki muammo bor edi:
      //   1) URL SAQLASH paytida hosil bo'lardi — API_BASE_URL o'sha paytda
      //      qo'yilmagan bo'lsa, bazaga "http://localhost:3000/..." yozilib
      //      qolar, keyin env to'g'rilansa ham eski URL o'zgarmasdi.
      //   2) Render'ning vaqtincha diskidagi fayl restartda yo'qolardi.
      // Endi rasmni to'g'ridan-to'g'ri base64 (data URL) qilib qaytaramiz —
      // hech qanday fayl/URL/env/disk kerak emas, bazada saqlanadi va hamma
      // joyda ishlaydi.
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch (e: any) {
      this.logger.warn(`saveAvatar xato (key=${key}): ${e?.message || e}`);
      return undefined;
    }
  }

  // ─── v17 FIX: KO'PLIKDAGI shaxsiy accountlar ───────────────────────────────
  // Ilgari (v14) "bitta umumiy KOMPANIYA accounti" modeli bor edi — qaysi
  // agent yubormasin, HAR DOIM eng oxirgi ulangan accountdan (createdAt
  // desc) foydalanilardi. Bu 1 ta account uchun to'g'ri ishlar edi, lekin
  // 2+ ta shaxsiy account ulanganda — ESKI accountga tegishli suhbatga
  // javob yozilganda ham tizim YANGI accountning sessiyasidan foydalanishga
  // urinardi (peer topilmaydi yoki noto'g'ri identifikatsiyadan ketadi).
  //
  // ENDI ikkita aniq holat ajratilgan:
  //   1) MAVJUD suhbatga javob → resolveAccountForConversation() — albatta
  //      o'sha KONKRET suhbatning conv.accountId'siga tegishli accountni
  //      ishlatadi, boshqasiga "sakramaydi".
  //   2) YANGI (birinchi) xabar → resolveAccountForNewMessage() — agentning
  //      User.preferredTelegramAccountId orqali DOIMIY saqlangan tanlovini
  //      ishlatadi (yoki FAQAT 1 ta account bo'lsa — orqaga mos ravishda
  //      avtomatik o'shani).
  private async getActivePersonalAccounts(tenantId: string) {
    return this.prisma.telegramAccount.findMany({
      where: { tenantId, isPersonal: true, isActive: true, sessionData: { not: null } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * MAVJUD suhbat (conversationId bor) uchun — albatta o'sha suhbatning
   * conv.accountId'siga tegishli accountni qaytaradi. Agar o'sha account
   * o'lik/uzilgan bo'lsa — aniq xato qaytariladi, BOSHQA accountga
   * almashtirilmaydi (bu aynan hal qilinishi kerak bo'lgan muammo edi).
   */
  private async resolveAccountForConversation(tenantId: string, conv: any) {
    if (conv.accountId) {
      const account = await this.prisma.telegramAccount.findFirst({
        where: { id: conv.accountId, tenantId, isPersonal: true },
      });
      if (!account) {
        throw new BadRequestException(
          "Bu suhbatga tegishli Telegram account topilmadi (o'chirilgan bo'lishi mumkin). Sozlamalar → Telegram'ni tekshiring.",
        );
      }
      if (!account.isActive || !account.sessionData) {
        throw new BadRequestException(
          `"${account.name || account.phoneNumber || 'Telegram'}" accounti uzilgan. Sozlamalar → Telegram'dan qayta ulang.`,
        );
      }
      return account;
    }

    // Orqaga moslik: eski (accountId'siz saqlangan) suhbatlar uchun — agar
    // tenant'da faqat BITTA shaxsiy account ulangan bo'lsa, avvalgidek
    // o'shani ishlatamiz (xatti-harakat o'zgarmaydi).
    const accounts = await this.getActivePersonalAccounts(tenantId);
    if (!accounts.length) return null;
    if (accounts.length === 1) return accounts[0];

    // 2+ ta account bor, lekin bu ESKI suhbat qaysiga tegishli ekani
    // noaniq — birinchi ulangan accountni ishlatamiz va DARHOL shu
    // suhbatga accountId yozib qo'yamiz, shunda bu noaniqlik keyingi
    // safar takrorlanmaydi (o'z-o'zini tuzatish).
    const fallback = accounts[0];
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: { accountId: fallback.id },
    }).catch(() => {});
    return fallback;
  }

  /**
   * YANGI (birinchi) xabar uchun — conversationId hali yo'q. Agentning
   * doimiy saqlangan tanlovi (User.preferredTelegramAccountId) yoki shu
   * chaqiruvda aniq berilgan accountId'ni ishlatadi. Agar tenant'da 2+ ta
   * FAOL account bor-u, hech qanday tanlov aniqlanmasa — aniq
   * ACCOUNT_SELECTION_REQUIRED xatosini qaytaradi (frontend buni ushlab,
   * tanlov oynasini ko'rsatadi). FAQAT 1 ta account bo'lsa — hech qanday
   * tanlov so'ralmaydi, avvalgidek avtomatik shu account ishlatiladi.
   */
  private async resolveAccountForNewMessage(tenantId: string, userId: string, requestedAccountId?: string) {
    const accounts = await this.getActivePersonalAccounts(tenantId);
    if (!accounts.length) return null;
    if (accounts.length === 1) return accounts[0];

    if (requestedAccountId) {
      const chosen = accounts.find(a => a.id === requestedAccountId);
      if (!chosen) {
        throw new BadRequestException("Tanlangan Telegram account topilmadi yoki hozir faol emas");
      }
      return chosen;
    }

    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { preferredTelegramAccountId: true } as any,
    }) as any;
    const preferred = user?.preferredTelegramAccountId
      ? accounts.find(a => a.id === user.preferredTelegramAccountId)
      : undefined;
    if (preferred) return preferred;

    throw new BadRequestException({
      statusCode: 400,
      code: 'ACCOUNT_SELECTION_REQUIRED',
      message: "Bir nechta Telegram account ulangan. Qaysi biridan foydalanishni tanlang.",
      accounts: accounts.map(a => ({ id: a.id, name: a.name, phoneNumber: a.phoneNumber })),
    });
  }

  /** Berilgan account uchun faol (yoki qayta tiklangan) TelegramClient'ni qaytaradi. */
  private async getClientForAccount(account: any): Promise<TelegramClient> {
    let client = activeSessions.get(account.id);
    if (!client || !(await client.isUserAuthorized().catch(() => false))) {
      client = (await this.restoreSession(account)) || undefined;
    }
    if (!client) {
      throw new BadRequestException(
        `"${account.name || account.phoneNumber || 'Telegram'}" sessiyasi yaroqsiz. Sozlamalar → Telegram'dan qayta ulang.`,
      );
    }
    return client;
  }

  // ─── v14: Round-robin — yangi lead'ni eng kam bandligi bor agentga berish ──
  // Ilgari shaxsiy account orqali kelgan HAR BIR suhbat account EGASIGA
  // (ya'ni admin'ga) biriktirilardi — natijada round-robin ishlamas, hamma
  // suhbat bitta odamga tushardi. Endi bot bilan bir xil round-robin.
  private async pickAgent(tenantId: string): Promise<string | null> {
    let agents = await this.prisma.user.findMany({
      where: {
        tenantId, role: { in: ['AGENT', 'MANAGER', 'TENANT_ADMIN'] }, status: 'ACTIVE',
        // v14: pauza qilingan agent (ta'til/kasal) lead OLMAYDI
        isPausedFromAssignment: false,
      },
      select: { id: true },
    });
    if (!agents.length) {
      agents = await this.prisma.user.findMany({
        where: { tenantId, role: 'TENANT_ADMIN', status: 'ACTIVE' },
        select: { id: true },
      });
    }
    if (!agents.length) return null;
    const counts = await Promise.all(
      agents.map(async (a) => ({
        id: a.id,
        cnt: await this.prisma.conversation.count({
          where: { tenantId, assignedAgentId: a.id, isResolved: false },
        }),
      })),
    );
    counts.sort((a, b) => a.cnt - b.cnt);
    return counts[0].id;
  }

  // ─── v14: Mijoz yuborgan media (ovoz/rasm/video/fayl) ni yuklab saqlash ────
  // Ilgari shaxsiy (MTProto) suhbatda KIRUVCHI xabarlar HAR DOIM `TEXT` deb
  // saqlanardi va fayl umuman yuklab olinmasdi — shu sabab mijoz yuborgan
  // OVOZLI XABAR/RASM inbox'da ko'rinmasdi ("audio kelmayapti"). Endi Bot
  // API'dagi kabi fayl yuklab olinib /uploads ichiga saqlanadi.
  private async downloadIncomingMedia(
    client: TelegramClient, msg: any, key: string,
  ): Promise<{ messageType: string; fileUrl?: string; duration?: number }> {
    let messageType = 'TEXT';
    let ext = 'bin';
    let contentType = 'application/octet-stream';
    let duration: number | undefined;
    try {
      if (msg.voice) {
        messageType = 'VOICE'; ext = 'ogg'; contentType = 'audio/ogg';
        const attr = (msg.voice.attributes || []).find(
          (a: any) => a.className === 'DocumentAttributeAudio',
        );
        duration = attr?.duration;
      } else if (msg.videoNote) {
        messageType = 'VIDEO'; ext = 'mp4'; contentType = 'video/mp4';
      } else if (msg.video || msg.gif) {
        messageType = 'VIDEO'; ext = 'mp4'; contentType = 'video/mp4';
      } else if (msg.audio) {
        messageType = 'VOICE'; ext = 'mp3'; contentType = 'audio/mpeg';
        const attr = (msg.audio.attributes || []).find(
          (a: any) => a.className === 'DocumentAttributeAudio',
        );
        duration = attr?.duration;
      } else if (msg.photo) {
        messageType = 'PHOTO'; ext = 'jpg'; contentType = 'image/jpeg';
      } else if (msg.document) {
        messageType = 'DOCUMENT';
        const nameAttr = (msg.document.attributes || []).find(
          (a: any) => a.className === 'DocumentAttributeFilename',
        );
        ext = nameAttr?.fileName?.split('.').pop() || 'bin';
        contentType = (msg.document.mimeType) || 'application/octet-stream';
      } else {
        return { messageType: 'TEXT' };
      }

      const buf = (await client.downloadMedia(msg, {} as any)) as Buffer;
      if (!buf || !buf.length) return { messageType, duration };

      // v14: kiruvchi media'ni ham Supabase'ga (doimiy, yetib boradigan URL)
      const fileUrl = await uploadBufferToStorage(buf, `tg_p_in_${key}_${Date.now()}.${ext}`, contentType);
      return { messageType, fileUrl, duration };
    } catch (e: any) {
      this.logger.warn(`downloadIncomingMedia xato (key=${key}): ${e?.message || e}`);
      return { messageType, duration };
    }
  }

  // ─── Step 1: Send auth code ──────────────────────────────────────────────
  async sendCode(tenantId: string, userId: string, data: {
    phone: string;
    apiId?: number;
    apiHash?: string;
  }) {
    const phone = data.phone.replace(/\s+/g, '').trim();
    if (!phone.startsWith('+')) throw new BadRequestException('Telefon raqami + bilan boshlanishi kerak. Masalan: +998901234567');

    const apiId = data.apiId || DEFAULT_API_ID;
    const apiHash = data.apiHash || DEFAULT_API_HASH;

    // Check if already connected
    const existing = await this.prisma.telegramAccount.findFirst({
      where: { tenantId, userId, isPersonal: true, isActive: true, phoneNumber: phone },
    });
    if (existing?.sessionData) {
      const client = await this.restoreSession(existing);
      if (client) return { status: 'already_connected', accountId: existing.id };
    }

    // Create MTProto client
    const session = new StringSession('');
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 3,
      useWSS: false,
      // v16: login oqimi qisqa umrli — o'zi avtomatik qayta ulanishiga
      // hojat yo'q, xatoni to'g'ridan-to'g'ri quyidagi catch band qiladi.
      autoReconnect: false,
    });

    try {
      await client.connect();
      const result = await client.sendCode({ apiId, apiHash }, phone) as any;
      const phoneCodeHash = result.phoneCodeHash;

      // Store pending auth
      const key = `${userId}:${phone}`;
      // XOTIRA SIZISHI TUZATILDI: agar shu kalit uchun oldingi (masalan
      // eskirgan yoki tugallanmagan) urinishdan qolgan ULANGAN client
      // bo'lsa — yangisini yozishdan oldin uni uzamiz, aks holda eski
      // ulanish hech qachon yopilmasdan xotirada osilib qolardi.
      const prevPending = pendingAuth.get(key);
      if (prevPending) {
        prevPending.client.disconnect().catch(() => {});
      }
      pendingAuth.set(key, { phoneCodeHash, client, phone, createdAt: Date.now() });

      return { status: 'code_sent', phone, message: `SMS kodi ${phone} raqamiga yuborildi` };
    } catch (e: any) {
      await client.disconnect();
      if (e.message?.includes('PHONE_NUMBER_INVALID')) throw new BadRequestException('Noto\'g\'ri telefon raqami');
      if (e.message?.includes('API_ID_INVALID')) throw new BadRequestException('Telegram API ID noto\'g\'ri. Settings\'dan API ID/Hash ni tekshiring');
      if (e.message?.includes('FLOOD_WAIT')) throw new BadRequestException('Juda ko\'p urinish. Biroz kuting');
      throw new BadRequestException(`Xato: ${e.message}`);
    }
  }

  // ─── Step 2: Verify code ─────────────────────────────────────────────────
  async verifyCode(tenantId: string, userId: string, data: {
    phone: string;
    code: string;
    apiId?: number;
    apiHash?: string;
  }) {
    const phone = data.phone.replace(/\s+/g, '').trim();
    const key = `${userId}:${phone}`;
    const pending = pendingAuth.get(key);

    if (!pending) throw new BadRequestException('Avval kod so\'rang yoki kod muddati o\'tdi');

    const apiId = data.apiId || DEFAULT_API_ID;
    const apiHash = data.apiHash || DEFAULT_API_HASH;

    try {
      const { client, phoneCodeHash } = pending;
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash,
          phoneCode: data.code.trim(),
        })
      );

      // Save session
      const sessionString = (client.session as StringSession).save();
      const me = await client.getMe() as any;

      const account = await this.prisma.telegramAccount.upsert({
        where: { id: `personal-${tenantId}-${userId}` },
        create: {
          id: `personal-${tenantId}-${userId}`,
          tenantId, userId,
          name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || phone,
          isPersonal: true,
          isActive: true,
          phoneNumber: phone,
          sessionData: this.enc.encrypt(sessionString),
          apiId: String(apiId),
          apiHash,
          channel: 'TELEGRAM',
          config: {
            username: me.username,
            firstName: me.firstName,
            lastName: me.lastName,
            telegramId: String(me.id),
          },
        },
        update: {
          name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || phone,
          isActive: true,
          sessionData: this.enc.encrypt(sessionString),
          apiId: String(apiId),
          apiHash,
          config: {
            username: me.username,
            firstName: me.firstName,
            telegramId: String(me.id),
          },
        },
      });

      replaceActiveSession(account.id, client);
      this.startListening(client, account);
      pendingAuth.delete(key);

      return {
        status: 'connected',
        accountId: account.id,
        name: account.name,
        username: (me as any).username,
        message: '✅ Shaxsiy Telegram accountingiz muvaffaqiyatli ulandi!',
      };
    } catch (e: any) {
      if (e.message?.includes('SESSION_PASSWORD_NEEDED') || e.errorMessage === 'SESSION_PASSWORD_NEEDED') {
        return { status: 'need_2fa', message: '2FA parol kerak' };
      }
      if (e.message?.includes('PHONE_CODE_INVALID')) throw new BadRequestException('Noto\'g\'ri kod. Qayta tekshiring');
      if (e.message?.includes('PHONE_CODE_EXPIRED')) throw new BadRequestException('Kod muddati o\'tdi. Qayta so\'rang');
      throw new BadRequestException(`Xato: ${e.message}`);
    }
  }

  // ─── Step 3: 2FA (optional) ──────────────────────────────────────────────
  async verify2FA(tenantId: string, userId: string, data: {
    phone: string;
    password: string;
    apiId?: number;
    apiHash?: string;
  }) {
    const phone = data.phone.replace(/\s+/g, '').trim();
    const key = `${userId}:${phone}`;
    const pending = pendingAuth.get(key);
    if (!pending) throw new BadRequestException('Avval kod so\'rang');

    const apiId = data.apiId || DEFAULT_API_ID;
    const apiHash = data.apiHash || DEFAULT_API_HASH;

    try {
      const { client } = pending;
      await client.invoke(
        new Api.account.GetPassword()
      ).then(async (pwd: any) => {
        const { computeCheck } = await import('telegram/Password');
        const inputCheck = await computeCheck(pwd, data.password);
        return client.invoke(new Api.auth.CheckPassword({ password: inputCheck }));
      });

      const sessionString = (client.session as StringSession).save();
      const me = await client.getMe() as any;

      const account = await this.prisma.telegramAccount.upsert({
        where: { id: `personal-${tenantId}-${userId}` },
        create: {
          id: `personal-${tenantId}-${userId}`,
          tenantId, userId,
          name: [me.firstName, me.lastName].filter(Boolean).join(' ') || phone,
          isPersonal: true, isActive: true, phoneNumber: phone,
          sessionData: this.enc.encrypt(sessionString), apiId: String(apiId), apiHash,
          channel: 'TELEGRAM',
          config: { username: me.username, telegramId: String(me.id) },
        },
        update: {
          isActive: true, sessionData: this.enc.encrypt(sessionString),
          name: [me.firstName, me.lastName].filter(Boolean).join(' ') || phone,
          config: { username: me.username, telegramId: String(me.id) },
        },
      });

      replaceActiveSession(account.id, client);
      this.startListening(client, account);
      pendingAuth.delete(key);

      return { status: 'connected', accountId: account.id, name: account.name };
    } catch (e: any) {
      if (e.message?.includes('PASSWORD_HASH_INVALID')) throw new BadRequestException('Parol noto\'g\'ri');
      throw new BadRequestException(`Xato: ${e.message}`);
    }
  }

  // ─── Listen incoming AND outgoing messages ──────────────────────────────
  private startListening(client: TelegramClient, acc: any) {
    try {
      client.addEventHandler(async (event: NewMessageEvent) => {
        try {
          const msg = event.message;
          if (!msg) return;

          const isOut = !!msg.out; // agent o'zi yozganmi?
          const tenantId = acc.tenantId;
          const agentId = acc.userId;
          const date = new Date((msg.date || 0) * 1000);
          const text = msg.message || '';

          // MUAMMO 1 FIX: avval INBOUND xabarlar uchun `msg.senderId` ishlatilardi —
          // bu GURUH xabarlarida XATO edi, chunki senderId xabarni YOZGAN odamning
          // ID'si, guruhning o'zi emas! Natijada guruhdagi har bir kishi bilan
          // ALOHIDA-ALOHIDA "shaxsiy suhbat" yaratilib ketardi. GramJS'ning
          // `msg.chatId` getter'i esa yo'nalishdan qat'iy nazar har doim xabar
          // tegishli bo'lgan HAQIQIY suhbatni (shaxsiy/guruh/kanal) to'g'ri beradi.
          const rawChatId = (msg as any).chatId;
          const isGroupOrChannel = !!(msg.isGroup || msg.isChannel);
          const peerId = rawChatId
            ? normalizeChatId(rawChatId.toString(), 'gramjs', isGroupOrChannel)
            : '';
          if (!peerId) return;
          // MUAMMO 2 FIX: suhbat turini ham saqlaymiz.
          const chatType = inferChatTypeFromGramjs(msg);

          if (isOut) {
            // ── Agent o'z Telegram'idan yozgan (OUTBOUND) ────────────────────
            const conv = await this.prisma.conversation.findFirst({
              where: { tenantId, channel: 'TELEGRAM', externalChatId: peerId },
            });
            if (!conv) return; // Yangi suhbat yaratmaymiz — faqat mavjudga qo'shamiz

            // Dublikat tekshirish (CRM orqali yuborilgan bo'lsa, allaqachon saqlangan)
            const dup = await this.prisma.message.findFirst({
              where: { conversationId: conv.id, externalMsgId: String(msg.id) },
            });
            if (dup) return;

            const savedOut = await this.prisma.message.create({
              data: {
                conversationId: conv.id,
                agentId,
                direction: 'OUTBOUND',
                messageType: 'TEXT',
                text,
                externalMsgId: String(msg.id),
                isDelivered: true,
                createdAt: date,
              },
              include: { agent: { select: { id: true, name: true, avatarUrl: true } } },
            });

            await this.prisma.conversation.update({
              where: { id: conv.id },
              data: {
                lastMessageAt: date, lastMessageText: text.slice(0, 200),
                // MUAMMO FIX: avvalgi shart `conv.accountId ? {} : {...}` edi —
                // ya'ni FAQAT accountId bo'sh bo'lsagina yozardi. Lekin bu
                // suhbat allaqachon Bot accountiga bog'langan bo'lsa (masalan
                // mijoz avval botga yozgan), shart har doim "bor" deb topib,
                // hech qachon o'zgartirmasdi — shuning uchun "Bot" belgisi
                // umrbod yopishib qolardi. Endi har doim shaxsiy accountga
                // ko'chiramiz, chunki hozir shu odamga aynan shaxsiy
                // accountdan yozilyapti.
                accountId: acc.id,
              },
            });

            // Real-time: boshqa tab/qurilmada ham darhol ko'rinsin
            this.realtime.emitToUser(agentId, 'message:new', savedOut);
            this.realtime.emitConversationEvent(tenantId, agentId, 'conversation:updated', {
              conversationId: conv.id, lastMessageText: text.slice(0, 200), lastMessageAt: date,
            });
            return;
          }

          // ── Kiruvchi xabar (INBOUND) ──────────────────────────────────────
          this.logger.log(`Personal incoming: ${peerId} → "${text.slice(0, 50)}"`);

          // Get sender info
          let firstName = '';
          let lastName = '';
          let username = '';
          try {
            const sender = await msg.getSender() as any;
            firstName = sender?.firstName || sender?.title || '';
            lastName = sender?.lastName || '';
            username = sender?.username || '';
          } catch {}

          // Find or create conversation
          let conv = await this.prisma.conversation.findFirst({
            where: { tenantId, channel: 'TELEGRAM', externalChatId: peerId },
          });

          // MUAMMO 1 FIX: bu yerda avval hech qanday dublikat tekshiruvi yo'q edi
          // (faqat OUTBOUND tarmoqda bor edi) — shu sabab bitta xabar bir necha
          // marta ushlab qolinsa (masalan qayta ulanishda), har safar YANGI
          // Message yozuvi yaratilib, chatda takrorlanib chiqardi.
          if (conv) {
            const dup = await this.prisma.message.findFirst({
              where: { conversationId: conv.id, externalMsgId: String(msg.id) },
            });
            if (dup) return;
          }

          // Telegramdan profil rasmini yuklab olamiz
          let avatarUrl: string | undefined;
          // v12: rasm yo'q BO'LSA yoki eski (localhost/http) URL bo'lsa qayta
          // yuklaymiz — shunda eski buzuq URL'lar avtomat base64'ga almashadi.
          if (!conv || !conv.avatarUrl || !String(conv.avatarUrl).startsWith('data:')) {
            try {
              const sender = await msg.getSender();
              avatarUrl = await this.saveAvatar(client, sender, peerId);
            } catch {}
          }

          // v14: mijoz yuborgan media (ovoz/rasm/video/fayl) ni yuklab olamiz.
          const media = await this.downloadIncomingMedia(client, msg, peerId);
          const mediaType = media.messageType; // 'TEXT' | 'VOICE' | 'PHOTO' | ...
          const mediaLabel: Record<string, string> = {
            VOICE: '🎤 Ovozli xabar', PHOTO: '📷 Rasm', VIDEO: '🎥 Video', DOCUMENT: '📎 Fayl',
          };
          const previewText = (text || mediaLabel[mediaType] || '').slice(0, 200);

          {
            // v14: mijozni CRM'dagi klient bilan bog'lash (username orqali)
            let clientId: string | null = null;
            let clientAgentId: string | null = null;
            if (username) {
              const cl = await this.prisma.client.findFirst({
                where: { tenantId, telegramUsername: username } as any,
                select: { id: true, assignedAgentId: true },
              }).catch(() => null);
              if (cl) { clientId = cl.id; clientAgentId = cl.assignedAgentId; }
            }

            // v: PER_AGENT rejimida — bu account biror agentning ShAXSIY
            // raqami (acc.userId bor). Klient AYNAN o'sha agentning raqamiga
            // yozgan, shuning uchun kiruvchi xabar to'g'ridan-to'g'ri o'sha
            // agentga tegishli bo'lishi kerak — round-robin BUTUNLAY
            // ARALASHMASLIGI kerak (aks holda klient agent-A ning raqamiga
            // yozgan bo'lsa ham, xabar tasodifan agent-B'ga yoki hatto
            // admin'ga tushib qolardi — "agent xabar yozsa/kelsa o'zida
            // ko'rinmayapti, adminga tushyapti" degan xato aynan shundan).
            // SHARED rejimida (bitta umumiy company account) bu tekshiruv
            // ishlamaydi — u yerda avvalgi round-robin xatti-harakati
            // o'zgarishsiz qoladi.
            let isPerAgentOwnAccount = false;
            if (acc.userId) {
              const tenantForMode = await this.prisma.tenant.findUnique({
                where: { id: tenantId },
                select: { settings: true },
              });
              const mode = (tenantForMode?.settings as any)?.telegramMode;
              isPerAgentOwnAccount = mode === 'PER_AGENT';
            }

            // v14 ROUND-ROBIN + IZOLYATSIYA: yangi suhbat kimga biriktiriladi?
            //  1) Mavjud suhbat allaqachon biriktirilgan bo'lsa — o'zgarmaydi.
            //  2) Mijoz CRM'da allaqachon biror agentga biriktirilgan bo'lsa —
            //     o'sha agentga (mijoz doim bitta agent bilan gaplashadi).
            //  3) PER_AGENT rejimida — bu SHAXSIY raqamning egasiga.
            //  4) Aks holda round-robin — eng kam bandligi bor agentga.
            const assignAgentId = conv?.assignedAgentId
              || clientAgentId
              || (isPerAgentOwnAccount ? acc.userId : null)
              || await this.pickAgent(tenantId);

            // MUAMMO FIX (dublikat suhbatlar): atomik upsert.
            conv = await this.prisma.conversation.upsert({
              where: {
                tenantId_channel_externalChatId: { tenantId, channel: 'TELEGRAM', externalChatId: peerId },
              },
              create: {
                tenantId, accountId: acc.id, clientId,
                assignedAgentId: assignAgentId, channel: 'TELEGRAM',
                externalChatId: peerId, firstName, lastName, username, avatarUrl,
                lastMessageAt: date, lastMessageText: previewText,
                lastMessageType: mediaType as any,
                chatType,
                // v14: yangi kiruvchi xabar — o'qilmagan deb belgilanadi
                unreadCount: 1,
                isResolved: false,
              } as any,
              update: {
                lastMessageAt: date, lastMessageText: previewText,
                lastMessageType: mediaType as any,
                firstName: conv?.firstName || firstName,
                lastName: conv?.lastName || lastName,
                username: conv?.username || username,
                chatType: (conv as any)?.chatType || chatType,
                clientId: conv?.clientId || clientId,
                assignedAgentId: conv?.assignedAgentId || assignAgentId,
                ...(avatarUrl ? { avatarUrl } : {}),
                accountId: acc.id,
                // v14: o'qildi/o'qilmadi — kiruvchi xabar sonini oshiramiz
                unreadCount: { increment: 1 },
                isResolved: false,
              } as any,
            });
          }

          // v12 DUBLIKAT FIX: bir xil Telegram accounti bir necha marta ulangan
          // bo'lsa (yoki listener ikki marta ishga tushsa), AYNAN bir xabar ikki
          // marta kelib, ikki marta saqlanardi. Endi (conversationId + Telegram
          // msg.id) bo'yicha allaqachon saqlangan bo'lsa — o'tkazib yuboramiz.
          const tgMsgId = String(msg.id || '');
          if (tgMsgId) {
            const already = await this.prisma.message.findFirst({
              where: { conversationId: conv.id, externalMsgId: tgMsgId, direction: 'INBOUND' },
              select: { id: true },
            });
            if (already) return;
          }

          const savedMsg = await this.prisma.message.create({
            data: {
              conversationId: conv.id,
              direction: 'INBOUND',
              // v14: endi haqiqiy tur (VOICE/PHOTO/VIDEO/DOCUMENT) va fayl saqlanadi
              messageType: mediaType as any,
              text: text || null,
              fileUrl: media.fileUrl,
              duration: media.duration,
              externalMsgId: tgMsgId || String(Date.now()),
              isDelivered: true, createdAt: date,
            },
          });

          // v14: real-time xabar account EGASIGA emas, BIRIKTIRILGAN agentga
          // (+admin/manager) boradi — round-robin natijasida boshqa agent bo'lishi mumkin.
          this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId, 'message:new', savedMsg);
          this.realtime.emitToConversation(conv.id, 'message:new', savedMsg);
          this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId || agentId, 'conversation:updated', {
            conversationId: conv.id,
            lastMessageText: previewText,
            lastMessageAt: date,
          });
        } catch (e: any) {
          this.logger.warn('Personal incoming handler error: ' + e.message);
        }
        // MUAMMO FIX: avval `{ incoming: true }` berilgan edi. GramJS buni
        // ichkarida `outgoing = false` deb talqin qiladi (events/NewMessage.js
        // manbasida ko'rish mumkin), shu sabab agent shu Telegram accountidan
        // TO'G'RIDAN-TO'G'RI (CRM'siz) yozgan xabarlari BU HANDLER'GA UMUMAN
        // YETIB KELMASDI — yuqoridagi "isOut" bo'limi yozilgan bo'lsa ham hech
        // qachon ishlamasdi. Natijada bunday xabarlar CRM'da ko'rinmasdi yoki
        // (agar boshqa yo'l bilan sinxronlansa) xuddi mijoz yozganday bir xil
        // (kulrang) rangda chiqardi. Filtrni olib tashlab, ikkala yo'nalishni
        // ham ushlaymiz — pastdagi isOut tekshiruvi endi ishga tushadi.
      }, new NewMessage({}));

      // v15: XOM (raw) update'larni ham tinglaymiz — bular NewMessage
      // filtridan o'tmaydi, lekin "o'qildi" va "onlayn/oflayn" holatini
      // aynan shular orqali bilib olamiz:
      //   • UpdateReadHistoryOutbox — suhbatdosh BIZNING xabarimizni
      //     qaysi ID'gacha o'qiganini bildiradi (haqiqiy "✓✓ o'qildi").
      //   • UpdateUserStatus — foydalanuvchi onlayn/oflayn bo'lganda keladi.
      // eventBuilder berilmasa, GramJS callback'ga har bir XOM Update
      // obyektini (filtrsiz) uzatadi.
      client.addEventHandler(async (update: any) => {
        this.handleRawUpdate(update, acc).catch((e: any) =>
          this.logger.warn(`handleRawUpdate xato: ${e?.message || e}`));
      });
    } catch (e: any) {
      this.logger.warn('startListening error: ' + e.message);
    }
  }

  /**
   * v15: "o'qildi" (read receipt) va onlayn/oflayn holatini real vaqtda
   * ushlab, CRM'ga socket orqali jonli yetkazadi.
   */
  private async handleRawUpdate(update: any, acc: any) {
    if (!update?.className) return;
    const tenantId = acc.tenantId;

    if (update.className === 'UpdateReadHistoryOutbox') {
      const peer = update.peer;
      const isGroupOrChannel = peer?.className === 'PeerChat' || peer?.className === 'PeerChannel';
      const rawId = peer?.userId ?? peer?.chatId ?? peer?.channelId;
      if (rawId === undefined || rawId === null) return;
      const chatId = normalizeChatId(String(rawId), 'gramjs', isGroupOrChannel);

      const conv = await this.prisma.conversation.findFirst({
        where: { tenantId, channel: 'TELEGRAM', externalChatId: chatId },
      });
      if (!conv) return;

      const maxId = Number(update.maxId) || 0;
      if (!maxId) return;

      // Faqat shu suhbatning hali "o'qilmagan" deb belgilangan OUTBOUND
      // xabarlaridan maxId'gacha bo'lganlarini "o'qildi" qilamiz.
      const candidates = await this.prisma.message.findMany({
        where: { conversationId: conv.id, direction: 'OUTBOUND', isRead: false, externalMsgId: { not: null } },
        select: { id: true, externalMsgId: true },
      });
      const toMark = candidates
        .filter((m) => {
          const n = Number(m.externalMsgId);
          return Number.isFinite(n) && n <= maxId;
        })
        .map((m) => m.id);
      if (!toMark.length) return;

      await this.prisma.message.updateMany({ where: { id: { in: toMark } }, data: { isRead: true } });

      const payload = { conversationId: conv.id, messageIds: toMark };
      this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId, 'message:read', payload);
      this.realtime.emitToConversation(conv.id, 'message:read', payload);
      return;
    }

    if (update.className === 'UpdateUserStatus') {
      const uid = update.userId !== undefined && update.userId !== null ? String(update.userId) : '';
      if (!uid) return;
      const status = update.status;
      let isOnline = false;
      let lastSeenAt: string | null = null;
      if (status?.className === 'UserStatusOnline') {
        isOnline = true;
      } else if (status?.className === 'UserStatusOffline') {
        lastSeenAt = status.wasOnline ? new Date(status.wasOnline * 1000).toISOString() : null;
      } else {
        // UserStatusRecently / LastWeek / LastMonth / Empty — aniq vaqt yo'q
        return;
      }

      const conv = await this.prisma.conversation.findFirst({
        where: { tenantId, channel: 'TELEGRAM', externalChatId: uid, chatType: 'private' } as any,
      });
      if (!conv) return;

      const payload = { conversationId: conv.id, isOnline, lastSeenAt };
      this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId, 'user:online', payload);
      this.realtime.emitToConversation(conv.id, 'user:online', payload);
    }
  }

  /**
   * v15: suhbat ochilganda boshlang'ich onlayn/oflayn holatini olish uchun
   * (keyingi o'zgarishlar `UpdateUserStatus` orqali jonli — socket'da keladi).
   * Faqat shaxsiy (private) suhbatlar uchun ma'noli — guruh/kanalda "onlayn"
   * tushunchasi yo'q.
   */
  async getPeerStatus(tenantId: string, conversationId: string): Promise<{ isOnline: boolean; lastSeenAt: string | null }> {
    const conv = await this.prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');
    if ((conv as any).chatType && (conv as any).chatType !== 'private') {
      return { isOnline: false, lastSeenAt: null };
    }

    let account: any;
    try {
      account = await this.resolveAccountForConversation(tenantId, conv);
    } catch {
      return { isOnline: false, lastSeenAt: null };
    }
    if (!account) return { isOnline: false, lastSeenAt: null };

    let client: TelegramClient;
    try {
      client = await this.getClientForAccount(account);
    } catch {
      return { isOnline: false, lastSeenAt: null };
    }

    try {
      const entity: any = await client.getEntity(conv.externalChatId);
      const status = entity?.status;
      if (status?.className === 'UserStatusOnline') return { isOnline: true, lastSeenAt: null };
      if (status?.className === 'UserStatusOffline') {
        return { isOnline: false, lastSeenAt: status.wasOnline ? new Date(status.wasOnline * 1000).toISOString() : null };
      }
      return { isOnline: false, lastSeenAt: null };
    } catch (e: any) {
      this.logger.warn(`getPeerStatus xato (conv=${conversationId}): ${e?.message || e}`);
      return { isOnline: false, lastSeenAt: null };
    }
  }

  // ─── Send message via personal account ───────────────────────────────────
  async sendPersonalMessage(tenantId: string, agentId: string, data: {
    phone?: string;
    username?: string;
    userId?: string; // Telegram user ID
    conversationId?: string; // Mavjud suhbatga yozayotgan bo'lsak — shu orqali yangi dublikat suhbat yaratilmaydi
    text: string;
    clientId?: string;
    accountId?: string; // v17: yangi suhbat uchun aniq tanlangan shaxsiy account (2+ ta ulangan bo'lsa)
  }) {
    if (!data.text?.trim()) throw new BadRequestException('Xabar matni kerak');
    if (!data.phone && !data.username && !data.userId && !data.conversationId) {
      throw new BadRequestException('Telefon raqami, username, Telegram ID yoki suhbat kerak');
    }

    // v17 FIX: avval har doim "eng oxirgi ulangan" (umumiy) account
    // ishlatilardi — endi MAVJUD suhbatga aynan o'sha suhbatga tegishli
    // account, YANGI suhbatga esa agentning tanlovi (yoki yagona account)
    // ishlatiladi. Suhbat oldindan bir marta topib olinadi — pastda qayta
    // so'ralmaydi.
    let existingConv: any = null;
    let account: any;
    if (data.conversationId) {
      existingConv = await this.prisma.conversation.findFirst({
        where: { id: data.conversationId, tenantId },
      });
      if (!existingConv) throw new NotFoundException('Suhbat topilmadi');
      account = await this.resolveAccountForConversation(tenantId, existingConv);
    } else {
      account = await this.resolveAccountForNewMessage(tenantId, agentId, data.accountId);
    }
    if (!account) {
      throw new BadRequestException(
        'Shaxsiy Telegram account ulanmagan. Admin: Settings → Telegram bo\'limidan ulasin.'
      );
    }

    // Get or restore client session
    const client = await this.getClientForAccount(account);

    try {
      let peer: any;

      // Agar mavjud suhbatga yozayotgan bo'lsak — peer'ni o'sha suhbatning
      // saqlangan externalChatId'sidan olamiz. Bu yangi/dublikat suhbat
      // yaratilib, agentning yozgan xabari "yo'qolib qolish" muammosining oldini oladi.
      if (existingConv) {
        peer = await client.getInputEntity(existingConv.externalChatId);
      } else if (data.username) {
        peer = await client.getInputEntity(data.username.startsWith('@') ? data.username : `@${data.username}`);
      } else if (data.phone) {
        // Import contact first to be able to send
        const phone = data.phone.replace(/\s+/g, '');
        try {
          await client.invoke(new Api.contacts.ImportContacts({
            contacts: [new Api.InputPhoneContact({
              clientId: BigInt(Date.now()) as any,
              phone,
              firstName: 'Client',
              lastName: '',
            })],
          }));
          peer = await client.getInputEntity(phone);
        } catch {
          // Try direct phone lookup
          peer = phone;
        }
      } else if (data.userId) {
        peer = await client.getInputEntity(data.userId);
      }

      // Send message
      const sent = await client.sendMessage(peer, { message: data.text });

      let conv = existingConv;
      if (!conv) {
        let chat: any = null;
        let externalChatId: string;
        try {
          chat = await client.getEntity(peer) as any;
          // For user chats: use the user's Telegram ID
          externalChatId = String(chat.id);
        } catch {
          // Fallback: extract from sent message
          const peerId = (sent as any).peerId;
          externalChatId = String(peerId?.userId || peerId?.chatId || peerId?.channelId || Date.now());
        }

        // Save to DB as conversation — lekin avval shu externalChatId bilan
        // mavjud suhbat bormi tekshiramiz (qayta dublikat yaratmaslik uchun)
        conv = await this.prisma.conversation.findFirst({
          where: { tenantId, channel: 'TELEGRAM', externalChatId },
        });

        let avatarUrl: string | undefined;
        if (!conv || !conv.avatarUrl || !String(conv.avatarUrl).startsWith('data:')) {
          avatarUrl = await this.saveAvatar(client, chat || peer, externalChatId);
        }

        if (!conv) {
          conv = await this.prisma.conversation.create({
            data: {
              tenantId,
              accountId: account.id,
              clientId: data.clientId || null,
              assignedAgentId: agentId,
              channel: 'TELEGRAM',
              externalChatId,
              firstName: chat?.firstName || chat?.username || data.username || data.phone || '',
              lastName: chat?.lastName || '',
              username: chat?.username || (data.username ? data.username.replace('@','') : ''),
              avatarUrl,
              lastMessageAt: new Date(),
              lastMessageText: data.text.slice(0, 200),
            },
          });
        } else {
          conv = await this.prisma.conversation.update({
            where: { id: conv.id },
            data: {
              lastMessageAt: new Date(),
              lastMessageText: data.text.slice(0, 200),
              clientId: conv.clientId || data.clientId || null,
              assignedAgentId: conv.assignedAgentId || agentId,
              ...(avatarUrl ? { avatarUrl } : {}),
              // MUAMMO FIX: avvalgi shart `conv.accountId ? {} : {...}` faqat
              // accountId bo'sh bo'lsagina yozardi — Bot-akkauntga bog'langan
              // eski suhbat bo'lsa hech qachon o'zgarmasdi. Endi har doim
              // shaxsiy accountga ko'chiramiz, chunki hozir CRM orqali shu
              // odamga aynan shaxsiy accountdan yozilyapti.
              accountId: account.id,
            },
          });
        }
      } else {
        conv = await this.prisma.conversation.update({
          where: { id: conv.id },
          data: {
            lastMessageAt: new Date(),
            lastMessageText: data.text.slice(0, 200),
            clientId: conv.clientId || data.clientId || null,
            // MUAMMO FIX: xuddi yuqoridagidek — endi har doim yangilanadi.
            accountId: account.id,
          },
        });
      }

      // Save message
      const savedMsg = await this.prisma.message.create({
        data: {
          conversationId: conv.id,
          agentId,
          direction: 'OUTBOUND',
          messageType: 'TEXT',
          text: data.text,
          externalMsgId: String((sent as any).id || Date.now()),
          isDelivered: true,
        },
        include: { agent: { select: { id: true, name: true, avatarUrl: true } } },
      });

      // Refresh qilmasdan darhol ko'rinishi uchun — barcha ulangan
      // sessiyalarga (boshqa tab/qurilma) ham real xabarni yuboramiz.
      // v10 MUAMMO 4 FIX: tenant-keng emas, faqat tegishlilarga.
      this.realtime.emitToUser(agentId, 'message:new', savedMsg);
      this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId || agentId, 'conversation:updated', {
        conversationId: conv.id,
        lastMessageText: data.text.slice(0, 200),
        lastMessageAt: new Date(),
      });

      return { ok: true, conversationId: conv.id, message: savedMsg };
    } catch (e: any) {
      if (e.message?.includes('USERNAME_NOT_OCCUPIED')) throw new BadRequestException('Bu username topilmadi');
      if (e.message?.includes('PEER_ID_INVALID')) throw new BadRequestException('Foydalanuvchi topilmadi');
      if (e.message?.includes('USER_PRIVACY_RESTRICTED')) {
        throw new BadRequestException(
          'Foydalanuvchi maxfiylik sozlamasi tufayli siz bilan bog\'lana olmaydi. ' +
          'Ular avval sizga yozishi kerak yoki umumiy guruhda bo\'lishlari kerak.'
        );
      }
      throw new BadRequestException(`Xato: ${e.message}`);
    }
  }

  // ─── Tizim tomonidan avtomatik yuboriladigan xabarlar ───────────────────
  // (masalan: booking uchish sanasidan 2 kun oldin eslatma). Hech qanday
  // agent aralashuvisiz ishlaydi — shuning uchun agentId talab qilinmaydi
  // va xabar hech kimga "biriktirilmaydi" (agentId=null, tizim xabari).
  // Faqat MAVJUD suhbatga (conversationId) yoziladi — yangi suhbat
  // yaratilmaydi, chunki mijoz avval yozgan/yozilgan bo'lishi shart.
  async sendSystemMessage(tenantId: string, conversationId: string, text: string) {
    if (!text?.trim()) throw new BadRequestException('Xabar matni kerak');

    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');

    const account = await this.resolveAccountForConversation(tenantId, conv);
    if (!account) {
      throw new BadRequestException('Shaxsiy Telegram account ulanmagan');
    }

    const client = await this.getClientForAccount(account);

    const peer = await client.getInputEntity(conv.externalChatId);
    const sent = await client.sendMessage(peer, { message: text });

    const updatedConv = await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: new Date(),
        lastMessageText: text.slice(0, 200),
        accountId: account.id,
      },
    });

    const savedMsg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        agentId: null,
        direction: 'OUTBOUND',
        messageType: 'TEXT',
        text,
        externalMsgId: String((sent as any).id || Date.now()),
        isDelivered: true,
      },
    });

    try {
      this.realtime.emitToConversation(conv.id, 'message:new', savedMsg);
      this.realtime.emitConversationEvent(tenantId, updatedConv.assignedAgentId, 'conversation:updated', {
        conversationId: conv.id,
        lastMessageText: text.slice(0, 200),
        lastMessageAt: new Date(),
      });
    } catch {}

    return { ok: true, conversationId: conv.id, message: savedMsg };
  }

  // ─── v11 FIX (davomi): Media/fayl yuborish (shaxsiy akkaunt orqali) ──────
  // Shablonga biriktirilgan rasm/fayl endi faqat caption-matn sifatida emas,
  // HAQIQIY fayl sifatida (MTProto orqali) yuboriladi — xuddi bot orqali
  // yuborilgandagidek.
  private async sendPersonalMedia(
    tenantId: string, agentId: string, conversationId: string,
    fileUrl: string, caption?: string, mediaType?: string,
  ) {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, tenantId },
    });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');

    // v17 FIX: bu MAVJUD suhbatga tegishli — endi tenant'dagi "umumiy" emas,
    // aynan shu suhbatning conv.accountId'siga tegishli accountdan yuboradi.
    const account = await this.resolveAccountForConversation(tenantId, conv);
    if (!account) throw new BadRequestException('Shaxsiy Telegram account ulanmagan');

    const client = await this.getClientForAccount(account);

    const peer = await client.getInputEntity(conv.externalChatId);

    // Faylni URL'dan yuklab olamiz, so'ng Telegramga o'zimiz jo'natamiz
    const axios = require('axios');
    const resp = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const buf = Buffer.from(resp.data);
    let fileName = fileUrl.split('/').pop()?.split('?')[0] || `file_${Date.now()}`;
    const isImage = mediaType === 'photo' || !!fileName.match(/\.(jpg|jpeg|png|gif|webp)$/i);
    // v14: OVOZLI XABAR — inboxda mikrofonda yozilgani (audio/webm|ogg). Telegramga
    // "voice note" sifatida yuborishga urinamiz; format qabul qilinmasa — oddiy
    // audio fayl sifatida yuboramiz (baribir eshitiladi).
    const isVoice = mediaType === 'voice' || !!fileName.match(/\.(ogg|oga|webm|mp3|m4a|wav|aac)$/i);

    // v14 FIX: URL'da kengaytma bo'lmasa (Supabase path), Telegram rasm/ovozni
    // TANIY OLMAY hujjat qilib yuborardi ("OPEN WITH" / "unnamed"). Endi mos
    // kengaytmani majburan qo'shamiz — shunda rasm rasm, ovoz ovoz bo'ladi.
    if (isImage && !/\.(jpg|jpeg|png|gif|webp)$/i.test(fileName)) fileName += '.jpg';
    if (isVoice && !/\.(ogg|oga|mp3|m4a|wav|webm|aac)$/i.test(fileName)) fileName += '.ogg';

    // v14 FIX: Chrome mikrofonda webm/opus yozadi — Telegram voice note esa
    // ogg/opus xohlaydi. webm bo'lsa Telegram uni HUJJAT qilib yuborardi
    // ("unnamed.webm papka"). Shu sabab avval ogg/opus'ga o'giramiz — endi
    // xuddi Telegramникidek yumaloq voice note bo'lib boradi.
    let voiceBuf = buf;
    let voiceOk = false;
    if (isVoice) {
      const inExt = (fileName.split('.').pop() || 'webm').toLowerCase();
      if (inExt === 'ogg' || inExt === 'oga') {
        voiceOk = true; // allaqachon ogg — o'girish shart emas
      } else {
        const converted = await toOggOpus(buf, inExt);
        if (converted) { voiceBuf = converted; voiceOk = true; fileName = fileName.replace(/\.[^.]+$/, '') + '.ogg'; }
      }
    }

    // v14 FIX: Buffer to'g'ridan-to'g'ri berilsa GramJS uni HUJJAT deb yuboradi.
    // CustomFile (nom + kengaytma bilan) bersak — Telegram turini to'g'ri
    // aniqlaydi (rasm = <img>, ovoz = voice note).
    let CustomFile: any;
    try { ({ CustomFile } = require('telegram/client/uploads')); } catch {}
    const sendBuf = isVoice ? voiceBuf : buf;
    const toSend = CustomFile ? new CustomFile(fileName, sendBuf.length, '', sendBuf) : sendBuf;

    let sent: any;
    let finalType: 'VOICE' | 'PHOTO' | 'VIDEO' | 'DOCUMENT' =
      isVoice ? 'VOICE' : isImage ? 'PHOTO' : 'DOCUMENT';

    try {
      if (isVoice && voiceOk) {
        // Haqiqiy ogg/opus voice note
        sent = await client.sendFile(peer, {
          file: toSend,
          caption: caption || '',
          voiceNote: true,
          workers: 1,
        } as any);
      } else if (isVoice) {
        // Konvertatsiya bo'lmadi (ffmpeg yo'q) — hech bo'lmasa eshitiladigan
        // audio fayl sifatida yuboramiz (voice bubble bo'lmasligi mumkin).
        sent = await client.sendFile(peer, {
          file: toSend,
          caption: caption || '',
          voiceNote: true,
          workers: 1,
        } as any);
      } else if (isImage) {
        // forceDocument: false + rasm kengaytmasi → Telegram RASM sifatida ko'rsatadi
        sent = await client.sendFile(peer, {
          file: toSend,
          caption: caption || '',
          forceDocument: false,
          workers: 1,
        } as any);
      } else {
        sent = await client.sendFile(peer, {
          file: toSend,
          caption: caption || '',
          forceDocument: true,
          workers: 1,
          attributes: [{ className: 'DocumentAttributeFilename', fileName }] as any,
        } as any);
      }
    } catch (e: any) {
      // Voice note formatida rad etilsa — oddiy audio fayl sifatida qayta yuboramiz
      if (isVoice) {
        this.logger.warn('Voice note yuborilmadi, oddiy audio sifatida urinilyapti: ' + e?.message);
        sent = await client.sendFile(peer, {
          file: toSend,
          caption: caption || '',
          forceDocument: false,
          workers: 1,
          attributes: [{ className: 'DocumentAttributeFilename', fileName }] as any,
        } as any);
        finalType = 'VOICE';
      } else {
        throw e;
      }
    }

    const label = { VOICE: '🎤 Ovozli xabar', PHOTO: '📷 Rasm', VIDEO: '🎥 Video', DOCUMENT: '📎 Fayl' }[finalType];

    const savedMsg = await this.prisma.message.create({
      data: {
        conversationId: conv.id,
        agentId,
        direction: 'OUTBOUND',
        messageType: finalType as any,
        text: caption || '',
        fileUrl,
        externalMsgId: String((sent as any).id || Date.now()),
        isDelivered: true,
      } as any,
      include: { agent: { select: { id: true, name: true, avatarUrl: true } } },
    });

    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        lastMessageAt: new Date(),
        lastMessageText: caption?.slice(0, 200) || label,
        lastMessageType: finalType as any,
        accountId: account.id,
      },
    });

    // v14: biriktirilgan agentga (+admin) — account egasiga emas
    this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId || agentId, 'message:new', savedMsg);
    this.realtime.emitToConversation(conv.id, 'message:new', savedMsg);
    this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId || agentId, 'conversation:updated', {
      conversationId: conv.id,
      lastMessageText: caption?.slice(0, 200) || label,
      lastMessageAt: new Date(),
    });

    return savedMsg;
  }

  // Public wrapper — controller orqali chaqiriladi (masalan "Rasm"/"Ovozli xabar" tugmasi)
  async sendMedia(tenantId: string, agentId: string, conversationId: string, fileUrl: string, caption?: string, mediaType?: string) {
    return this.sendPersonalMedia(tenantId, agentId, conversationId, fileUrl, caption, mediaType);
  }

  // v14: TAKLIF uchun — bir nechta rasmni BITTA ALBOM (media group) qilib yuboramiz,
  // caption (taklif matni) birinchi rasmга yoziladi. Shunda "hammasi bitta xabarda",
  // rasmlar esa Telegram avtomatik flexible grid qilib joylashtiradi.
  async sendMediaGroup(tenantId: string, agentId: string, conversationId: string, photoUrls: string[], caption?: string) {
    const conv = await this.prisma.conversation.findFirst({ where: { id: conversationId, tenantId } });
    if (!conv) throw new NotFoundException('Suhbat topilmadi');
    const account = await this.resolveAccountForConversation(tenantId, conv);
    if (!account) throw new BadRequestException('Shaxsiy Telegram account ulanmagan');

    const client = await this.getClientForAccount(account);
    const peer = await client.getInputEntity(conv.externalChatId);

    const axios = require('axios');
    let CustomFile: any;
    try { ({ CustomFile } = require('telegram/client/uploads')); } catch {}

    const files: any[] = [];
    for (const url of photoUrls.slice(0, 10)) {
      try {
        const resp = await axios.get(url, { responseType: 'arraybuffer' });
        const buf = Buffer.from(resp.data);
        let name = url.split('/').pop()?.split('?')[0] || `p_${Date.now()}.jpg`;
        if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(name)) name += '.jpg';
        files.push(CustomFile ? new CustomFile(name, buf.length, '', buf) : buf);
      } catch (e: any) {
        this.logger.warn(`Albom rasmi yuklab olinmadi (${url}): ${e?.message || e}`);
      }
    }
    if (!files.length) return null;

    const cap = (caption || '').slice(0, 1024); // Telegram caption limiti
    // GramJS: file = massiv → ALBOM. caption birinchi elementга yoziladi.
    const sent = await client.sendFile(peer, {
      file: files,
      caption: cap,
      forceDocument: false,
      workers: 1,
    } as any);

    const savedMsg = await this.prisma.message.create({
      data: {
        conversationId: conv.id, agentId,
        direction: 'OUTBOUND', messageType: 'PHOTO' as any,
        text: caption || '',
        fileUrl: photoUrls[0],
        externalMsgId: String(Date.now()),
        isDelivered: true,
      } as any,
      include: { agent: { select: { id: true, name: true, avatarUrl: true } } },
    });
    await this.prisma.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: new Date(), lastMessageText: (caption || '📷 Rasmlar').slice(0, 200), lastMessageType: 'PHOTO' as any, accountId: account.id },
    });
    this.realtime.emitConversationEvent(tenantId, conv.assignedAgentId || agentId, 'message:new', savedMsg);
    this.realtime.emitToConversation(conv.id, 'message:new', savedMsg);
    return savedMsg;
  }

  // ─── v11 FIX: Shablon yuborish (shaxsiy akkaunt orqali) ──────────────────
  // Ilgari "Shablon" tugmasi shaxsiy (isPersonal) suhbatlarda ham har doim
  // BOT endpointiga (`/telegram/conversations/:id/template/:id`) yuborardi —
  // bu shaxsiy akkauntga tegishli emas edi, shu sabab xabar hech qachon
  // to'g'ri yetkazilmas yoki socket orqali darhol ko'rinmas edi (faqat
  // sahifani qayta yuklaganda — "restart" qilinganda — bazadan tasodifan
  // ko'rinib qolishi mumkin edi). Endi shaxsiy suhbatlar uchun MTProto
  // orqali to'g'ridan-to'g'ri shu yerdan yuboriladi.
  async sendTemplate(tenantId: string, agentId: string, conversationId: string, templateId: string) {
    const template = await this.prisma.messageTemplate.findFirst({
      where: { id: templateId, tenantId, isActive: true } as any,
    });
    if (!template) throw new NotFoundException('Shablon topilmadi');

    await this.prisma.messageTemplate.update({
      where: { id: templateId },
      data: { useCount: { increment: 1 } } as any,
    }).catch(swallow('yangilash'));

    const sent: any[] = [];

    if ((template as any).text?.trim()) {
      const r = await this.sendPersonalMessage(tenantId, agentId, {
        conversationId,
        text: (template as any).text,
      });
      if (r?.message) sent.push(r.message);
    }

    const mediaItems = [
      ...((template as any).mediaUrl ? [{ url: (template as any).mediaUrl, caption: (template as any).mediaCaption || '' }] : []),
      ...((Array.isArray((template as any).attachments) ? (template as any).attachments : []) as any[])
        .filter((a: any) => a?.url)
        .map((a: any) => ({ url: a.url, caption: a.caption || '' })),
    ];

    for (const item of mediaItems) {
      try {
        const savedMsg = await this.sendPersonalMedia(tenantId, agentId, conversationId, item.url, item.caption);
        sent.push(savedMsg);
      } catch (e: any) {
        this.logger.warn('Shaxsiy shablon media yuborilmadi: ' + e?.message);
      }
    }

    return { sent: sent.length, messages: sent };
  }

  // ─── v17: Ko'plikdagi accountlar — tanlov uchun ro'yxat va agent tanlovi ──

  /** Tenant'dagi barcha FAOL shaxsiy accountlar (tanlov oynasi/dropdown uchun). */
  async listAccountsForSelection(tenantId: string) {
    const accounts = await this.getActivePersonalAccounts(tenantId);
    return accounts.map(a => ({
      id: a.id,
      name: a.name,
      phoneNumber: a.phoneNumber,
      isOnline: activeSessions.has(a.id),
    }));
  }

  /**
   * Agent Inbox'ni ochganda (yoki birinchi marta yangi suhbat boshlaganda)
   * chaqiriladi: agar 2+ ta account ulangan bo'lsa-yu, agent hali qaysi
   * biridan foydalanishni tanlamagan bo'lsa — `needsSelection: true`
   * qaytaradi, frontend shunda tanlov oynasini ko'rsatadi. FAQAT 1 ta
   * account bo'lsa — tanlov HECH QACHON so'ralmaydi (orqaga moslik).
   */
  async getAccountPreference(tenantId: string, userId: string) {
    const accounts = await this.listAccountsForSelection(tenantId);
    const user = await this.prisma.user.findFirst({
      where: { id: userId },
      select: { preferredTelegramAccountId: true } as any,
    }) as any;
    const preferredAccountId =
      user?.preferredTelegramAccountId && accounts.some(a => a.id === user.preferredTelegramAccountId)
        ? user.preferredTelegramAccountId
        : null;
    return {
      accounts,
      preferredAccountId,
      needsSelection: accounts.length > 1 && !preferredAccountId,
    };
  }

  /**
   * Agent qaysi shaxsiy accountdan foydalanishni tanlaydi — DOIMIY
   * saqlanadi (User.preferredTelegramAccountId), shundan keyin har doim
   * shu bitta accountdan yangi suhbat boshlanadi. Sozlamalar'dan
   * keyinchalik qayta o'zgartirilishi mumkin (shu endpoint qayta chaqiriladi).
   */
  async setPreferredAccount(tenantId: string, userId: string, accountId: string) {
    if (!accountId) throw new BadRequestException('accountId kerak');
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, tenantId, isPersonal: true, isActive: true },
    });
    if (!account) throw new NotFoundException('Bunday Telegram account topilmadi yoki hozir faol emas');

    await this.prisma.user.update({
      where: { id: userId },
      data: { preferredTelegramAccountId: accountId } as any,
    });

    return { ok: true, accountId, name: account.name };
  }

  // ─── Get my personal account status ──────────────────────────────────────
  // TUZATILDI: ilgari `isActive` bo'yicha FILTRLANMASDI — ya'ni "Uzish"
  // bosilib (`disconnect()` → isActive:false, sessionData:null) qo'yilgan
  // eski yozuv ham baribir qaytarilardi. Frontend esa "account bor/yo'q"
  // bo'yicha qaror qabul qiladi (bor bo'lsa faqat "Uzish" ko'rsatiladi,
  // "+ Ulash" tugmasi FAQAT account YO'Q bo'lganda chiqadi) — natijada
  // akkauntni uzgandan keyin "+ Ulash" tugmasi hech qachon qayta
  // ko'rinmasdi va yangi raqam ulab bo'lmasdi. Endi faqat HAQIQATAN
  // faol (isActive:true) yozuv qaytariladi — uzilgan akkaunt bazada
  // tarix uchun saqlanib qoladi, lekin bu joyda "yo'q" deb hisoblanadi.
  async getMyAccount(tenantId: string, userId: string) {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { tenantId, userId, isPersonal: true, isActive: true },
      select: {
        id: true, name: true, phoneNumber: true, isActive: true, config: true,
        createdAt: true,
      },
    });
    if (!account) return null;

    const isOnline = activeSessions.has(account.id);
    return { ...account, isOnline };
  }

  // ─── Disconnect ───────────────────────────────────────────────────────────
  async disconnect(tenantId: string, userId: string) {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { tenantId, userId, isPersonal: true },
    });
    if (!account) throw new NotFoundException('Account topilmadi');

    const client = activeSessions.get(account.id);
    if (client) {
      await client.disconnect().catch(swallow('yon amal'));
      activeSessions.delete(account.id);
    }

    await this.prisma.telegramAccount.update({
      where: { id: account.id },
      data: { isActive: false, sessionData: null },
    });

    return { ok: true };
  }
}

// ─── Controller ───────────────────────────────────────────────────────────────
@ApiTags('Telegram Shaxsiy Account (MTProto)')
@ApiBearerAuth('JWT')
@Controller('user-telegram')
@UseGuards(JwtAuthGuard)
export class UserTelegramController {
  constructor(private svc: UserTelegramService) {}

  // Auth flow
  @ApiOperation({ summary: '1-qadam: Telefon raqamga kod yuborish', description: 'Telegram SMS/App orqali 5 xonali kod yuboradi.' })
  @ApiBody({ schema: { example: { phone: '+998901234567' } } })
  @Post('auth/send-code')
  sendCode(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.sendCode(u.tenantId, u.id || u.sub, body);
  }

  @ApiOperation({ summary: '2-qadam: Kodni tasdiqlash', description: 'Telegramdan kelgan kodni kiriting.' })
  @ApiBody({ schema: { example: { phone: '+998901234567', code: '12345' } } })
  @Post('auth/verify-code')
  verifyCode(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.verifyCode(u.tenantId, u.id || u.sub, body);
  }

  @Post('auth/2fa')
  verify2FA(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.verify2FA(u.tenantId, u.id || u.sub, body);
  }

  // Send message via personal account
  @ApiOperation({
    summary: 'Birinchi xabar yuborish (klient /start yozmasdan ham)',
    description: 'Shaxsiy Telegram accountingiz orqali. Klient hech narsa yozmagan bolsa ham ishlaydi!',
  })
  @ApiBody({
    schema: {
      example: {
        phone: '+998901234567',
        text: 'Salom! Sizga tur haqida malumot bermoqchi edim.',
      },
    },
  })
  @Post('send')
  sendMessage(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.sendPersonalMessage(u.tenantId, u.id || u.sub, body);
  }

  // v11 FIX: shaxsiy akkaunt orqali shablon yuborish
  @ApiOperation({ summary: 'Shablon yuborish (shaxsiy akkaunt orqali)' })
  @Post('send-template')
  sendTemplate(@CurrentUser() u: any, @Body() body: { conversationId: string; templateId: string }) {
    return this.svc.sendTemplate(u.tenantId, u.id || u.sub, body.conversationId, body.templateId);
  }

  // v11 FIX: shaxsiy akkaunt orqali rasm/fayl yuborish
  @ApiOperation({ summary: 'Rasm/fayl yuborish (shaxsiy akkaunt orqali)' })
  @Post('send-media')
  sendMedia(@CurrentUser() u: any, @Body() body: { conversationId: string; fileUrl: string; caption?: string; mediaType?: string }) {
    return this.svc.sendMedia(u.tenantId, u.id || u.sub, body.conversationId, body.fileUrl, body.caption, body.mediaType);
  }

  // v17: barcha faol shaxsiy accountlar ro'yxati (tanlov oynasi uchun)
  @ApiOperation({ summary: 'Tenant\'dagi barcha faol shaxsiy Telegram accountlari' })
  @Get('accounts')
  listAccounts(@CurrentUser() u: any) {
    return this.svc.listAccountsForSelection(u.tenantId);
  }

  // v17: Inbox ochilganda — agentga tanlov kerakligini bilish uchun
  @ApiOperation({ summary: 'Agentning tanlangan (preferred) shaxsiy accounti va tanlov kerakligi' })
  @Get('preferred-account')
  getPreferredAccount(@CurrentUser() u: any) {
    return this.svc.getAccountPreference(u.tenantId, u.id || u.sub);
  }

  // v17: agent yangi suhbatlar uchun qaysi accountdan foydalanishni tanlaydi
  @ApiOperation({ summary: 'Yangi suhbatlar uchun shaxsiy accountni tanlash (doimiy saqlanadi)' })
  @ApiBody({ schema: { example: { accountId: 'clxxxxxxxxxxxxxxxxxxxxxxxx' } } })
  @Post('preferred-account')
  setPreferredAccount(@CurrentUser() u: any, @Body() body: { accountId: string }) {
    return this.svc.setPreferredAccount(u.tenantId, u.id || u.sub, body.accountId);
  }

  // Status
  @Get('me')
  getMyAccount(@CurrentUser() u: any) {
    return this.svc.getMyAccount(u.tenantId, u.id || u.sub);
  }

  // v15: suhbat ochilganda mijozning onlayn/oflayn holatini olish
  @ApiOperation({ summary: "Mijozning onlayn/oflayn holatini olish (shaxsiy akkaunt orqali)" })
  @Get('status/:conversationId')
  getPeerStatus(@Param('conversationId') conversationId: string, @CurrentUser() u: any) {
    return this.svc.getPeerStatus(u.tenantId, conversationId);
  }

  @Delete('me')
  disconnect(@CurrentUser() u: any) {
    return this.svc.disconnect(u.tenantId, u.id || u.sub);
  }
}

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get('JWT_ACCESS_SECRET', 'dev-only-change-in-production'),
        signOptions: { expiresIn: cfg.get('JWT_ACCESS_EXPIRES', '15m') },
      }),
    }),
  ],
  controllers: [UserTelegramController],
  // v12.5 TUZATISH: RealtimeGateway bu yerdan OLIB TASHLANDI.
  //
  // U RealtimeModule'da @Global sifatida taqdim etilgan. Bu yerda qayta
  // e'lon qilinsa, Nest IKKINCHI, ALOHIDA nusxa yaratardi — o'zining
  // bo'sh `userSockets` ro'yxati bilan. Natijada shu moduldan yuborilgan
  // `emitToUser()` xabarlari hech kimga yetmasdi (jimgina yo'qolardi).
  providers: [UserTelegramService],
  exports: [UserTelegramService],
})
export class UserTelegramModule {}