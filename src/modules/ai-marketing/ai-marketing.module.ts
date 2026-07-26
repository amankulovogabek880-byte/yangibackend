import {
  Module,
  Injectable,
  Controller,
  Get,
  Post,
  Patch,
  Body,
  UseGuards,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import sharp from 'sharp';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { uploadBufferToStorage } from '../../common/utils/media-storage';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramModule, TelegramService } from '../telegram/telegram.module';

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
}

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
  ) {}

  private get anthropicKey() {
    return (process.env.ANTHROPIC_API_KEY || '').trim();
  }
  private get anthropicModel() {
    return (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5').trim();
  }
  private get pexelsKey() {
    return (process.env.PEXELS_API_KEY || '').trim();
  }

  isConfigured(): boolean {
    return !!this.anthropicKey;
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
   * Pexels (bepul stok-foto xizmati) orqali mavzuga mos rasmlarni
   * topadi. API kalit sozlanmagan bo'lsa — bo'sh massiv qaytaradi
   * (xato chiqarmaydi, chunki bu ixtiyoriy funksiya).
   */
  async findImages(query: string, count = 4): Promise<string[]> {
    if (!this.pexelsKey) {
      this.logger.warn('PEXELS_API_KEY sozlanmagan — rasm qidirish o\'tkazib yuborildi');
      return [];
    }
    try {
      const url =
        `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}` +
        `&per_page=${Math.max(1, Math.min(count, 10))}&orientation=square`;
      const res = await fetch(url, { headers: { Authorization: this.pexelsKey } });
      if (!res.ok) {
        this.logger.warn(`Pexels xato (HTTP ${res.status})`);
        return [];
      }
      const j: any = await res.json();
      const photos = Array.isArray(j?.photos) ? j.photos : [];
      return photos
        .map((p: any) => p?.src?.large || p?.src?.medium || p?.src?.original)
        .filter((u: any) => typeof u === 'string' && u.length > 0);
    } catch (e: any) {
      this.logger.warn(`Rasm qidirishda xato: ${e.message}`);
      return [];
    }
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

    const prompt = `Sen professional sayohat agentligi uchun ijtimoiy tarmoq kontent yozuvchisisan (SMM copywriter). Quyidagi tur ma'lumotlaridan foydalanib, 3 ta turdagi ijtimoiy tarmoq posti yoz — har biri o'ziga xos uslubda:

TUR MA'LUMOTLARI:
${facts}

QOIDALAR:
- O'zbek tilida yoz (lotin alifbosida)
- Haqiqiy, ishonchli, sotuvga yo'naltirilgan ohang — haqorat yoki aldov emas
- FAQAT yuqoridagi FAKTLARDAN foydalan, o'zingdan narx yoki xizmat qo'shma yoki o'zgartirma
- Instagram: qisqa, hissiy, 3-5 ta mos emoji, oxirida 5-8 ta hashtag (masalan #tur #antalya #sayohat)
- Telegram: biroz batafsilroq, tartibli (bullet/emoji bilan), aniq va tushunarli, oxirida qo'ng'iroq/murojaat uchun chaqiriq
- Facebook: o'rtacha uzunlik, do'stona va ishonchli ohang, oilaviy auditoriyaga mos

Javobni FAQAT quyidagi JSON formatida qaytar, boshqa hech qanday matn (izoh, sarlavha va h.k.) qo'shma:
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
          max_tokens: 1500,
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
      const parsed = JSON.parse(match[0]);

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
    const { input } = await this.mergeWithTemplate(tenantId, rawInput);

    const [images, posts] = await Promise.all([
      input.imageUrl
        ? Promise.resolve([input.imageUrl])
        : this.findImages(`${input.destination} hotel resort travel`, 4),
      this.generatePosts(input),
    ]);

    return { images, posts };
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
  private buildBannerSvg(input: TourAdInput, accentColor = '#FF6A2B', size = 1080): string {
    const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(accentColor) ? accentColor : '#FF6A2B';
    const destination = this.escapeSvg(this.truncate(input.destination, 34));
    const hotel = input.hotelName ? this.escapeSvg(this.truncate(input.hotelName, 30)) : '';
    const stars = input.hotelStars
      ? '★'.repeat(Math.max(0, Math.min(5, Math.round(input.hotelStars))))
      : '';

    const infoParts: string[] = [];
    if (input.nights) infoParts.push(`${input.nights} kecha`);
    if (input.mealPlan) infoParts.push(this.escapeSvg(this.truncate(input.mealPlan, 20)));
    if (input.adults || input.children) {
      infoParts.push(
        `${input.adults || 1} kattalar${input.children ? ` + ${input.children} bola` : ''}`,
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

    // Narx "chip"ining kengligini matn uzunligiga qarab taxminiy hisoblaymiz
    const priceChipWidth = Math.min(size - 80, 140 + priceText.length * 26);

    return `
<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="55%" stop-color="#000000" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.82"/>
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="${size}" height="${size}" fill="url(#fade)"/>

  ${
    stars
      ? `<text x="60" y="${size - 330}" font-family="sans-serif" font-size="34" fill="#FFD54A" font-weight="700">${stars}</text>`
      : ''
  }

  <text x="60" y="${size - 280}" font-family="sans-serif" font-size="52" font-weight="800" fill="#FFFFFF">${destination}</text>

  ${
    hotel
      ? `<text x="60" y="${size - 220}" font-family="sans-serif" font-size="32" font-weight="600" fill="#F1F1F1">${hotel}</text>`
      : ''
  }

  ${
    infoLine
      ? `<text x="60" y="${size - 170}" font-family="sans-serif" font-size="26" fill="#E0E0E0">${infoLine}</text>`
      : ''
  }

  <rect x="60" y="${size - 130}" width="${priceChipWidth}" height="76" rx="16" fill="${safeColor}"/>
  <text x="${60 + priceChipWidth / 2}" y="${size - 80}" font-family="sans-serif" font-size="40" font-weight="800" fill="#FFFFFF" text-anchor="middle">${priceText}</text>

  ${
    dateLine
      ? `<text x="${80 + priceChipWidth}" y="${size - 80}" font-family="sans-serif" font-size="24" fill="#FFFFFF">${dateLine}</text>`
      : ''
  }

  ${
    footer
      ? `<text x="60" y="${size - 30}" font-family="sans-serif" font-size="22" fill="#CFCFCF">${footer}</text>`
      : ''
  }
</svg>`.trim();
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

    // 1) Fon surati — foydalanuvchi bergan bo'lsa o'shani, aks holda
    // avtomatik qidiramiz (1-bosqichdagi findImages() bilan bir xil)
    let sourceImage = input.imageUrl;
    if (!sourceImage) {
      const found = await this.findImages(`${input.destination} hotel resort travel`, 1);
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

    // 3) 1080×1080'ga moslab kesib olamiz, ustiga (shablondagi brend
    // rangi bilan) matn qatlamini qo'shamiz
    const size = 1080;
    let pngBuffer: Buffer;
    try {
      const svg = this.buildBannerSvg(input, template.primaryColor, size);
      pngBuffer = await sharp(bgBuffer)
        .resize(size, size, { fit: 'cover', position: 'attention' })
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
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
  images(@CurrentUser() _u: any, @Body() body: { query: string; count?: number }) {
    if (!body?.query) throw new BadRequestException("Qidiruv so'zi (query) kerak");
    return this.svc.findImages(body.query, body.count || 4);
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

  // ── YUBORISH ──

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
}

@Module({
  imports: [TelegramModule],
  controllers: [AiMarketingController],
  providers: [AiMarketingService],
  exports: [AiMarketingService],
})
export class AiMarketingModule {}