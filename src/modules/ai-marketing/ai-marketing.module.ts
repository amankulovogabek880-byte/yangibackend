import {
  Module,
  Injectable,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import sharp from 'sharp';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { uploadBufferToStorage } from '../../common/utils/media-storage';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramModule, TelegramService } from '../telegram/telegram.module';
import { EncryptionService } from '../../common/encryption/encryption.service';

/**
 * ═══════════════════════════════════════════════════════════════
 * AI Marketing (TurMaker-uslubidagi reklama generatori) — 1-bosqich
 * ═══════════════════════════════════════════════════════════════
 * Manager tur ma'lumotlarini kiritadi (yo'nalish, mehmonxona, narx,
 * sana) → agar rasm bermasa tizim o'zi mos rasm topadi (Pexels) →
 * AI (Claude) 3 ta tayyor post matnini yozadi: Instagram, Telegram,
 * Facebook — har biri o'z uslubida.
 *
 * Keyingi bosqichlar (hali qurilmagan): banner generatori (2),
 * AI Sales Assistant (4), Voice AI (5).
 * ═══════════════════════════════════════════════════════════════
 */

export interface TourAdInput {
  destination: string; // masalan "Antalya, Turkiya"
  hotelName?: string;
  hotelStars?: number;
  mealPlan?: string; // "All Inclusive" va h.k.
  nights?: number;
  adults?: number;
  children?: number;
  price: number;
  currency?: string; // USD/UZS/EUR
  departureDate?: string;
  returnDate?: string;
  includesVisa?: boolean;
  includesFlights?: boolean;
  includesMeals?: boolean;
  includesTransfer?: boolean;
  includesInsurance?: boolean;
  imageUrl?: string; // agar berilsa — avtomatik qidiruv shart emas
  agencyName?: string;
  agencyContact?: string; // telefon/telegram
  adLanguage?: 'uz' | 'ru'; // reklama MATNI tili — ilova tilidan mustaqil
  extraTexts?: string[]; // bannerga qo'shimcha urg'u/aksiya matnlari (masalan "Bepul transfer!")

  // Bir nechta mehmonxona/narx solishtirish (TurMaker uslubida). Bo'lsa
  // va showHotelList=true bo'lsa, banner bitta narx o'rniga shu ro'yxatni
  // ko'rsatadi (hotelName/hotelStars/price yagona qiymatlari e'tiborga olinmaydi).
  hotels?: Array<{ name: string; stars?: number; price: number }>;
  showHotelList?: boolean;

  // Qo'lda dizayn moslashtirish (TurMaker'dagi tahrirlagichning "form" versiyasi —
  // erkin joylashtirish emas, lekin rang/shrift/fon qorong'iligini boshqarish)
  textColor?: string; // masalan "#FFFFFF"
  fontFamily?: string; // "sans-serif" | "serif" | "monospace" | Google Font nomi
  overlayDarkness?: number; // 0..1 — fon suratining pastki qorong'ilashuv kuchi
  borderColor?: string; // agar berilsa, banner atrofida ramka chiziladi
  borderWidth?: number; // px, default 0 (ramka yo'q)

  // Banner o'lchami — "square" (1080×1080, Instagram post/Facebook) yoki
  // "story" (1080×1920, Instagram/Telegram Story). Berilmasa "square".
  bannerFormat?: 'square' | 'story';
  // Tayyor dizayn uslubi (TurMaker'dagi "bir nechta shablon" g'oyasi):
  // "classic" — standart (nishon + urg'u chiplari + narx chip'i),
  // "minimal" — sodda, kamroq element, yumshoqroq qorong'ilashuv,
  // "bold" — pastda to'liq kenglikdagi rangli chiziq, yirik narx,
  // "gallery" — "rasm ustiga rasm": fon surat ustiga QO'SHIMCHA 1-2 ta
  // (masalan mehmonxona binosi + xona) surat, kichraytirilgan, dumaloq
  // burchakli panel sifatida qo'yiladi (pastdagi `galleryImages`dan).
  // Berilmasa "classic".
  bannerTheme?: 'classic' | 'minimal' | 'bold' | 'gallery';

  // "gallery" temasi uchun: fon surat ustiga qo'shimcha qo'yiladigan
  // 1-2 ta surat URL'i (masalan mehmonxona binosi, xona ichi). Har
  // biri avtomatik kichraytirilib, dumaloq burchakli panel sifatida
  // banner ustiga joylanadi. Boshqa temalar bu maydonni e'tiborsiz qoldiradi.
  galleryImages?: string[];

  // ─────────────────────────────────────────────────────────────
  // ERKIN JOYLASHTIRISH (drag & drop) — foydalanuvchi jonli
  // preview'da HAR BIR alohida elementni (eyebrow, urg'u chiplari,
  // yulduzlar, sarlavha, mehmonxona nomi, info qatori, narx, sana,
  // footer, brend logotipi) BIR-BIRIDAN MUSTAQIL sichqoncha bilan
  // sudrab, o'zi xohlagan joyga qo'yishi mumkin — hech biri boshqa
  // elementga "yopishtirilgan" emas. Har biri banner o'lchamiga
  // NISBATAN foiz (%) siljish (dx/dy) sifatida saqlanadi — standart
  // joylashuvdan qanchalik surilganini bildiradi (0/0 = standart joy).
  // ─────────────────────────────────────────────────────────────
  layout?: {
    badge?: { dx: number; dy: number }; // "✨ TUR TAKLIFI" yorlig'i
    chips?: { dx: number; dy: number }; // qo'shimcha urg'u matnlari qatori
    stars?: { dx: number; dy: number }; // mehmonxona yulduzchalari
    title?: { dx: number; dy: number }; // yo'nalish nomi (sarlavha)
    hotel?: { dx: number; dy: number }; // mehmonxona nomi
    info?: { dx: number; dy: number }; // kecha/ovqatlanish/kishilar qatori
    price?: { dx: number; dy: number }; // narx chip (yoki mehmonxonalar ro'yxati)
    date?: { dx: number; dy: number }; // sana pill'i
    footer?: { dx: number; dy: number }; // agentlik nomi/kontakt
    logo?: { dx: number; dy: number }; // brend logotipi
  };
}

export interface TourAdOutput {
  images: string[];
  posts: {
    instagram: string;
    telegram: string;
    facebook: string;
  };
}

export interface BannerOutput {
  bannerUrl: string;
  sourceImage: string;
}

/**
 * Har bir agentlik (tenant) uchun saqlanadigan reklama shabloni —
 * har safar agentlik nomi, kontakt va brend rangini qayta
 * kiritmaslik uchun. `Tenant.settings` JSON ustunida saqlanadi
 * (`settings.adTemplate` kaliti ostida) — mavjud kodda `offers`
 * moduli ham xuddi shu tarzda ishlaydi (Client.preferences ichida),
 * shuning uchun bu — loyihaning o'ziga xos, sinalgan yondashuvi:
 * yangi migratsiya (schema o'zgarishi) SHART EMAS.
 */
export interface AdTemplate {
  agencyName?: string;
  agencyContact?: string;
  primaryColor?: string; // narx "chip"ining rangi, masalan "#FF6A2B"
  defaultCurrency?: string;
  telegramChatId?: string; // reklama yuboriladigan standart kanal
  telegramAccountId?: string; // bir nechta bot ulangan bo'lsa, qaysi biri
  // TurMaker uslubidagi Telegram xabar andozasi — Claude yozgan matn
  // o'rniga, agentlik o'zi belgilagan qat'iy formatda yuborish uchun.
  // Placeholder'lar: {destination} {hotel} {stars} {nights} {meal}
  // {people} {price} {dates} {agency} {contact}
  telegramMessageTemplate?: string;
  // Agentlik brend logotipi — bir marta yuklansa, shu tenant yaratgan
  // HAR BIR bannerga avtomatik qo'yiladi (o'chirib qo'yish ham mumkin).
  logoUrl?: string;
  logoSize?: number; // px (1080x1080 banner ichida), standart 120
}

const DEFAULT_TELEGRAM_TEMPLATE =
  "🌴 {destination}\n{hotel}\n\n📅 {dates} ({nights} kecha)\n👥 {people}\n🍽 {meal}\n\n💰 Narx: {price}\n\n📞 {agency} — {contact}";

const DEFAULT_TEMPLATE: Required<Pick<AdTemplate, 'primaryColor' | 'defaultCurrency'>> = {
  primaryColor: '#FF6A2B',
  defaultCurrency: 'USD',
};

@Injectable()
export class AiMarketingService {
  private readonly logger = new Logger('AiMarketing');

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
    private readonly encryption: EncryptionService,
  ) {}

  private get anthropicKey() {
    return (process.env.ANTHROPIC_API_KEY || '').trim();
  }
  /**
   * XARAJATNI KAMAYTIRISH (v29): reklama matni yozish (copywriting)
   * chuqur mulohaza talab qilmaydi — qat'iy formatga (JSON, uzunlik,
   * struktura) rioya qilib, berilgan faktlar asosida matn yozish.
   * Shuning uchun standart model endi ARZONROQ Haiku — Sonnet'ga
   * qaraganda bir xil vazifada sezilarli kam narxda ishlaydi.
   * Agar sifat yetarli bo'lmasa, .env'da ANTHROPIC_MODEL_MARKETING
   * (yoki umumiy ANTHROPIC_MODEL) ni claude-sonnet-5 ga qaytarish
   * kifoya — kod o'zgartirish shart emas.
   */
  private get anthropicModel() {
    return (
      process.env.ANTHROPIC_MODEL_MARKETING ||
      process.env.ANTHROPIC_MODEL ||
      'claude-haiku-4-5-20251001'
    ).trim();
  }
  private get pexelsKey() {
    return (process.env.PEXELS_API_KEY || '').trim();
  }
  private get unsplashKey() {
    return (process.env.UNSPLASH_ACCESS_KEY || '').trim();
  }
  /**
   * ⚠️ MUHIM TUZATISH: Anthropic/Claude API — bu MATN modeli, u SURAT
   * (piksel) generatsiya qila OLMAYDI (rasmni faqat "o'qiy" oladi, lekin
   * chizib bera olmaydi — bu boshqa arxitektura, diffusion model talab
   * qiladi). Shu sabab reklama matnini yozadigan xuddi shu
   * ANTHROPIC_API_KEY bilan rasm yaratib bo'lmaydi — bu texnik cheklov,
   * kamchilik emas. Rasm generatsiyasi uchun ALOHIDA xizmat (Stability AI)
   * ishlatiladi, lekin quyidagi ikkita narsa Claude copywriter bilan BIR
   * XIL qoidaga bo'ysunadi: 1) tenant.settings.aiEnabled o'chirilgan
   * bo'lsa (Owner tomonidan), bu funksiya ham ishlamaydi, 2) narx —
   * agar kelajakda Anthropic rasmiy rasm modelini chiqarsa, shu yerga
   * ANTHROPIC_API_KEY bilan almashtirish YETARLI (boshqa joy o'zgarmaydi).
   */
  private get stabilityKey() {
    return (process.env.STABILITY_API_KEY || '').trim();
  }

  isConfigured(): boolean {
    return !!this.anthropicKey;
  }

  /** AI orqali fon surat generatsiya qilish serverda sozlanganmi. */
  aiImageConfigured(): boolean {
    return !!this.stabilityKey;
  }

  /**
   * Tur ma'lumotlari (yo'nalish, mehmonxona) asosida tuzilgan matn
   * (`prompt`)dan AI orqali yangi, noyob fon surat yaratadi va doimiy
   * saqlashga yuklab, ochiq URL qaytaradi. Owner AI'ni o'chirgan
   * kompaniyada (tenant.settings.aiEnabled=false) — reklama matni
   * (Claude) kabi — bu ham ishlamaydi.
   */
  async generateAiImage(tenantId: string, prompt: string): Promise<string> {
    if (!(await this.isAiEnabledForTenant(tenantId))) {
      throw new BadRequestException(
        "Bu kompaniyada AI xizmati yoqilmagan. Yoqish uchun platforma administratoriga murojaat qiling.",
      );
    }
    if (!this.stabilityKey) {
      throw new BadRequestException(
        "AI rasm generatori sozlanmagan: serverda STABILITY_API_KEY o'rnatilmagan. Claude " +
          "(ANTHROPIC_API_KEY) faqat MATN yozadi, surat chiza olmaydi — shu sabab rasm generatsiyasi " +
          "uchun ALOHIDA kalit kerak. Bepul/pullik kalitni platform.stability.ai'dan olib, backend " +
          "serveridagi .env fayliga qo'shing va serverni qayta ishga tushiring.",
      );
    }
    try {
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('output_format', 'png');
      form.append('aspect_ratio', '1:1');
      const res = await fetch('https://api.stability.ai/v2beta/stable-image/generate/core', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.stabilityKey}`, Accept: 'image/*' },
        body: form as any,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${errText.slice(0, 200)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return await uploadBufferToStorage(buf, `ai-bg-${Date.now()}.png`, 'image/png');
    } catch (e: any) {
      this.logger.error(`AI rasm generatsiyasida xato: ${e.message}`);
      throw new BadRequestException(`AI rasm yaratib bo'lmadi: ${e.message}`);
    }
  }

  /**
   * 🩹 TUZATISH: bu servis (reklama matni yozish) ilgari Platform
   * Owner'ning "Kompaniyalar" jadvalidagi AI yoqish/o'chirish
   * (tenant.settings.aiEnabled) tugmasiga UMUMAN qaramasdan ishlardi —
   * faqat serverda ANTHROPIC_API_KEY bor-yo'qligini tekshirardi. Ya'ni
   * owner biror kompaniyada AI'ni o'chirsa ham (masalan xarajatni
   * to'xtatish uchun), o'sha kompaniya AI Marketing orqali baribir
   * Claude'ga so'rov yuborib, token sarflay olardi — bu calls.module.ts
   * va briefing.module.ts'dagi xuddi shu tekshiruv bilan nomuvofiq edi.
   * Endi ikkalasi ham BIR XIL bayroqqa (tenant.settings.aiEnabled)
   * bo'ysunadi: o'chiq bo'lsa, bu yerda ham Claude'ga umuman so'rov
   * ketmaydi.
   */
  private async isAiEnabledForTenant(tenantId: string): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
    return (tenant?.settings as any)?.aiEnabled === true;
  }

  /**
   * BUG FIX: Claude ba'zan JSON qaytarganda satr (string) ichida XOM
   * qator ko'chirish/tab kabi boshqaruv belgilarini ekranlamasdan
   * qaytaradi (masalan Telegram posti matnida haqiqiy "enter" belgisi).
   * JSON standarti bo'yicha bu taqiqlangan va JSON.parse xato beradi
   * ("Bad control character in string literal"). Bu funksiya qo'shtirnoq
   * ICHIDAGI boshqaruv belgilarinigina topib, ularni to'g'ri ekranlangan
   * ko'rinishga (\\n, \\r, \\t, \\u00XX) o'giradi — qo'shtirnoqdan
   * tashqaridagi joylarga (masalan kalitlar orasidagi bo'shliq) tegmaydi.
   */
  private sanitizeJsonControlChars(input: string): string {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (inString) {
        if (escaped) {
          result += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          result += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {
          result += ch;
          inString = false;
          continue;
        }
        const code = ch.charCodeAt(0);
        if (ch === '\n') { result += '\\n'; continue; }
        if (ch === '\r') { result += '\\r'; continue; }
        if (ch === '\t') { result += '\\t'; continue; }
        if (code < 0x20) {
          result += '\\u' + code.toString(16).padStart(4, '0');
          continue;
        }
        result += ch;
      } else {
        if (ch === '"') inString = true;
        result += ch;
      }
    }
    return result;
  }

  /** Rasm qidirish uchun kamida bitta manba (Pexels yoki Unsplash) sozlanganmi. */
  imagesConfigured(): boolean {
    return !!this.pexelsKey || !!this.unsplashKey;
  }

  // ─────────────────────────────────────────────────────────────
  // SHABLON (Template) — agentlik brendi/kontaktini bir marta
  // kiritib, har safar qayta ishlatish uchun
  // ─────────────────────────────────────────────────────────────

  async getTemplate(tenantId: string): Promise<AdTemplate> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const saved = ((tenant?.settings as any) || {}).adTemplate || {};
    return { ...DEFAULT_TEMPLATE, ...saved };
  }

  async saveTemplate(tenantId: string, data: AdTemplate): Promise<AdTemplate> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    if (!tenant) throw new NotFoundException('Tenant topilmadi');

    const currentSettings = (tenant.settings as any) || {};
    const merged: AdTemplate = {
      ...DEFAULT_TEMPLATE,
      ...(currentSettings.adTemplate || {}),
      ...data,
    };

    // Rangni yengil tekshiramiz (SVG'ga to'g'ridan-to'g'ri qo'yilgani
    // uchun — noto'g'ri format banner yaratilishini buzmasligi kerak)
    if (merged.primaryColor && !/^#[0-9a-fA-F]{3,8}$/.test(merged.primaryColor)) {
      throw new BadRequestException(
        "Rang formati noto'g'ri. Masalan: #FF6A2B kabi bo'lishi kerak.",
      );
    }

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: { ...currentSettings, adTemplate: merged } as any },
    });

    return merged;
  }

  /**
   * Brend logotipini (rasm fayl) doimiy saqlashga yuklaydi va shablonga
   * (`adTemplate.logoUrl`) saqlaydi — shundan keyin har bir yangi banner
   * avtomatik ravishda shu logotip bilan chiqadi.
   */
  async uploadLogo(tenantId: string, file: Express.Multer.File): Promise<AdTemplate> {
    if (!file) throw new BadRequestException('Fayl yuklanmadi');
    if (!file.mimetype?.startsWith('image/') || file.mimetype === 'image/svg+xml') {
      throw new BadRequestException(
        "Logotip faqat rasm (PNG/JPG/WEBP) bo'lishi kerak. SVG qabul qilinmaydi.",
      );
    }
    const url = await uploadBufferToStorage(file.buffer, file.originalname || 'logo.png', file.mimetype);
    return this.saveTemplate(tenantId, { logoUrl: url });
  }

  /** Bannerdan logotipni olib tashlash (shablondan o'chirish) */
  async removeLogo(tenantId: string): Promise<AdTemplate> {
    return this.saveTemplate(tenantId, { logoUrl: '' });
  }

  // ─────────────────────────────────────────────────────────────
  // MEHMONXONA RASM KUTUBXONASI — agentlik biror mehmonxonaning
  // O'ZINING haqiqiy suratini bir marta yuklasa, keyingi safar o'sha
  // mehmonxona nomi kiritilganda avtomatik taklif qilinadi (stok-foto
  // o'rniga). `Tenant.settings.hotelPhotoLibrary` JSON ustunida
  // saqlanadi — yangi migratsiya (schema o'zgarishi) SHART EMAS,
  // aynan `adTemplate` bilan bir xil yondashuv.
  // Kalit — mehmonxona nomi kichik harfda va bo'sh joylarsiz
  // ("Rixos Premium" → "rixospremium"), shunda "Rixos premium" va
  // "rixos Premium" bir xil kutubxonaga tushadi.
  // ─────────────────────────────────────────────────────────────
  private normalizeHotelKey(hotelName: string): string {
    return (hotelName || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /** Berilgan mehmonxona uchun avval saqlangan rasmlar ro'yxati (eng yangisi birinchi). */
  async getHotelPhotos(tenantId: string, hotelName: string): Promise<string[]> {
    const key = this.normalizeHotelKey(hotelName);
    if (!key) return [];
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const library = ((tenant?.settings as any) || {}).hotelPhotoLibrary || {};
    const list = Array.isArray(library[key]) ? library[key] : [];
    return list;
  }

  /** Barcha mehmonxonalar ro'yxati (nom → nechta rasm saqlangan) — kelajakda "kutubxona" sahifasi uchun. */
  async listHotelPhotoLibrary(tenantId: string): Promise<Array<{ hotelName: string; photos: string[] }>> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const library = ((tenant?.settings as any) || {}).hotelPhotoLibrary || {};
    return Object.entries(library).map(([hotelName, photos]) => ({
      hotelName,
      photos: Array.isArray(photos) ? (photos as string[]) : [],
    }));
  }

  /** Mehmonxona uchun yangi rasm (fayl) kutubxonaga yuklab qo'shadi. */
  async saveHotelPhoto(tenantId: string, hotelName: string, file: Express.Multer.File): Promise<string[]> {
    if (!hotelName?.trim()) throw new BadRequestException('Mehmonxona nomi kerak');
    if (!file) throw new BadRequestException('Fayl yuklanmadi');
    if (!file.mimetype?.startsWith('image/') || file.mimetype === 'image/svg+xml') {
      throw new BadRequestException("Rasm faqat PNG/JPG/WEBP bo'lishi kerak. SVG qabul qilinmaydi.");
    }
    const key = this.normalizeHotelKey(hotelName);
    const url = await uploadBufferToStorage(file.buffer, file.originalname || 'hotel.jpg', file.mimetype);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    if (!tenant) throw new NotFoundException('Tenant topilmadi');
    const currentSettings = (tenant.settings as any) || {};
    const library = { ...(currentSettings.hotelPhotoLibrary || {}) };
    // Eng yangisi ro'yxat boshida chiqishi uchun oldiga qo'shamiz, mehmonxona
    // uchun ko'p bo'lib ketmasligi uchun ko'pi bilan 12 tasini saqlaymiz
    const existing: string[] = Array.isArray(library[key]) ? library[key] : [];
    library[key] = [url, ...existing.filter((u) => u !== url)].slice(0, 12);

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: { ...currentSettings, hotelPhotoLibrary: library } as any },
    });

    return library[key];
  }

  /** Kutubxonadan bitta rasmni o'chirish. */
  async deleteHotelPhoto(tenantId: string, hotelName: string, url: string): Promise<string[]> {
    const key = this.normalizeHotelKey(hotelName);
    if (!key) throw new BadRequestException('Mehmonxona nomi kerak');
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    if (!tenant) throw new NotFoundException('Tenant topilmadi');
    const currentSettings = (tenant.settings as any) || {};
    const library = { ...(currentSettings.hotelPhotoLibrary || {}) };
    const existing: string[] = Array.isArray(library[key]) ? library[key] : [];
    library[key] = existing.filter((u) => u !== url);

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: { ...currentSettings, hotelPhotoLibrary: library } as any },
    });

    return library[key];
  }

  /**
   * Foydalanuvchi kiritmagan maydonlarni (agentlik nomi, kontakt,
   * valyuta) saqlangan shablondan avtomatik to'ldiradi — har safar
   * qayta yozish shart emas. Foydalanuvchi ANIQ kiritgan qiymatlar
   * har doim ustunlik qiladi (shablon ularni bosib ketmaydi).
   */
  private async mergeWithTemplate(
    tenantId: string,
    input: TourAdInput,
  ): Promise<{ input: TourAdInput; template: AdTemplate }> {
    const template = await this.getTemplate(tenantId);
    return {
      template,
      input: {
        ...input,
        agencyName: input.agencyName || template.agencyName,
        agencyContact: input.agencyContact || template.agencyContact,
        currency: input.currency || template.defaultCurrency,
      },
    };
  }

  /**
   * Pexels/Unsplash (bepul stok-foto xizmatlari) orqali mavzuga mos
   * rasmlarni topadi. API kalit sozlanmagan bo'lsa — bo'sh massiv
   * qaytaradi (xato chiqarmaydi, chunki bu ixtiyoriy funksiya).
   */
  /**
   * Bitta Pexels qidiruv so'rovi (ichki yordamchi). `page` — xilma-xillik
   * uchun (bir xil so'rov har safar bir xil natija bermasin desak, turli
   * sahifadan olamiz).
   */
  private async pexelsSearch(query: string, perPage: number, page = 1): Promise<string[]> {
    if (!this.pexelsKey) return [];
    try {
      const url =
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}` +
        `&per_page=${Math.max(1, Math.min(perPage, 15))}&page=${Math.max(1, page)}&orientation=square`;
      const res = await fetch(url, { headers: { Authorization: this.pexelsKey } });
      if (!res.ok) {
        this.logger.warn(`Pexels xato (HTTP ${res.status}) so'rov: "${query}"`);
        return [];
      }
      const j: any = await res.json();
      const photos = Array.isArray(j?.photos) ? j.photos : [];
      return photos
        .map((p: any) => p?.src?.large || p?.src?.medium || p?.src?.original)
        .filter((u: any) => typeof u === 'string' && u.length > 0);
    } catch (e: any) {
      this.logger.warn(`Pexels'dan rasm qidirishda xato ("${query}"): ${e.message}`);
      return [];
    }
  }

  /**
   * Unsplash — Pexels bilan bir qatorda ikkinchi manba sifatida
   * ishlatiladi (ixtiyoriy: `UNSPLASH_ACCESS_KEY` sozlansa yoqiladi).
   * Ikki manbani birlashtirish natijalarni ko'proq va xilma-xil qiladi.
   */
  private async unsplashSearch(query: string, perPage: number, page = 1): Promise<string[]> {
    if (!this.unsplashKey) return [];
    try {
      const url =
        `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}` +
        `&per_page=${Math.max(1, Math.min(perPage, 15))}&page=${Math.max(1, page)}&orientation=squarish`;
      const res = await fetch(url, { headers: { Authorization: `Client-ID ${this.unsplashKey}` } });
      if (!res.ok) {
        this.logger.warn(`Unsplash xato (HTTP ${res.status}) so'rov: "${query}"`);
        return [];
      }
      const j: any = await res.json();
      const photos = Array.isArray(j?.results) ? j.results : [];
      return photos
        .map((p: any) => p?.urls?.regular || p?.urls?.small)
        .filter((u: any) => typeof u === 'string' && u.length > 0);
    } catch (e: any) {
      this.logger.warn(`Unsplash'dan rasm qidirishda xato ("${query}"): ${e.message}`);
      return [];
    }
  }

  /**
   * TurMaker'dagi kabi — mashhur yo'nalishlar davlat bo'yicha bo'lingan,
   * har biri o'ziga xos, aniq nomlangan joy. Foydalanuvchi "Antalya"
   * yozganda umumiy "hotel resort" so'zlariga tayanib noaniq natija
   * olish o'rniga, shu ro'yxatdagi TANISH joy nomi topilsa — qidiruvga
   * uning davlat/mintaqa nomi ham avtomatik qo'shiladi (masalan
   * "Antalya" → "Antalya Turkey"), bu esa Pexels/Unsplash'dan AYNAN
   * o'sha joyga oid rasm chiqish ehtimolini sezilarli oshiradi.
   * Ro'yxat frontendda "Mashhur yo'nalishlar" tanlagichi sifatida ham
   * ko'rsatiladi (`GET /ai-marketing/destinations`).
   */
  static readonly POPULAR_DESTINATIONS: Array<{ country: string; countryUz: string; places: string[] }> = [
    { country: 'Turkey', countryUz: 'Turkiya', places: ['Antalya', 'Alanya', 'Side', 'Kemer', 'Bodrum', 'Marmaris', 'Istanbul', 'Fethiye'] },
    { country: 'UAE', countryUz: 'BAA (Dubay)', places: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ras Al Khaimah', 'Ajman'] },
    { country: 'Egypt', countryUz: 'Misr', places: ['Hurghada', 'Sharm El Sheikh', 'Marsa Alam', 'Cairo'] },
    { country: 'Thailand', countryUz: 'Tailand', places: ['Phuket', 'Pattaya', 'Bangkok', 'Krabi', 'Koh Samui'] },
    { country: 'Maldives', countryUz: 'Maldiv orollari', places: ['Male', 'Maldives resort island'] },
    { country: 'Georgia', countryUz: 'Gruziya', places: ['Tbilisi', 'Batumi', 'Kazbegi', 'Bakuriani'] },
    { country: 'Azerbaijan', countryUz: 'Ozarbayjon', places: ['Baku', 'Gabala'] },
    { country: 'Malaysia', countryUz: 'Malayziya', places: ['Kuala Lumpur', 'Langkawi', 'Penang'] },
    { country: 'Indonesia', countryUz: 'Indoneziya', places: ['Bali', 'Jakarta'] },
    { country: 'Vietnam', countryUz: 'Vyetnam', places: ['Nha Trang', 'Phu Quoc', 'Da Nang', 'Hanoi'] },
    { country: 'Sri Lanka', countryUz: 'Shri-Lanka', places: ['Colombo', 'Bentota', 'Kandy'] },
    { country: 'Saudi Arabia', countryUz: 'Saudiya Arabistoni', places: ['Mecca', 'Medina', 'Jeddah'] },
    { country: 'Europe', countryUz: 'Yevropa', places: ['Paris', 'Rome', 'Prague', 'Barcelona', 'Milan', 'Vienna'] },
    { country: 'Russia', countryUz: 'Rossiya', places: ['Moscow', 'Sochi', 'Saint Petersburg'] },
    { country: 'Kazakhstan', countryUz: 'Qozog\u2019iston', places: ['Almaty', 'Astana'] },
    { country: 'South Korea', countryUz: 'Janubiy Koreya', places: ['Seoul', 'Busan'] },
    { country: 'Singapore', countryUz: 'Singapur', places: ['Singapore'] },
  ];

  /** Frontenddagi "Mashhur yo'nalishlar" tanlagichi uchun. */
  getPopularDestinations() {
    return AiMarketingService.POPULAR_DESTINATIONS;
  }

  /** Kiritilgan matn ichidan ro'yxatdagi tanish joy nomini (bo'lsa) topadi. */
  private matchKnownPlace(text: string): { place: string; country: string } | null {
    const t = (text || '').toLowerCase();
    for (const group of AiMarketingService.POPULAR_DESTINATIONS) {
      for (const place of group.places) {
        if (t.includes(place.toLowerCase())) {
          return { place, country: group.country };
        }
      }
    }
    return null;
  }

  /**
   * HAR BIR yo'nalish/davlat/shahar uchun O'ZIGA XOS rasmlar to'plami
   * qaytarishi kerak, faqat bitta statik so'rov emas. Shu sabab bitta
   * umumiy so'rov o'rniga, kiritilgan matndan bir nechta MA'NOLI
   * variant so'rov quramiz — TO'LIQ kiritilgan matn (eng aniq moslik),
   * ro'yxatdan topilgan tanish joy + davlati (bo'lsa), keyin
   * mehmonxona/kurort, plyaj, shahar manzarasi, tabiat/diqqatga
   * sazovor joy variantlari. Bularning har biridan bir nechtadan olib
   * birlashtiramiz — natijada rasmlar aynan shu yo'nalishga xos va
   * xilma-xil chiqadi.
   */
  private buildImageQueryVariants(baseQuery: string): string[] {
    const q = (baseQuery || '').trim();
    if (!q) return ['travel destination'];
    const place = q.split(',')[0].trim() || q;
    const known = this.matchKnownPlace(q);

    const variants = [
      q, // foydalanuvchi TO'LIQ kiritgan matn — eng aniq moslik birinchi navbatda
      place,
      known ? `${known.place} ${known.country}` : `${place} ${q.split(',')[1]?.trim() || ''}`.trim(),
      `${place} resort hotel`,
      `${place} beach`,
      `${place} city landmark`,
      `${place} aerial view`,
    ];
    // Bo'sh yoki takrorlanuvchi variantlarni tozalaymiz
    return Array.from(new Set(variants.map((v) => v.trim()).filter(Boolean)));
  }

  async findImages(query: string, count = 4): Promise<string[]> {
    if (!this.pexelsKey && !this.unsplashKey) {
      this.logger.warn(
        "PEXELS_API_KEY yoki UNSPLASH_ACCESS_KEY sozlanmagan — rasm qidirish o'tkazib yuborildi",
      );
      // Ichki chaqiruvchilar (generateTourAd, generateBanner) bo'sh
      // massiv bilan yumshoq (graceful) davom etadi, shu sabab bu yerda
      // xato tashlamaymiz — lekin foydalanuvchi TO'G'RIDAN-TO'G'RI
      // "🔍 Rasm topish" tugmasini bosganda aniq sabab ko'rsatilishi
      // uchun controller darajasida (`imagesForUser`) alohida tekshiruv bor.
      return [];
    }
    const variants = this.buildImageQueryVariants(query);
    const target = Math.max(1, Math.min(count, 24));
    // Har bir variantdan nechta rasm kerakligini taqsimlaymiz (bir oz ortiqcha
    // so'raymiz — chunki dublikatlar filtrlanadi)
    const perVariant = Math.max(2, Math.ceil((target * 1.4) / variants.length));
    // Xilma-xillik uchun: har chaqirilganda tasodifiy sahifadan boshlaymiz —
    // shunda foydalanuvchi "qayta qidirish"ni bossa, doim bir xil rasmlar
    // chiqavermaydi, har safar boshqa variantlar keladi.
    const randomPage = () => 1 + Math.floor(Math.random() * 3);

    const results = await Promise.all(
      variants.flatMap((v) => [
        this.pexelsSearch(v, perVariant, randomPage()),
        this.unsplashSearch(v, perVariant, randomPage()),
      ]),
    );

    // Birlashtiramiz, dublikatlarni olib tashlaymiz, so'ng aralashtiramiz —
    // shunda bitta variant natijalari boshidan to oxirigacha ustma-ust
    // to'planib qolmaydi (har xil turdagi rasmlar bir-biriga qorishiq chiqadi)
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const list of results) {
      for (const url of list) {
        if (!seen.has(url)) {
          seen.add(url);
          merged.push(url);
        }
      }
    }
    for (let i = merged.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [merged[i], merged[j]] = [merged[j], merged[i]];
    }

    return merged.slice(0, target);
  }

  /**
   * Tur ma'lumotlaridan 3 ta platforma uchun tayyor post matnini
   * yozadi (Claude API orqali).
   */
  async generatePosts(input: TourAdInput): Promise<TourAdOutput['posts']> {
    if (!this.anthropicKey) {
      throw new BadRequestException(
        "AI Copywriter sozlanmagan. Serverda ANTHROPIC_API_KEY o'rnatilmagan " +
          '(console.anthropic.com dan olinadi).',
      );
    }

    const includes: string[] = [];
    if (input.includesVisa) includes.push('Viza');
    if (input.includesFlights) includes.push('Aviabilet');
    if (input.includesMeals) includes.push(input.mealPlan || 'Ovqatlanish');
    if (input.includesTransfer) includes.push('Transfer');
    if (input.includesInsurance) includes.push("Sug'urta");

    const facts = [
      `Yo'nalish: ${input.destination}`,
      input.hotelName
        ? `Mehmonxona: ${input.hotelName}${input.hotelStars ? ` ${input.hotelStars}★` : ''}`
        : null,
      input.nights ? `Muddat: ${input.nights} kecha` : null,
      input.adults || input.children
        ? `Kishilar soni: ${input.adults || 1} kattalar${
            input.children ? `, ${input.children} bola` : ''
          }`
        : null,
      input.departureDate
        ? `Sana: ${input.departureDate}${input.returnDate ? ` — ${input.returnDate}` : ''}`
        : null,
      includes.length ? `Xizmatlar: ${includes.join(', ')}` : null,
      `Narx: ${input.price} ${input.currency || 'USD'}`,
      input.agencyName ? `Agentlik: ${input.agencyName}` : null,
      input.agencyContact ? `Kontakt: ${input.agencyContact}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const isRu = input.adLanguage === 'ru';

    const langLine = isRu
      ? "Har doim FAQAT rus tilida yozasan (kirill alifbosida)."
      : "Har doim FAQAT o'zbek tilida, lotin alifbosida yozasan.";

    const system = `Sen O'zbekistondagi eng yaxshi sayohat agentliklari bilan ishlaydigan, o'nlab yillik tajribaga ega SMM copywritersan. ${langLine} Sening postlaring doim yuqori konversiya (band qilishga chaqiruv) keltiradi, chunki ular quruq reklama emas, balki odamning his-tuyg'ulariga — dam olish orzusi, oilaviy iliqlik, yangi tajriba istagiga — murojaat qiladi.

Qattiq qoidalaring:
1. Faqat foydalanuvchi bergan FAKTLARDAN foydalanasan — narx, sana, mehmonxona nomi yoki xizmatlarni hech qachon o'zgartirmaysan, to'qib chiqarmaysan yoki "taxminan" deb yozmaysan.
2. Har bir post BITTA aniq hissiy "ilgak" (hook) bilan boshlanadi — umumiy "Ajoyib dam olish!" kabi klişelardan qochasan, o'rniga aniq bir manzara, tuyg'u yoki savol bilan boshlaysan.
3. Emoji tasodifiy emas — faqat matndagi ma'noga mos joyda, ortiqcha ishlatmasdan qo'yasan.
4. Har bir post oxirida ANIQ va harakatga undovchi CTA (call-to-action) bo'ladi — masalan joy sonini cheklash, sanani eslatish yoki to'g'ridan-to'g'ri bog'lanishga chaqirish orqali.
5. Bir xil jumla tuzilishini uch platformada takrorlamaysan — har biri boshqacha ochilish va ohangga ega bo'lishi kerak.`;


    const prompt = `Quyidagi tur uchun 3 ta ijtimoiy tarmoq posti yoz. Har birini alohida braif bo'yicha qur:

TUR MA'LUMOTLARI:
${facts}

━━━━━━━━━━━━━━━━━━━━━━
📸 INSTAGRAM (caption uchun)
- Struktura: [1 qatorli kuchli hook, e'tiborni darrov tortadigan] → [2-3 qisqa jumla — hissiy, manzarali, faktlarga asoslangan] → [aniq CTA: DM/link/telefon] → bo'sh qator → 6-9 ta mos hashtag (masalan #tur #antalya2026 #dam_olish, yo'nalish va tur turiga mos)
- Uzunligi: 60-90 so'z (hashtaglardan tashqari), qisqa va "scroll-stopping"
- Ohang: samimiy, hayajonli, do'stona "sen" bilan murojaat

━━━━━━━━━━━━━━━━━━━━━━
✈️ TELEGRAM (kanal posti uchun)
- Struktura: [qalin sarlavha yoki hook qatori] → bo'sh qator → tartibli ro'yxat (✅/📍/💰/📅 kabi emoji-bullet bilan har bir asosiy fakt: narx, sana, xizmatlar, mehmonxona) → bo'sh qator → 1-2 jumlali ishonch beruvchi yakun → aniq CTA (masalan: "Joylar cheklangan — hoziroq yozing 👇" + agentlik kontakti)
- Uzunligi: 90-140 so'z, tartibli va skanerlash oson
- Ohang: aniq, professional, lekin sovuq emas — ishonch uyg'otadigan

━━━━━━━━━━━━━━━━━━━━━━
👍 FACEBOOK (post uchun)
- Struktura: [qisqa hikoya yoki savol bilan ochilish, masalan "Bu yozgi ta'til..."] → [tur haqida 2-3 jumla, oilaviy/do'stona auditoriyaga mos, foyda-yo'naltirilgan (nima uchun aynan bu tur yaxshi tanlov)] → aniq CTA
- Uzunligi: 70-110 so'z
- Ohang: iliq, ishonchli, biroz batafsilroq hikoya uslubida, ortiqcha hashtagsiz (0-2 ta, ixtiyoriy)

Javobni FAQAT quyidagi JSON formatida qaytar — hech qanday izoh, sarlavha yoki markdown belgisi (masalan \`\`\`json) qo'shma:
{"instagram": "...", "telegram": "...", "facebook": "..."}`;

    let raw = '';
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.anthropicModel,
          max_tokens: 1400,
          // XARAJATNI KAMAYTIRISH (v29): `system` matni barcha
          // tenantlar/tillar uchun deyarli o'zgarmas (faqat uz/ru
          // qatori farq qiladi) — shuning uchun `cache_control` bilan
          // keshlanadi. Birinchi chaqiruvdan keyin (5 daqiqa ichida
          // qayta ishlatilsa) shu qismning kirish (input) narxi ~10%
          // gacha tushadi — bu funksiya tez-tez, ko'p tenant tomonidan
          // chaqirilgani uchun amaliy foyda beradi.
          system: [
            { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Anthropic API xato (HTTP ${res.status}): ${text.slice(0, 300)}`);
      }

      const j: any = await res.json();
      const textBlock = (j?.content || []).find((c: any) => c.type === 'text');
      raw = textBlock?.text || '';

      // Modelning javobidan JSON'ni ajratib olamiz (ehtiyot chorasi —
      // ba'zan model qo'shimcha matn bilan o'rab yuborishi mumkin)
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('AI javobidan JSON topilmadi');
      let parsed: any;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        // Xom boshqaruv belgilarini (masalan haqiqiy "enter") tozalab qayta urinamiz
        parsed = JSON.parse(this.sanitizeJsonControlChars(match[0]));
      }

      return {
        instagram: String(parsed.instagram || '').trim(),
        telegram: String(parsed.telegram || '').trim(),
        facebook: String(parsed.facebook || '').trim(),
      };
    } catch (e: any) {
      this.logger.error(`AI Copywriter xato: ${e.message} | raw: ${raw.slice(0, 200)}`);
      throw new BadRequestException(`Reklama matni yaratib bo'lmadi: ${e.message}`);
    }
  }

  /**
   * To'liq oqim: rasm (agar berilmagan bo'lsa avtomatik topiladi)
   * + 3 platforma uchun tayyor post matni — bittada. Agentlik
   * nomi/kontakti/valyuta saqlangan shablondan avtomatik to'ldiriladi.
   */
  async generateTourAd(tenantId: string, rawInput: TourAdInput): Promise<TourAdOutput> {
    // 🩹 TUZATISH: AI (Claude) so'rovidan OLDIN tenant darajasidagi
    // yoqilgan/o'chirilgan holatini tekshiramiz — o'chiq bo'lsa bu yerda
    // to'xtaymiz, hech qanday token sarflanmaydi (rasm qidiruvi ham
    // ishga tushmaydi, chunki u ham shu funksiya ichida ketma-ket).
    if (!(await this.isAiEnabledForTenant(tenantId))) {
      throw new BadRequestException(
        "Bu kompaniyada AI xizmati yoqilmagan. Yoqish uchun platforma administratoriga murojaat qiling.",
      );
    }
    const { input } = await this.mergeWithTemplate(tenantId, rawInput);

    const [libraryPhotos, images, posts] = await Promise.all([
      input.hotelName ? this.getHotelPhotos(tenantId, input.hotelName) : Promise.resolve([]),
      input.imageUrl
        ? Promise.resolve([input.imageUrl])
        : this.findImages(input.destination, 16),
      this.generatePosts(input),
    ]);

    // Kutubxonadagi (agentlik o'zi yuklagan, haqiqiy) suratlar stok-fotodan
    // OLDIN ko'rsatiladi — chunki bular aynan shu mehmonxonaga tegishli.
    const mergedImages = input.imageUrl
      ? images
      : Array.from(new Set([...libraryPhotos, ...images]));

    return { images: mergedImages, posts };
  }

  // ─────────────────────────────────────────────────────────────
  // 2-BOSQICH: BANNER GENERATORI (1080×1080)
  // ─────────────────────────────────────────────────────────────
  //
  // MUHIM ARXITEKTURA QARORI: banner matni (narx, sana, mehmonxona
  // nomi) AI orqali "chizilmaydi" — AI rasm generatorlari raqam va
  // matnni ko'pincha noto'g'ri yoki o'qib bo'lmaydigan qilib
  // chizadi, bu esa mijozga NOTO'G'RI NARX ko'rsatish xavfini
  // tug'diradi. Shuning uchun: fon surati (Pexels yoki foydalanuvchi
  // bergan rasm) ustiga matn DASTURIY ravishda (SVG + sharp) aniq va
  // 100% to'g'ri qo'yiladi — bu professional, ishonchli yondashuv.

  /**
   * XML/SVG'ga xavfsiz kiritish uchun maxsus belgilarni escape qiladi.
   * Bu bo'lmasa, foydalanuvchi kiritgan matn (masalan mehmonxona nomi
   * ichida "&" yoki "<" bo'lsa) SVG'ni buzib, banner yaratilmay qolishi
   * yoki (nazariy jihatdan) zararli SVG in'ektsiyasiga olib kelishi mumkin.
   */
  private escapeSvg(text: string): string {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /** Uzun matnlarni banner ichiga sig'dirish uchun xavfsiz qisqartiradi */
  private truncate(text: string, max: number): string {
    const t = String(text ?? '').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  /**
   * 1080×1080 banner ustiga qo'yiladigan matn qatlamini (SVG) quradi.
   * Pastki qismda qorong'i gradient (matn o'qilishi uchun kontrast),
   * mehmonxona/yo'nalish nomi, yulduzchalar, narx (katta, ajratilgan
   * "chip" ichida) va sanalar joylashtiriladi.
   */
  /**
   * `input.layout`dagi foiz (%) siljishni (dx/dy) shu banner o'lchamiga
   * nisbatan pikselga aylantiradi. Foydalanuvchi hech narsa sudramagan
   * bo'lsa (layout yo'q) — {dx:0, dy:0} qaytadi, ya'ni standart joylashuv
   * o'zgarishsiz qoladi (eski bannerlar bilan 100% moslik).
   */
  private resolveOffset(
    input: TourAdInput,
    key: 'badge' | 'chips' | 'stars' | 'title' | 'hotel' | 'info' | 'price' | 'date' | 'footer' | 'logo',
    width: number,
    height: number,
  ): { dx: number; dy: number } {
    const raw = input.layout?.[key];
    if (!raw) return { dx: 0, dy: 0 };
    const clampPct = (n: number) => Math.max(-90, Math.min(90, Number(n) || 0));
    return {
      dx: (clampPct(raw.dx) / 100) * width,
      dy: (clampPct(raw.dy) / 100) * height,
    };
  }

  /**
   * `width`/`height` — banner o'lchami: "square" uchun 1080×1080,
   * "story" uchun 1080×1920 (ikkalasi ham chaqiruvchidan keladi).
   * Matn blokining HAMMASI pastki chetdan hisoblangan masofa bilan
   * joylashtirilgan (`height - N`) — shu sabab "story" formatida
   * xuddi shu blok pastda, xuddi shunday o'lchamda turadi, faqat
   * ustida ko'proq bo'sh joy (fon surati) qoladi — bu Instagram
   * Story'larning odatiy ko'rinishi.
   *
   * `theme` — TurMaker uslubidagi "bir nechta tayyor shablon"dan
   * biri: "classic" (standart, avvalgi ko'rinish bilan 100% bir xil),
   * "minimal" (nishon/chiplarsiz, yumshoqroq qorong'ilashuv) yoki
   * "bold" (pastda to'liq kenglikdagi rangli chiziq, yirikroq narx).
   */
  private buildBannerSvg(
    input: TourAdInput,
    accentColor = '#FF6A2B',
    width = 1080,
    height = width,
    logo?: { dataUri: string; size: number },
    theme: 'classic' | 'minimal' | 'bold' | 'gallery' = 'classic',
  ): string {
    const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(accentColor) ? accentColor : '#FF6A2B';
    const isRu = input.adLanguage === 'ru';
    const L = isRu
      ? { nights: 'ночей', adults: 'взрослых', child: 'ребёнок', offer: 'ТУР ПРЕДЛОЖЕНИЕ' }
      : { nights: 'kecha', adults: 'kattalar', child: 'bola', offer: 'TUR TAKLIFI' };

    // ── Qo'lda dizayn moslashtirish (TurMaker'dagi "forma" uslubidagi
    // tahrirlagich — erkin joylashtirish emas, lekin rang/shrift/qorong'ilik) ──
    const font = /^[a-zA-Z0-9 ,'"-]{2,40}$/.test(input.fontFamily || '')
      ? input.fontFamily!
      : 'sans-serif';
    const textColor = /^#[0-9a-fA-F]{3,8}$/.test(input.textColor || '') ? input.textColor! : '#FFFFFF';
    const baseDarkness = Math.max(0.3, Math.min(0.95, Number(input.overlayDarkness) || 0.82));
    // "minimal" temasi yumshoqroq (kamroq qorong'i) fon beradi
    const darkness = theme === 'minimal' ? Math.min(baseDarkness, 0.7) : baseDarkness;
    const borderWidth = Math.max(0, Math.min(40, Number(input.borderWidth) || 0));
    const borderColor = /^#[0-9a-fA-F]{3,8}$/.test(input.borderColor || '') ? input.borderColor! : safeColor;

    const destination = this.escapeSvg(this.truncate(input.destination, 34));
    const hotel = input.hotelName ? this.escapeSvg(this.truncate(input.hotelName, 30)) : '';
    const stars = input.hotelStars
      ? '★'.repeat(Math.max(0, Math.min(5, Math.round(input.hotelStars))))
      : '';

    const infoParts: string[] = [];
    if (input.nights) infoParts.push(`${input.nights} ${L.nights}`);
    if (input.mealPlan) infoParts.push(this.escapeSvg(this.truncate(input.mealPlan, 20)));
    if (input.adults || input.children) {
      infoParts.push(
        `${input.adults || 1} ${L.adults}${input.children ? ` + ${input.children} ${L.child}` : ''}`,
      );
    }
    const infoLine = this.escapeSvg(infoParts.join('  •  '));

    const dateLine = input.departureDate
      ? this.escapeSvg(
          `${input.departureDate}${input.returnDate ? ` — ${input.returnDate}` : ''}`,
        )
      : '';

    const priceText = this.escapeSvg(
      `${Math.round(input.price).toLocaleString('ru-RU')} ${input.currency || 'USD'}`,
    );

    const agency = input.agencyName ? this.escapeSvg(this.truncate(input.agencyName, 28)) : '';
    const contact = input.agencyContact ? this.escapeSvg(this.truncate(input.agencyContact, 24)) : '';
    const footer = [agency, contact].filter(Boolean).join('   •   ');

    // ── Bir nechta mehmonxona/narx solishtirish (TurMaker uslubida) ──
    const useHotelList = !!(input.showHotelList && input.hotels && input.hotels.length > 1);
    const hotelRows = useHotelList ? input.hotels!.slice(0, 3) : [];
    const rowH = 50;
    const rowGap = 10;
    const listTop = height - 350;
    const hotelListParts: string[] = [];
    hotelRows.forEach((h, i) => {
      const rowY = listTop + i * (rowH + rowGap);
      const hName = this.escapeSvg(this.truncate(h.name || '—', 26));
      const hStars = h.stars ? ' ' + '★'.repeat(Math.max(0, Math.min(5, Math.round(h.stars)))) : '';
      const hPrice = this.escapeSvg(`${Math.round(h.price).toLocaleString('ru-RU')} ${input.currency || 'USD'}`);
      const pillW = Math.min(240, 60 + hPrice.length * 13);
      hotelListParts.push(`
  <rect x="60" y="${rowY}" width="${width - 120}" height="${rowH}" rx="12" fill="#FFFFFF" fill-opacity="0.10"/>
  <text x="78" y="${rowY + 32}" font-family="${font}" font-size="22" font-weight="700" fill="${textColor}">${hName}<tspan fill="#FFD54A">${hStars}</tspan></text>
  <rect x="${width - 76 - pillW}" y="${rowY + 8}" width="${pillW}" height="34" rx="17" fill="${safeColor}"/>
  <text x="${width - 76 - pillW / 2}" y="${rowY + 31}" font-family="${font}" font-size="18" font-weight="800" fill="#FFFFFF" text-anchor="middle">${hPrice}</text>`);
    });
    const hotelListSvg = hotelListParts.join('\n');

    // "bold" temasida narx chip'i yiriqroq va to'la kenglikka yaqinroq chiqadi
    const priceFontSize = theme === 'bold' ? 46 : 38;
    const priceChipHeight = theme === 'bold' ? 86 : 72;
    // Narx "chip"ining kengligini matn uzunligiga qarab taxminiy hisoblaymiz
    const priceChipWidth = Math.min(width - 120, (theme === 'bold' ? 180 : 150) + priceText.length * (theme === 'bold' ? 30 : 26));
    // Sana har doim narxdan ALOHIDA qatorda, o'ngga tekislangan — shunda
    // matn uzunligidan qat'i nazar narx bilan hech qachon ustma-ust tushmaydi
    const datePillWidth = dateLine ? Math.min(width - 120, 70 + dateLine.length * 13) : 0;

    const eyebrowText = `✨ ${L.offer}`;
    const eyebrowWidth = Math.min(width - 120, 40 + eyebrowText.length * 9.5);
    // "minimal" temasida nishon (badge) umuman ko'rsatilmaydi — sodda ko'rinish uchun
    const showBadge = theme !== 'minimal';

    // Qo'shimcha urg'u matnlari (masalan "Bepul transfer!", "Cheklangan joy")
    // — TurMaker uslubidagi kichik "chip"lar qatorida, sig'guncha chiqadi.
    // "minimal" temasida bu qator ham ko'rsatilmaydi (sodda ko'rinish uchun).
    const extraChips = theme === 'minimal'
      ? []
      : (input.extraTexts || [])
          .map((t) => (t || '').trim())
          .filter(Boolean)
          .slice(0, 4)
          .map((t) => this.escapeSvg(this.truncate(t, 24)));
    let chipX = 60;
    const chipY = height - 364;
    const chipParts: string[] = [];
    for (const chip of extraChips) {
      const w = Math.min(320, 40 + chip.length * 11);
      if (chipX + w > width - 60) break;
      chipParts.push(
        `<rect x="${chipX}" y="${chipY}" width="${w}" height="32" rx="16" fill="${safeColor}"/>` +
          `<text x="${chipX + w / 2}" y="${chipY + 22}" font-family="${font}" font-size="16" font-weight="700" fill="#FFFFFF" text-anchor="middle">${chip}</text>`,
      );
      chipX += w + 8;
    }
    const extraChipsSvg = chipParts.join('\n  ');

    const borderSvg =
      borderWidth > 0
        ? `<rect x="${borderWidth / 2}" y="${borderWidth / 2}" width="${width - borderWidth}" height="${height - borderWidth}" fill="none" stroke="${borderColor}" stroke-width="${borderWidth}"/>`
        : '';

    // "bold" temasi — banner tagida to'liq kenglikdagi rangli chiziq (urg'u uchun)
    const boldBarSvg = theme === 'bold' ? `<rect x="0" y="${height - 8}" width="${width}" height="8" fill="${safeColor}"/>` : '';

    // ── Erkin joylashtirish: har bir guruhning standart joyidan qancha
    // sudralganini pikselga aylantiramiz (foydalanuvchi hech narsani
    // sudramagan bo'lsa — 0,0, ya'ni ko'rinish avvalgidek qoladi) ──
    const badgeOff = this.resolveOffset(input, 'badge', width, height);
    const chipsOff = this.resolveOffset(input, 'chips', width, height);
    const starsOff = this.resolveOffset(input, 'stars', width, height);
    const titleOff = this.resolveOffset(input, 'title', width, height);
    const hotelOff = this.resolveOffset(input, 'hotel', width, height);
    const infoOff = this.resolveOffset(input, 'info', width, height);
    const priceOff = this.resolveOffset(input, 'price', width, height);
    const dateOff = this.resolveOffset(input, 'date', width, height);
    const footerOff = this.resolveOffset(input, 'footer', width, height);
    const logoOff = this.resolveOffset(input, 'logo', width, height);

    // ── Brend logotipi (standart: yuqori-o'ng burchak) ──
    const logoSvg = logo?.dataUri
      ? (() => {
          const ls = Math.max(40, Math.min(280, logo.size || 120));
          const lx = width - 60 - ls + logoOff.dx;
          const ly = 60 + logoOff.dy;
          return `<g>
    <rect x="${lx - 10}" y="${ly - 10}" width="${ls + 20}" height="${ls + 20}" rx="18" fill="#FFFFFF" fill-opacity="0.14"/>
    <image x="${lx}" y="${ly}" width="${ls}" height="${ls}" href="${logo.dataUri}" preserveAspectRatio="xMidYMid meet"/>
  </g>`;
        })()
      : '';

    // "minimal" temasida gradient yuqoriroqdan (kamroq maydonda) boshlanadi,
    // boshqa temalarda avvalgidek (100% bir xil, mavjud bannerlar buzilmasin)
    const gradMidStop = theme === 'minimal' ? 70 : 55;
    const gradMidOpacity = theme === 'minimal' ? darkness * 0.1 : darkness * 0.18;

    return `
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="${gradMidStop}%" stop-color="#000000" stop-opacity="${gradMidOpacity.toFixed(2)}"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="${darkness.toFixed(2)}"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="${width}" height="${height}" fill="url(#fade)"/>

  ${
    showBadge
      ? `<g transform="translate(${badgeOff.dx.toFixed(1)},${badgeOff.dy.toFixed(1)})">
  <rect x="60" y="${height - 410}" width="${eyebrowWidth}" height="36" rx="18" fill="${theme === 'bold' ? safeColor : '#FFFFFF'}" fill-opacity="${theme === 'bold' ? 1 : 0.14}" stroke="${safeColor}" stroke-opacity="0.5"/>
  <text x="76" y="${height - 386}" font-family="${font}" font-size="16" font-weight="800" letter-spacing="1.5" fill="${theme === 'bold' ? '#FFFFFF' : safeColor}">${eyebrowText}</text>
  </g>`
      : ''
  }

  <g transform="translate(${chipsOff.dx.toFixed(1)},${chipsOff.dy.toFixed(1)})">
  ${extraChipsSvg}
  </g>

  ${
    stars
      ? `<g transform="translate(${starsOff.dx.toFixed(1)},${starsOff.dy.toFixed(1)})"><text x="60" y="${height - 330}" font-family="${font}" font-size="30" fill="#FFD54A" font-weight="700" letter-spacing="4">${stars}</text></g>`
      : ''
  }

  <g transform="translate(${titleOff.dx.toFixed(1)},${titleOff.dy.toFixed(1)})">
  <text x="60" y="${height - 280}" font-family="${font}" font-size="52" font-weight="800" fill="${textColor}">${destination}</text>
  </g>

  ${
    hotel && !useHotelList
      ? `<g transform="translate(${hotelOff.dx.toFixed(1)},${hotelOff.dy.toFixed(1)})"><text x="60" y="${height - 220}" font-family="${font}" font-size="32" font-weight="600" fill="${textColor}" fill-opacity="0.94">${hotel}</text></g>`
      : ''
  }

  ${
    infoLine
      ? `<g transform="translate(${infoOff.dx.toFixed(1)},${infoOff.dy.toFixed(1)})"><text x="60" y="${height - 170}" font-family="${font}" font-size="26" fill="${textColor}" fill-opacity="0.85">${infoLine}</text></g>`
      : ''
  }

  <g transform="translate(${priceOff.dx.toFixed(1)},${priceOff.dy.toFixed(1)})">
  ${
    useHotelList
      ? hotelListSvg
      : `<rect x="60" y="${height - (priceChipHeight === 86 ? 138 : 124)}" width="${priceChipWidth}" height="${priceChipHeight}" rx="16" fill="${safeColor}"/>
  <text x="${60 + priceChipWidth / 2}" y="${height - (priceChipHeight === 86 ? 84 : 78)}" font-family="${font}" font-size="${priceFontSize}" font-weight="800" fill="#FFFFFF" text-anchor="middle">${priceText}</text>`
  }
  </g>

  ${
    dateLine && !useHotelList
      ? `<g transform="translate(${dateOff.dx.toFixed(1)},${dateOff.dy.toFixed(1)})">
  <rect x="${width - 60 - datePillWidth}" y="${height - 150}" width="${datePillWidth}" height="40" rx="20" fill="#FFFFFF" fill-opacity="0.14" stroke="#FFFFFF" stroke-opacity="0.2"/>
  <text x="${width - 60 - datePillWidth / 2}" y="${height - 124}" font-family="${font}" font-size="22" font-weight="600" fill="${textColor}" text-anchor="middle">📅 ${dateLine}</text>
  </g>`
      : ''
  }

  <g transform="translate(${footerOff.dx.toFixed(1)},${footerOff.dy.toFixed(1)})">
  ${footer ? `<rect x="60" y="${height - 46}" width="${width - 120}" height="1" fill="${theme === 'bold' ? safeColor : '#FFFFFF'}" fill-opacity="${theme === 'bold' ? 0.6 : 0.16}"/>` : ''}

  ${
    footer
      ? `<text x="60" y="${height - 26}" font-family="${font}" font-size="22" fill="#CFCFCF">${footer}</text>`
      : ''
  }
  </g>

  ${logoSvg}

  ${boldBarSvg}

  ${borderSvg}
</svg>`.trim();
  }

  /**
   * "gallery" temasi uchun: berilgan URL'dagi suratni `w`×`h`ga
   * (kichraytirib/kesib, "cover" rejimida) moslaydi va dumaloq
   * burchakli (radius `r`) shaffof-fonli PNG buferga aylantiradi —
   * shu holda asosiy banner ustiga to'g'ridan-to'g'ri qo'yish mumkin
   * ("rasm ustiga rasm"). Yuklab bo'lmasa yoki xato chiqsa — `null`
   * qaytaradi (banner baribir, shu suratsiz, muvaffaqiyatli chiqadi).
   */
  private async buildRoundedImage(url: string, w: number, h: number, r: number): Promise<Buffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const resized = await sharp(buf)
        .resize(w, h, { fit: 'cover', position: 'attention' })
        .toBuffer();
      const mask = Buffer.from(
        `<svg width="${w}" height="${h}"><rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
      );
      return await sharp(resized)
        .composite([{ input: mask, blend: 'dest-in' }])
        .png()
        .toBuffer();
    } catch (e: any) {
      this.logger.warn(`Galereya suratini tayyorlashda xato (o'tkazib yuborildi): ${e.message}`);
      return null;
    }
  }

  /**
   * Fon surati + matn qatlamini birlashtirib, tayyor 1080×1080
   * banner (PNG) yaratadi va doimiy saqlashga (Supabase/mahalliy
   * disk) yuklab, ochiq URL qaytaradi.
   */
  async generateBanner(tenantId: string, rawInput: TourAdInput): Promise<BannerOutput> {
    if (!rawInput.price) {
      throw new BadRequestException('Narx kiritilishi shart');
    }
    const { input, template } = await this.mergeWithTemplate(tenantId, rawInput);

    // 1) Fon surati — foydalanuvchi bergan bo'lsa o'shani, aks holda avval
    // agentlikning O'ZI yuklagan mehmonxona rasm kutubxonasidan (agar shu
    // mehmonxona uchun avval rasm saqlangan bo'lsa — bu haqiqiy, tanish
    // surat bo'lgani uchun stok-fotoga qaraganda afzal), topilmasa —
    // avtomatik stok-foto qidiruviga o'tamiz (1-bosqichdagi findImages()).
    let sourceImage = input.imageUrl;
    if (!sourceImage && input.hotelName) {
      const libraryPhotos = await this.getHotelPhotos(tenantId, input.hotelName);
      sourceImage = libraryPhotos[0];
    }
    if (!sourceImage) {
      const found = await this.findImages(input.destination, 1);
      sourceImage = found[0];
    }
    if (!sourceImage) {
      throw new BadRequestException(
        "Fon surati topilmadi. Rasm URL'ini kiriting yoki PEXELS_API_KEY sozlanganini tekshiring.",
      );
    }

    // 2) Fon suratini yuklab olamiz
    let bgBuffer: Buffer;
    try {
      const res = await fetch(sourceImage);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bgBuffer = Buffer.from(await res.arrayBuffer());
    } catch (e: any) {
      throw new BadRequestException(`Fon suratini yuklab bo'lmadi: ${e.message}`);
    }

    // 2.5) Brend logotipi (agar tenant Shablon bo'limida yuklagan bo'lsa) —
    // SVG ichiga base64 sifatida joylash uchun oldindan yuklab olamiz
    // (librsvg tashqi URL'larni o'zi yuklay olmaydi, faqat data: URI'ni
    // to'g'ridan-to'g'ri dekodlaydi). Logotip topilmasa yoki yuklanmasa —
    // banner baribir logotipsiz muvaffaqiyatli yaratiladi (xato chiqmaydi).
    let logo: { dataUri: string; size: number } | undefined;
    if (template.logoUrl) {
      try {
        const lres = await fetch(template.logoUrl);
        if (lres.ok) {
          const lbuf = Buffer.from(await lres.arrayBuffer());
          const ct = lres.headers.get('content-type') || 'image/png';
          logo = {
            dataUri: `data:${ct};base64,${lbuf.toString('base64')}`,
            size: Math.max(40, Math.min(280, Number(template.logoSize) || 120)),
          };
        }
      } catch (e: any) {
        this.logger.warn(`Brend logotipini yuklab bo'lmadi (bannerga qo'yilmadi): ${e.message}`);
      }
    }

    // 3) Kerakli o'lchamga (kvadrat 1080×1080 yoki Story 1080×1920) moslab
    // kesib olamiz, ustiga (shablondagi brend rangi va tanlangan dizayn
    // uslubi bilan) matn qatlamini qo'shamiz
    const width = 1080;
    const height = input.bannerFormat === 'story' ? 1920 : 1080;
    const theme: 'classic' | 'minimal' | 'bold' | 'gallery' =
      input.bannerTheme === 'minimal' || input.bannerTheme === 'bold' || input.bannerTheme === 'gallery'
        ? input.bannerTheme
        : 'classic';

    // "gallery" temasi: fon surat ustiga QO'SHIMCHA 1-2 ta surat
    // (masalan mehmonxona binosi + xona) — kichraytirilgan, dumaloq
    // burchakli panel sifatida, o'ng tomonda, matn bilan to'qnashmaydigan
    // (yuqori-o'rta) hududda joylanadi. Har bir surat ALOHIDA yuklanadi —
    // biri topilmasa ham banner qolganlari bilan muvaffaqiyatli chiqadi.
    const galleryLayers: sharp.OverlayOptions[] = [];
    if (theme === 'gallery' && input.galleryImages?.length) {
      const panelW = Math.round(width * 0.38);
      const panelH = Math.round(height * 0.155);
      const panelX = width - panelW - 60;
      let panelY = Math.round(height * 0.3);
      const urls = input.galleryImages.filter((u) => typeof u === 'string' && u.trim()).slice(0, 2);
      for (const imgUrl of urls) {
        const rounded = await this.buildRoundedImage(imgUrl.trim(), panelW, panelH, 22);
        if (rounded) {
          const frame = Buffer.from(
            `<svg width="${panelW + 16}" height="${panelH + 16}">` +
              `<rect width="${panelW + 16}" height="${panelH + 16}" rx="28" fill="#000000" fill-opacity="0.28"/></svg>`,
          );
          galleryLayers.push({ input: frame, left: panelX - 8, top: panelY - 8 });
          galleryLayers.push({ input: rounded, left: panelX, top: panelY });
          panelY += panelH + 20;
        }
      }
    }

    let pngBuffer: Buffer;
    try {
      const svg = this.buildBannerSvg(input, template.primaryColor, width, height, logo, theme);
      pngBuffer = await sharp(bgBuffer)
        .resize(width, height, { fit: 'cover', position: 'attention' })
        .composite([...galleryLayers, { input: Buffer.from(svg), top: 0, left: 0 }])
        .png({ quality: 90 })
        .toBuffer();
    } catch (e: any) {
      this.logger.error(`Banner yaratishda xato: ${e.message}`);
      throw new BadRequestException(`Banner yaratib bo'lmadi: ${e.message}`);
    }

    // 4) Doimiy saqlashga yuklaymiz (Supabase bo'lsa — Supabase'ga,
    // bo'lmasa — mahalliy diskka, avtomatik fallback)
    const fileName = `tour-banner-${Date.now()}.png`;
    const bannerUrl = await uploadBufferToStorage(pngBuffer, fileName, 'image/png');

    return { bannerUrl, sourceImage };
  }

  // ─────────────────────────────────────────────────────────────
  // TAYYOR REKLAMANI YUBORISH
  // ─────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────
  // TELEGRAM XABAR ANDOZASI (TurMaker uslubida) — Claude yozgan
  // erkin matn o'rniga, agentlik o'zi belgilagan qat'iy formatda
  // yuborish uchun. Andoza `AdTemplate.telegramMessageTemplate`da
  // saqlanadi, bo'lmasa DEFAULT_TELEGRAM_TEMPLATE ishlatiladi.
  // ─────────────────────────────────────────────────────────────
  private renderTemplateString(tpl: string, input: TourAdInput, template: AdTemplate): string {
    const people = `${input.adults || 1} kattalar${input.children ? `, ${input.children} bola` : ''}`;
    const stars = input.hotelStars ? '★'.repeat(Math.max(0, Math.min(5, Math.round(input.hotelStars)))) : '';
    const map: Record<string, string> = {
      destination: input.destination || '',
      hotel: input.hotelName || '',
      stars,
      nights: input.nights ? String(input.nights) : '',
      meal: input.mealPlan || '',
      people,
      price: `${Math.round(input.price || 0).toLocaleString('ru-RU')} ${input.currency || 'USD'}`,
      dates: input.departureDate
        ? `${input.departureDate}${input.returnDate ? ` — ${input.returnDate}` : ''}`
        : '',
      agency: input.agencyName || template.agencyName || '',
      contact: input.agencyContact || template.agencyContact || '',
    };
    return tpl.replace(/\{(\w+)\}/g, (_m, key: string) => map[key] ?? '').replace(/\n{3,}/g, '\n\n').trim();
  }

  async renderTelegramTemplate(tenantId: string, rawInput: TourAdInput): Promise<{ text: string }> {
    const { input, template } = await this.mergeWithTemplate(tenantId, rawInput);
    const tpl = template.telegramMessageTemplate?.trim() || DEFAULT_TELEGRAM_TEMPLATE;
    return { text: this.renderTemplateString(tpl, input, template) };
  }

  /**
   * ✅ TELEGRAM: to'liq ishlaydi. Tenant'ning mavjud Telegram botidan
   * foydalanadi (Sozlamalar → Telegram bo'limida ulangan bo'lishi
   * kerak). Bot yuborilayotgan kanalning ADMINISTRATORI bo'lishi
   * shart — bu Telegram'ning o'zining cheklovi, boshqacha yo'l yo'q.
   */
  async sendToTelegram(
    tenantId: string,
    data: { chatId: string; photoUrl: string; caption: string; telegramAccountId?: string },
  ): Promise<{ messageId: number }> {
    return this.telegram.sendAdToChannel(
      tenantId,
      data.chatId,
      data.photoUrl,
      data.caption,
      data.telegramAccountId,
    );
  }

  /**
   * ⚠️ INSTAGRAM: hozircha AVTOMATIK joylash MUMKIN EMAS — bu
   * texnik cheklov, kamchilik emas. Sababi:
   *
   * Instagram'ga dasturiy ravishda (feed'ga) post qo'yish uchun
   * Meta'dan `instagram_content_publish` ruxsati kerak. Bizning
   * ilovamiz hozircha faqat `leads_retrieval`, `pages_show_list`,
   * `pages_manage_metadata`, `pages_read_engagement`,
   * `pages_manage_ads` ruxsatlarini so'ragan (Facebook Ads Leads
   * integratsiyasi uchun) — bular Instagram'ga POST QILISH uchun
   * YETARLI EMAS.
   *
   * Yechim: keyingi Meta App Review'da `instagram_content_publish`
   * ruxsatini QO'SHIMCHA so'rash kerak bo'ladi (buni alohida qilib
   * berishga tayyorman). Shu vaqtgacha, foydalanuvchi tayyor rasm
   * (banner) va matnni yuklab olib, Instagram'ga QO'LDA joylashi
   * mumkin — bu funksiya shuning uchun rasm/matnni "tayyor holda"
   * qaytaradi, xolos.
   */
  async prepareForInstagramManualPost(
    caption: string,
    bannerUrl: string,
  ): Promise<{ caption: string; bannerUrl: string; note: string }> {
    return {
      caption,
      bannerUrl,
      note:
        "Instagram'ga avtomatik joylash hali yo'q (Meta'dan qo'shimcha ruxsat kerak). " +
        "Rasmni yuklab oling va ushbu matn bilan qo'lda joylang.",
    };
  }

  // ─────────────────────────────────────────────────────────────
  // TARIX (History) — har bir tayyorlangan reklamani saqlab, keyin
  // ochib qayta tahrirlash/qayta yuborish uchun. `AdTemplate` bilan
  // bir xil yondashuv: `Tenant.settings.adHistory` JSON massivi
  // ichida — yangi migratsiya SHART EMAS. Oxirgi 40 tasi saqlanadi.
  // ─────────────────────────────────────────────────────────────
  private static readonly MAX_HISTORY = 40;

  async saveAdHistory(
    tenantId: string,
    entry: { input: TourAdInput; bannerUrl?: string; images?: string[]; posts?: TourAdOutput['posts'] },
  ): Promise<{ id: string; createdAt: string }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    if (!tenant) throw new NotFoundException('Tenant topilmadi');

    const currentSettings = (tenant.settings as any) || {};
    const history: any[] = Array.isArray(currentSettings.adHistory) ? currentSettings.adHistory : [];

    const record = {
      id: `ad_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      input: entry.input,
      bannerUrl: entry.bannerUrl || null,
      images: entry.images || [],
      posts: entry.posts || null,
      createdAt: new Date().toISOString(),
    };

    const updated = [record, ...history].slice(0, AiMarketingService.MAX_HISTORY);

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: { ...currentSettings, adHistory: updated } as any },
    });

    return { id: record.id, createdAt: record.createdAt };
  }

  async listAdHistory(tenantId: string): Promise<any[]> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const history = ((tenant?.settings as any) || {}).adHistory;
    return Array.isArray(history) ? history : [];
  }

  async getAdHistoryItem(tenantId: string, id: string): Promise<any> {
    const history = await this.listAdHistory(tenantId);
    const found = history.find((h: any) => h.id === id);
    if (!found) throw new NotFoundException("Tarixdan yozuv topilmadi");
    return found;
  }

  async deleteAdHistory(tenantId: string, id: string): Promise<{ deleted: boolean }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    if (!tenant) throw new NotFoundException('Tenant topilmadi');
    const currentSettings = (tenant.settings as any) || {};
    const history: any[] = Array.isArray(currentSettings.adHistory) ? currentSettings.adHistory : [];
    const updated = history.filter((h: any) => h.id !== id);

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: { ...currentSettings, adHistory: updated } as any },
    });

    return { deleted: updated.length !== history.length };
  }

  // ─────────────────────────────────────────────────────────────
  // ✅ FACEBOOK: Sahifaga (Page) avtomatik joylash.
  //
  // Instagram'dan farqli o'laroq, bu texnik jihatdan mumkin —
  // oddiy Page fotosini joylash uchun Meta App Review SHART EMAS
  // (faqat `pages_manage_posts` ruxsati kerak). Tenant Sozlamalar →
  // Facebook Ads bo'limida sahifasini ulagan bo'lishi kerak (o'sha
  // ulanish `facebook-leads` moduli orqali allaqachon mavjud —
  // shu yerda faqat saqlangan Page Access Token qayta ishlatiladi).
  //
  // MUHIM: agar tenant sahifani ESKI ruxsatlar bilan ulagan bo'lsa
  // (`pages_manage_posts` so'ralmasdan), shu Page Access Token bilan
  // post qo'yish Meta tomonidan rad etiladi — bunday holda tenant
  // Sozlamalar → Facebook Ads'da sahifani QAYTA ulashi kerak bo'ladi.
  // ─────────────────────────────────────────────────────────────
  async sendToFacebookPage(
    tenantId: string,
    data: { photoUrl: string; caption: string },
  ): Promise<{ postId: string }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true, facebookPageId: true },
    });
    const s: any = tenant?.settings || {};
    const pageId = tenant?.facebookPageId || s.facebookPageId;
    const encToken = s.facebookPageAccessToken;

    if (!pageId || !encToken) {
      throw new BadRequestException(
        "Facebook sahifasi ulanmagan. Avval Sozlamalar → Facebook Ads bo'limida sahifangizni ulang.",
      );
    }

    const accessToken = this.encryption.decrypt(encToken);
    if (!accessToken) {
      throw new BadRequestException(
        "Facebook tokeni o'qib bo'lmadi — Sozlamalar → Facebook Ads'da sahifani qaytadan ulang.",
      );
    }

    try {
      const url = `https://graph.facebook.com/v23.0/${pageId}/photos`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: data.photoUrl,
          caption: data.caption,
          access_token: accessToken,
        }),
      });
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || !j?.post_id) {
        const msg = j?.error?.message || `HTTP ${res.status}`;
        // `pages_manage_posts` ruxsati yo'q bo'lsa Meta odatda shu turdagi
        // xatoni qaytaradi — foydalanuvchiga aniq nima qilish kerakligini aytamiz
        if (/permission|scope|OAuthException/i.test(msg)) {
          throw new Error(
            `${msg}. Ehtimol sahifa "pages_manage_posts" ruxsatisiz ulangan — Sozlamalar → ` +
              `Facebook Ads'da sahifani qaytadan ulang.`,
          );
        }
        throw new Error(msg);
      }
      return { postId: j.post_id };
    } catch (e: any) {
      this.logger.error(`Facebook'ga yuborishda xato: ${e.message}`);
      throw new BadRequestException(`Facebook'ga yuborib bo'lmadi: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ✅ INSTAGRAM: avtomatik joylash — bog'langan Facebook sahifasi
  // orqali (alohida Instagram login SHART EMAS). Instagram Business/
  // Creator hisobi Meta tomonidan doim biror Facebook sahifasiga
  // ULANGAN holda ishlaydi — shu sahifaning Page Access Token'i bilan
  // Meta'ning "Content Publishing API"siga (2 bosqich: konteyner
  // yaratish → chop etish) so'rov yuboramiz.
  //
  // SHART: ilova Meta App Review'da `instagram_basic` va
  // `instagram_content_publish` ruxsatlarini olgan bo'lishi kerak
  // (hozircha `facebook-leads` integratsiyasi faqat lead-ruxsatlarni
  // so'ragan edi — bu YANGI, qo'shimcha ruxsat, Meta App Review orqali
  // alohida so'raladi). Ruxsat hali tasdiqlanmagan bo'lsa, Meta aniq
  // xato qaytaradi — shu xato quyida tushunarli qilib ko'rsatiladi.
  // ─────────────────────────────────────────────────────────────
  async sendToInstagram(
    tenantId: string,
    data: { photoUrl: string; caption: string },
  ): Promise<{ postId: string }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true, facebookPageId: true },
    });
    const s: any = tenant?.settings || {};
    const pageId = tenant?.facebookPageId || s.facebookPageId;
    const encToken = s.facebookPageAccessToken;

    if (!pageId || !encToken) {
      throw new BadRequestException(
        "Facebook sahifasi ulanmagan (Instagram shu sahifa orqali ishlaydi). Avval Sozlamalar → " +
          "Facebook Ads bo'limida sahifangizni ulang, so'ng o'sha sahifaga Instagram Business " +
          "hisobingizni bog'lang.",
      );
    }
    const accessToken = this.encryption.decrypt(encToken);
    if (!accessToken) {
      throw new BadRequestException(
        "Facebook tokeni o'qib bo'lmadi — Sozlamalar → Facebook Ads'da sahifani qaytadan ulang.",
      );
    }

    try {
      // 1) Shu sahifaga bog'langan Instagram Business hisobini topamiz
      const igRes = await fetch(
        `https://graph.facebook.com/v23.0/${pageId}?fields=instagram_business_account` +
          `&access_token=${encodeURIComponent(accessToken)}`,
      );
      const igJ: any = await igRes.json().catch(() => ({}));
      const igUserId = igJ?.instagram_business_account?.id;
      if (!igRes.ok || !igUserId) {
        throw new Error(
          "Bu Facebook sahifasiga Instagram Business/Creator hisobi bog'lanmagan. Instagram " +
            "ilovasida: Sozlamalar → Hisob turi → Professional hisobga o'ting, so'ng uni shu " +
            'Facebook sahifasiga ulang (Meta Business Suite orqali ham qilsa bo\'ladi).',
        );
      }

      // 2) Media konteyner yaratamiz (rasm URL'i + caption)
      const createRes = await fetch(`https://graph.facebook.com/v23.0/${igUserId}/media`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_url: data.photoUrl,
          caption: data.caption,
          access_token: accessToken,
        }),
      });
      const createJ: any = await createRes.json().catch(() => ({}));
      if (!createRes.ok || !createJ?.id) {
        const msg = createJ?.error?.message || `HTTP ${createRes.status}`;
        if (/permission|scope|OAuthException|content_publish/i.test(msg)) {
          throw new Error(
            `${msg}. Ilova Meta'dan "instagram_content_publish" ruxsatini olishi kerak — bu ` +
              "Meta App Review orqali alohida so'raladi (hozirgi ruxsatlarga qo'shimcha).",
          );
        }
        throw new Error(msg);
      }

      // 3) Konteynerni chop etamiz — shu payt post haqiqatan Instagram feed'iga tushadi
      const pubRes = await fetch(`https://graph.facebook.com/v23.0/${igUserId}/media_publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creation_id: createJ.id, access_token: accessToken }),
      });
      const pubJ: any = await pubRes.json().catch(() => ({}));
      if (!pubRes.ok || !pubJ?.id) {
        const msg = pubJ?.error?.message || `HTTP ${pubRes.status}`;
        throw new Error(msg);
      }
      return { postId: pubJ.id };
    } catch (e: any) {
      this.logger.error(`Instagram'ga yuborishda xato: ${e.message}`);
      throw new BadRequestException(`Instagram'ga yuborib bo'lmadi: ${e.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 🚀 BITTA TUGMA: tur ma'lumotlaridan banner yaratadi va TANLANGAN
  // barcha kanallarga (Telegram/Facebook/Instagram) BIR so'rovda
  // joylaydi — masalan tur yaratish oynasidan to'g'ridan-to'g'ri
  // chaqirish uchun mo'ljallangan. Har bir kanal ALOHIDA-ALOHIDA
  // urinadi: biri xato bersa ham (masalan Instagram ulanmagan bo'lsa),
  // boshqalari (Telegram/Facebook) baribir yuboriladi — natija VA xato
  // har bir kanal uchun alohida qaytadi, chaqiruvchi tomon aniq
  // qaysi kanal muvaffaqiyatli bo'lganini ko'ra oladi.
  // ─────────────────────────────────────────────────────────────
  async publishTour(
    tenantId: string,
    body: {
      input: TourAdInput;
      telegram?: { chatId: string; telegramAccountId?: string; caption?: string; useTemplate?: boolean };
      facebook?: { caption?: string };
      instagram?: { caption?: string };
    },
  ): Promise<{
    bannerUrl: string;
    results: { telegram?: { messageId: number }; facebook?: { postId: string }; instagram?: { postId: string } };
    errors: { telegram?: string; facebook?: string; instagram?: string };
  }> {
    const banner = await this.generateBanner(tenantId, body.input);
    const results: any = {};
    const errors: any = {};

    // AI copywriter matnini kerak bo'lgandagina va FAQAT BIR MARTA
    // so'raymiz (bir nechta kanal caption bermagan bo'lsa ham qayta-qayta
    // so'ramaslik uchun) — AI o'chiq/sozlanmagan bo'lsa ham xato tashlamaydi,
    // shunchaki `null` qaytadi, shunda oddiy matn (fallback) ishlatiladi.
    let cachedPosts: TourAdOutput['posts'] | null | undefined;
    const getPosts = async () => {
      if (cachedPosts === undefined) {
        cachedPosts = await this.generatePosts(body.input).catch(() => null);
      }
      return cachedPosts;
    };
    const fallbackCaption = () =>
      `${body.input.destination}${body.input.hotelName ? ` — ${body.input.hotelName}` : ''}\n` +
      `💰 ${Math.round(body.input.price).toLocaleString('ru-RU')} ${body.input.currency || 'USD'}`;

    if (body.telegram?.chatId) {
      try {
        let caption = body.telegram.caption;
        if (!caption && body.telegram.useTemplate !== false) {
          const rendered = await this.renderTelegramTemplate(tenantId, body.input);
          caption = rendered.text;
        }
        if (!caption) caption = (await getPosts())?.telegram || fallbackCaption();
        results.telegram = await this.sendToTelegram(tenantId, {
          chatId: body.telegram.chatId,
          photoUrl: banner.bannerUrl,
          caption,
          telegramAccountId: body.telegram.telegramAccountId,
        });
      } catch (e: any) {
        errors.telegram = e?.message || "Telegram'ga yuborib bo'lmadi";
      }
    }

    if (body.facebook) {
      try {
        const caption = body.facebook.caption || (await getPosts())?.facebook || fallbackCaption();
        results.facebook = await this.sendToFacebookPage(tenantId, { photoUrl: banner.bannerUrl, caption });
      } catch (e: any) {
        errors.facebook = e?.message || "Facebook'ga yuborib bo'lmadi";
      }
    }

    if (body.instagram) {
      try {
        const caption = body.instagram.caption || (await getPosts())?.instagram || fallbackCaption();
        results.instagram = await this.sendToInstagram(tenantId, { photoUrl: banner.bannerUrl, caption });
      } catch (e: any) {
        errors.instagram = e?.message || "Instagram'ga yuborib bo'lmadi";
      }
    }

    return { bannerUrl: banner.bannerUrl, results, errors };
  }
}

@Controller('ai-marketing')
@UseGuards(JwtAuthGuard)
export class AiMarketingController {
  constructor(private readonly svc: AiMarketingService) {}

  /** Tur ma'lumotlaridan rasm + 3 ta tayyor post (Instagram/Telegram/Facebook) */
  @Post('generate')
  generate(@CurrentUser() u: any, @Body() body: TourAdInput) {
    if (!body?.destination) {
      throw new BadRequestException("Yo'nalish (destination) kiritilishi shart");
    }
    if (!body?.price) {
      throw new BadRequestException('Narx kiritilishi shart');
    }
    return this.svc.generateTourAd(u.tenantId, body);
  }

  /** Faqat rasm qidirish (masalan foydalanuvchi natijani yoqtirmasa, qayta qidirish uchun) */
  @Post('images')
  async images(
    @CurrentUser() u: any,
    @Body() body: { query: string; count?: number; hotelName?: string },
  ) {
    if (!body?.query) throw new BadRequestException("Qidiruv so'zi (query) kerak");
    // Agentlikning o'zi yuklagan mehmonxona rasmlari (bo'lsa) — stok-fotodan
    // OLDIN ko'rsatiladi, chunki bular haqiqiy, tanish surat.
    const libraryPhotos = body.hotelName
      ? await this.svc.getHotelPhotos(u.tenantId, body.hotelName)
      : [];
    // Bu yerda (foydalanuvchi "🔍 Rasm topish"ni to'g'ridan-to'g'ri bosganda)
    // sabab ANIQ ko'rsatilishi kerak — aks holda "rasm topilmadi" umuman
    // noaniq bo'lib qoladi, admin muammoni tushuna olmaydi. Agar kutubxonada
    // kamida bitta rasm bo'lsa, kalit sozlanmagan bo'lsa ham xato tashlamaymiz
    // (chunki foydalanuvchiga hali ham ko'rsatadigan narsamiz bor).
    if (!this.svc.imagesConfigured() && !libraryPhotos.length) {
      throw new BadRequestException(
        "Rasm qidirish yoqilmagan: serverda PEXELS_API_KEY yoki UNSPLASH_ACCESS_KEY " +
          "o'rnatilmagan. Bepul kalitni pexels.com/api yoki unsplash.com/developers'dan " +
          "olib, backend serveridagi .env fayliga qo'shing va serverni qayta ishga tushiring.",
      );
    }
    const stockPhotos = this.svc.imagesConfigured()
      ? await this.svc.findImages(body.query, body.count || 16)
      : [];
    return Array.from(new Set([...libraryPhotos, ...stockPhotos]));
  }

  /**
   * Stok-foto qidirish o'rniga — AI orqali tur ma'lumotlariga mos
   * YANGI, noyob fon surat generatsiya qiladi (ixtiyoriy funksiya,
   * serverda STABILITY_API_KEY sozlangan bo'lishi kerak).
   */
  @Post('images/ai-generate')
  async aiGenerateImage(
    @CurrentUser() u: any,
    @Body() body: { prompt?: string; destination?: string; hotelName?: string },
  ) {
    if (!this.svc.aiImageConfigured()) {
      throw new BadRequestException(
        "AI rasm generatori yoqilmagan: serverda STABILITY_API_KEY o'rnatilmagan. Claude (matn AI) " +
          "surat chiza olmaydi, shu sabab rasm generatsiyasi uchun alohida kalit kerak — " +
          "platform.stability.ai'dan olib, backend serveridagi .env fayliga qo'shing va serverni " +
          "qayta ishga tushiring.",
      );
    }
    const prompt =
      body.prompt?.trim() ||
      `Professional high-quality travel photography of ${body.destination || 'a beautiful travel destination'}` +
        `${body.hotelName ? `, near ${body.hotelName} hotel` : ''}, vibrant colors, golden hour lighting, ` +
        'wide shot, no text, no watermark, no people close-up';
    const url = await this.svc.generateAiImage(u.tenantId, prompt);
    return { url };
  }

  // ── MEHMONXONA RASM KUTUBXONASI ──

  /** Berilgan mehmonxona uchun avval saqlangan (agentlikning o'zi yuklagan) rasmlar */
  @Get('hotel-photos')
  getHotelPhotos(@CurrentUser() u: any, @Query('hotelName') hotelName: string) {
    if (!hotelName?.trim()) throw new BadRequestException('Mehmonxona nomi (hotelName) kerak');
    return this.svc.getHotelPhotos(u.tenantId, hotelName);
  }

  /** Barcha mehmonxonalar ro'yxati va nechta rasm saqlanganini ko'rsatadi */
  @Get('hotel-photos/all')
  listHotelPhotoLibrary(@CurrentUser() u: any) {
    return this.svc.listHotelPhotoLibrary(u.tenantId);
  }

  /** Mehmonxona uchun yangi (haqiqiy) rasm yuklaydi — keyingi safar avtomatik taklif qilinadi */
  @Post('hotel-photos')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadHotelPhoto(
    @CurrentUser() u: any,
    @Body('hotelName') hotelName: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.svc.saveHotelPhoto(u.tenantId, hotelName, file);
  }

  /** Kutubxonadan bitta rasmni o'chirish */
  @Delete('hotel-photos')
  deleteHotelPhoto(@CurrentUser() u: any, @Body() body: { hotelName: string; url: string }) {
    if (!body?.hotelName || !body?.url) throw new BadRequestException("hotelName va url kerak");
    return this.svc.deleteHotelPhoto(u.tenantId, body.hotelName, body.url);
  }

  /** TurMaker uslubidagi "davlat → mashhur joylar" ro'yxati (tanlagich uchun) */
  @Get('destinations')
  destinations(@CurrentUser() _u: any) {
    return this.svc.getPopularDestinations();
  }

  /** Tur ma'lumotlaridan tayyor 1080×1080 banner (PNG URL) yaratadi */
  @Post('banner')
  banner(@CurrentUser() u: any, @Body() body: TourAdInput) {
    if (!body?.destination) {
      throw new BadRequestException("Yo'nalish (destination) kiritilishi shart");
    }
    if (!body?.price) {
      throw new BadRequestException('Narx kiritilishi shart');
    }
    return this.svc.generateBanner(u.tenantId, body);
  }

  // ── SHABLON (Template) ──

  /** Agentlikning saqlangan reklama shablonini olish (brend, kontakt, rang) */
  @Get('template')
  getTemplate(@CurrentUser() u: any) {
    return this.svc.getTemplate(u.tenantId);
  }

  /** Reklama shablonini saqlash/yangilash */
  @Patch('template')
  saveTemplate(@CurrentUser() u: any, @Body() body: AdTemplate) {
    return this.svc.saveTemplate(u.tenantId, body);
  }

  /** Brend logotipini yuklash — shundan keyin har bir banner avtomatik shu bilan chiqadi */
  @Post('logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadLogo(@CurrentUser() u: any, @UploadedFile() file: Express.Multer.File) {
    return this.svc.uploadLogo(u.tenantId, file);
  }

  /** Bannerlardan brend logotipini olib tashlash */
  @Delete('logo')
  removeLogo(@CurrentUser() u: any) {
    return this.svc.removeLogo(u.tenantId);
  }

  // ── YUBORISH ──

  /** Telegram uchun qat'iy formatdagi andozani (shablonni) tur ma'lumotlari bilan to'ldirib ko'rsatadi */
  @Post('telegram/render-template')
  renderTelegramTemplate(@CurrentUser() u: any, @Body() body: TourAdInput) {
    if (!body?.destination) throw new BadRequestException("Yo'nalish (destination) kiritilishi shart");
    return this.svc.renderTelegramTemplate(u.tenantId, body);
  }

  /** Tayyor bannerni Telegram kanaliga yuboradi (bot kanalga admin bo'lishi shart) */
  @Post('send/telegram')
  sendTelegram(
    @CurrentUser() u: any,
    @Body() body: { chatId: string; photoUrl: string; caption: string; telegramAccountId?: string },
  ) {
    if (!body?.chatId) throw new BadRequestException('Kanal ID/username kerak');
    if (!body?.photoUrl) throw new BadRequestException("Rasm URL'i kerak");
    if (!body?.caption) throw new BadRequestException('Post matni (caption) kerak');
    return this.svc.sendToTelegram(u.tenantId, body);
  }

  /**
   * Instagram — hozircha AVTOMATIK joylash yo'q (Meta'dan qo'shimcha
   * ruxsat kerak, batafsil: AiMarketingService.prepareForInstagramManualPost
   * izohida). Bu endpoint tayyor matn+rasmni qo'lda joylash uchun qaytaradi.
   */
  @Post('instagram/prepare')
  instagramPrepare(
    @CurrentUser() _u: any,
    @Body() body: { caption: string; bannerUrl: string },
  ) {
    if (!body?.caption) throw new BadRequestException('Post matni (caption) kerak');
    if (!body?.bannerUrl) throw new BadRequestException("Banner URL'i kerak");
    return this.svc.prepareForInstagramManualPost(body.caption, body.bannerUrl);
  }

  /** Tayyor bannerni Facebook sahifasiga (Page) avtomatik joylaydi */
  @Post('send/facebook')
  sendFacebook(@CurrentUser() u: any, @Body() body: { photoUrl: string; caption: string }) {
    if (!body?.photoUrl) throw new BadRequestException("Rasm URL'i kerak");
    if (!body?.caption) throw new BadRequestException('Post matni (caption) kerak');
    return this.svc.sendToFacebookPage(u.tenantId, body);
  }

  /**
   * Tayyor bannerni bog'langan Instagram Business/Creator hisobiga
   * avtomatik joylaydi (Facebook sahifasi orqali — batafsil izoh
   * `AiMarketingService.sendToInstagram`da).
   */
  @Post('send/instagram')
  sendInstagram(@CurrentUser() u: any, @Body() body: { photoUrl: string; caption: string }) {
    if (!body?.photoUrl) throw new BadRequestException("Rasm URL'i kerak");
    if (!body?.caption) throw new BadRequestException('Post matni (caption) kerak');
    return this.svc.sendToInstagram(u.tenantId, body);
  }

  /**
   * 🚀 BIR TUGMA: banner yaratadi va tanlangan kanallarga (Telegram/
   * Facebook/Instagram) bitta so'rovda joylaydi — tur yaratish oynasidan
   * to'g'ridan-to'g'ri chaqirish uchun mo'ljallangan. Har bir kanal
   * alohida urinadi, biri xato bersa ham qolganlari yuboriladi.
   */
  @Post('publish')
  publish(
    @CurrentUser() u: any,
    @Body()
    body: {
      input: TourAdInput;
      telegram?: { chatId: string; telegramAccountId?: string; caption?: string; useTemplate?: boolean };
      facebook?: { caption?: string } | boolean;
      instagram?: { caption?: string } | boolean;
    },
  ) {
    if (!body?.input?.destination) throw new BadRequestException("Yo'nalish (destination) kiritilishi shart");
    if (!body?.input?.price) throw new BadRequestException('Narx kiritilishi shart');
    return this.svc.publishTour(u.tenantId, {
      input: body.input,
      telegram: body.telegram,
      facebook: body.facebook === true ? {} : body.facebook || undefined,
      instagram: body.instagram === true ? {} : body.instagram || undefined,
    });
  }

  // ── TARIX (History) ──

  /** Tayyorlangan reklamani tarixga saqlaydi (keyin qayta ochish/tahrirlash uchun) */
  @Post('history')
  saveHistory(
    @CurrentUser() u: any,
    @Body() body: { input: TourAdInput; bannerUrl?: string; images?: string[]; posts?: TourAdOutput['posts'] },
  ) {
    if (!body?.input?.destination) throw new BadRequestException("Tur ma'lumotlari (input) kerak");
    return this.svc.saveAdHistory(u.tenantId, body);
  }

  /** So'nggi saqlangan reklamalar ro'yxati (eng yangisi birinchi) */
  @Get('history')
  listHistory(@CurrentUser() u: any) {
    return this.svc.listAdHistory(u.tenantId);
  }

  /** Bitta saqlangan reklamani olish (formani qayta to'ldirish uchun) */
  @Get('history/:id')
  getHistoryItem(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.getAdHistoryItem(u.tenantId, id);
  }

  /** Tarixdan bitta yozuvni o'chirish */
  @Delete('history/:id')
  deleteHistoryItem(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.deleteAdHistory(u.tenantId, id);
  }
}

@Module({
  imports: [TelegramModule],
  controllers: [AiMarketingController],
  providers: [AiMarketingService],
  exports: [AiMarketingService],
})
export class AiMarketingModule {}