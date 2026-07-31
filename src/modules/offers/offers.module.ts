import {
  Module, Injectable, Controller,
  Get, Post, Put, Delete, Param, Body, UseGuards, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';
import { convertToUSD } from '../../common/utils/helpers';
import { BookingsModule, BookingsService } from '../bookings/bookings.module';
import { PaymentsModule, PaymentsService } from '../payments/payments.module';
import { TelegramModule, TelegramService } from '../telegram/telegram.module';
import { UserTelegramModule, UserTelegramService } from '../telegram/user-telegram.module';

// Offers stored in Client.preferences.offers JSON array
// No schema migration needed!

const OFFER_CURRENCIES = ['USD', 'EUR', 'UZS', 'RUB'];

@Injectable()
export class OffersService {
  private readonly logger = new Logger('Offers');

  constructor(
    private prisma: PrismaService,
    private bookings: BookingsService,
    private payments: PaymentsService,
    private telegram: TelegramService,
    private userTelegram: UserTelegramService,
  ) {}

  async list(tenantId: string, clientId: string) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    return (prefs.offers || []).reverse();
  }

  /**
   * Taklif narx maydonlarini (actualPrice/markup/clientPrice/pricePerPerson)
   * va mehmonxonalar/ovqatlanish ma'lumotlarini tayyorlaydi. create() va
   * update() ikkalasida ham bir xil mantiq ishlatiladi.
   */
  private async buildOfferFields(data: any) {
    // ── v10: Valyuta konvertatsiyasi ──
    // Agent EUR yoki UZS kiritsa, CBU.uz rasmiy kursi bo'yicha USD ga
    // o'giramiz. actualPrice/markup/clientPrice HAR DOIM USD da
    // saqlanadi — shu tufayli agent komissiyasi, hisobotlar va KPI
    // hammasi bitta valyutada (USD) to'g'ri hisoblanadi.
    const enteredCurrency = OFFER_CURRENCIES.includes(data.currency) ? data.currency : 'USD';
    const rawActualPrice = Number(data.actualPrice) || 0;
    const rawMarkup = Number(data.markup) || 0;

    let actualPrice = rawActualPrice;
    let markup = rawMarkup;
    let fx: { rate: number; source: string } | null = null;

    if (enteredCurrency !== 'USD') {
      const rate = (await convertToUSD(1, enteredCurrency)).rate; // kursni 1 marta olamiz
      actualPrice = Math.round((rawActualPrice / rate) * 100) / 100;
      markup = Math.round((rawMarkup / rate) * 100) / 100;
      fx = { rate, source: 'cbu.uz' };
    }

    const pax = Math.max(1, parseInt(String(data.pax)) || 1);
    const clientPriceTotal = actualPrice + markup;
    const pricePerPerson = Math.round((clientPriceTotal / pax) * 100) / 100;

    // v14: kattalar/bolalar breakdown (1 kishilik narxlar, USD ga o'girilgan).
    // Bolalar arzon narxda — jami = kattalar×(op+mk) + bolalar×(bola_op+bola_mk).
    const conv = (n: number) => (enteredCurrency !== 'USD' && fx) ? Math.round((n / fx.rate) * 100) / 100 : n;
    const adults = Math.max(1, parseInt(String(data.adults ?? data.pax)) || 1);
    const children = Math.max(0, parseInt(String(data.children)) || 0);
    const adultActualPrice = conv(Number(data.adultActualPrice) || 0);
    const adultMarkup = conv(Number(data.adultMarkup) || 0);
    const childActualPrice = (data.childActualPrice != null && children > 0) ? conv(Number(data.childActualPrice) || 0) : null;
    const childMarkup = (data.childMarkup != null && children > 0) ? conv(Number(data.childMarkup) || 0) : null;

    // ── Mehmonxonalar (2-5 ta variant, har biriga rasmlar) ──
    let hotels: any[] = Array.isArray(data.hotels)
      ? data.hotels
          .slice(0, 5)
          .map((h: any) => ({
            name: (h?.name || '').toString().trim(),
            stars: h?.stars ? Number(h.stars) : null,
            photos: Array.isArray(h?.photos) ? h.photos.filter((p: any) => typeof p === 'string').slice(0, 6) : [],
          }))
          .filter((h: any) => h.name)
      : [];
    // Eski (bitta mehmonxona) formatidan kelgan so'rovlar bilan moslik
    if (!hotels.length && data.hotelName) {
      hotels = [{ name: data.hotelName, stars: data.hotelStars ? Number(data.hotelStars) : null, photos: [] }];
    }
    const mealPlan = ['NONE', 'BREAKFAST', 'FULL_BOARD'].includes(data.mealPlan) ? data.mealPlan : 'NONE';

    return {
      tourName: data.tourName,
      destination: data.destination || null,
      departDate: data.departDate || null,
      returnDate: data.returnDate || null,
      departFlightTime: data.departFlightTime || null,
      returnFlightTime: data.returnFlightTime || null,
      pax,
      adults,
      children,
      adultActualPrice,
      adultMarkup,
      childActualPrice,
      childMarkup,
      actualPrice,
      markup,
      clientPrice: clientPriceTotal,
      pricePerPerson,
      currency: 'USD',
      originalCurrency: enteredCurrency !== 'USD' ? enteredCurrency : undefined,
      originalActualPrice: enteredCurrency !== 'USD' ? rawActualPrice : undefined,
      originalMarkup: enteredCurrency !== 'USD' ? rawMarkup : undefined,
      exchangeRate: fx ? fx.rate : undefined,
      exchangeRateSource: fx ? fx.source : undefined,
      exchangeRateAt: fx ? new Date().toISOString() : undefined,
      hotels,
      hotelName: hotels[0]?.name || null,
      hotelStars: hotels[0]?.stars || null,
      mealPlan,
      includesVisa: data.includesVisa || false,
      includesFlight: data.includesFlight !== false,
      includesHotel: data.includesHotel !== false,
      includesTransfer: data.includesTransfer || false,
      includesInsurance: data.includesInsurance || false,
      notes: data.notes || null,
      // v14: taklifga havola (Booking.com va h.k.) — mijozga yuborilganda Telegram
      // avtomatik preview qiladi. URL to'g'ri formatda bo'lsagina saqlaymiz.
      bookingLink: (() => {
        const l = (data.bookingLink || '').toString().trim();
        return /^https?:\/\//i.test(l) ? l : null;
      })(),
    };
  }

  /**
   * v11: Taklifni Telegram uchun chiroyli, tushunarli formatda matnga aylantiradi.
   * Bitta joyda — shablon o'zgarsa, faqat shu yerni tahrirlash kifoya.
   */
  private buildOfferMessage(offer: any): string {
    const MEAL_LABELS: Record<string, string> = {
      NONE: "Ovqatlanishsiz",
      BREAKFAST: "Nonushta bilan",
      FULL_BOARD: "To'liq ovqatlanish (3 mahal)",
    };
    const fmtDate = (d: any) => {
      if (!d) return null;
      try {
        return new Date(d).toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric' });
      } catch { return null; }
    };
    const money = (n: any) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });

    const lines: string[] = [];
    lines.push(`🌍 ${offer.tourName || 'Tur taklifi'}`);
    if (offer.destination) lines.push(`📍 Yo'nalish: ${offer.destination}`);

    const dep = fmtDate(offer.departDate);
    const ret = fmtDate(offer.returnDate);
    if (dep || ret) lines.push(`📅 Sana: ${dep || '—'}${ret ? ` — ${ret}` : ''}`);
    if (offer.departFlightTime) lines.push(`✈️ Uchish: ${offer.departFlightTime}`);

    const _adults = offer.adults ?? offer.pax ?? 1;
    const _children = offer.children ?? 0;
    if (_children > 0) {
      lines.push(`👥 Kishilar: ${_adults} katta${_children ? ` + ${_children} bola` : ''}`);
    } else {
      lines.push(`👥 Kishilar soni: ${_adults} kishi`);
    }
    lines.push('');

    const hotels = Array.isArray(offer.hotels) ? offer.hotels : [];
    if (hotels.length) {
      lines.push('🏨 Mehmonxona variantlari:');
      for (const h of hotels) {
        const stars = h.stars ? '⭐'.repeat(Math.min(7, Number(h.stars))) : '';
        lines.push(`   • ${h.name}${stars ? ` ${stars}` : ''}`);
      }
    } else if (offer.hotelName) {
      const stars = offer.hotelStars ? '⭐'.repeat(Math.min(7, Number(offer.hotelStars))) : '';
      lines.push(`🏨 Mehmonxona: ${offer.hotelName}${stars ? ` ${stars}` : ''}`);
    }
    // v14: Ovqatlanish TANLANMAGAN (NONE) bo'lsa — hech narsa yozilmaydi
    // (avval "Ovqatlanishsiz" deb chiqardi, endi umuman ko'rsatilmaydi).
    if (offer.mealPlan && offer.mealPlan !== 'NONE' && MEAL_LABELS[offer.mealPlan]) {
      lines.push(`🍽 Ovqatlanish: ${MEAL_LABELS[offer.mealPlan]}`);
    }
    lines.push('');

    const includes: string[] = [];
    if (offer.includesFlight) includes.push('✈️ Aviachipta');
    if (offer.includesHotel) includes.push('🏨 Mehmonxona');
    if (offer.includesTransfer) includes.push('🚐 Transfer');
    if (offer.includesVisa) includes.push('🛂 Viza yordami');
    if (offer.includesInsurance) includes.push('🛡 Sug\'urta');
    if (includes.length) {
      lines.push('✅ Narxga kiradi:');
      for (const i of includes) lines.push(`   • ${i}`);
      lines.push('');
    }

    // v14: narx — bolalar bo'lsa kattalar/bolalar alohida ko'rsatiladi
    const adultClientPer = (offer.adultActualPrice ?? 0) + (offer.adultMarkup ?? 0);
    const childClientPer = (offer.childActualPrice ?? 0) + (offer.childMarkup ?? 0);
    if (_children > 0 && offer.adultActualPrice != null) {
      lines.push(`💰 Kattalar: ${_adults} × ${money(adultClientPer)} = ${money(_adults * adultClientPer)}`);
      lines.push(`🧒 Bolalar: ${_children} × ${money(childClientPer)} = ${money(_children * childClientPer)}`);
      lines.push(`💵 Jami narx: ${money(offer.clientPrice)}`);
    } else {
      lines.push(`💰 1 kishi uchun: ${money(offer.pricePerPerson)}`);
      lines.push(`💵 Jami narx (${_adults} kishi): ${money(offer.clientPrice)}`);
    }

    if (offer.notes) {
      lines.push('');
      lines.push(`📝 ${offer.notes}`);
    }

    // v14: havola — Telegram uni avtomatik preview (rasm+sarlavha) qilib ko'rsatadi
    if (offer.bookingLink) {
      lines.push('');
      lines.push(`🔗 Batafsil: ${offer.bookingLink}`);
    }

    lines.push('');
    lines.push("Savolingiz bo'lsa, bemalol yozing! 😊");

    return lines.join('\n');
  }

  async create(tenantId: string, agentId: string, data: any) {
    const client = await this.prisma.client.findFirst({ where: { id: data.clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    if (!prefs.offers) prefs.offers = [];

    const fields = await this.buildOfferFields(data);
    const offer = {
      id: Date.now().toString(),
      agentId,
      ...fields,
      status: 'DRAFT',
      createdAt: new Date().toISOString(),
    };
    prefs.offers.push(offer);

    // Update client: pipeline stage → OFFER_SENT (if not already past that)
    const advanceStages = ['NEW_LEAD', 'CONTACTED', 'INTERESTED'];
    const updateData: any = { preferences: prefs };
    if (advanceStages.includes((client as any).pipelineStage)) {
      updateData.pipelineStage = 'OFFER_SENT';
      updateData.pipelineStageAt = new Date();
    }

    await this.prisma.client.update({ where: { id: data.clientId }, data: updateData });

    // Timeline
    await this.prisma.clientTimeline.create({
      data: {
        clientId: data.clientId,
        userId: agentId,
        type: 'offer_created',
        title: 'Taklif yaratildi: ' + data.tourName,
        description: '$' + offer.clientPrice.toLocaleString(),
        metadata: { offerId: offer.id, tourName: data.tourName },
      } as any,
    }).catch(() => {});

    return offer;
  }

  /**
   * Mavjud (hali sotilmagan) taklifni tahrirlaydi. Narx/valyuta konvertatsiyasi
   * create() bilan bir xil mantiqda qayta hisoblanadi.
   */
  async update(tenantId: string, clientId: string, offerId: string, data: any) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    const list = prefs.offers || [];
    const idx = list.findIndex((o: any) => o.id === offerId);
    if (idx === -1) throw new NotFoundException('Taklif topilmadi');
    const existing = list[idx];
    if (existing.status === 'SOLD') {
      throw new BadRequestException("Sotilgan taklifni tahrirlab bo'lmaydi — buning o'rniga bog'langan bookingni tahrirlang");
    }

    const fields = await this.buildOfferFields({
      tourName: data.tourName ?? existing.tourName,
      destination: data.destination ?? existing.destination,
      departDate: data.departDate ?? existing.departDate,
      returnDate: data.returnDate ?? existing.returnDate,
      departFlightTime: data.departFlightTime ?? existing.departFlightTime,
      returnFlightTime: data.returnFlightTime ?? existing.returnFlightTime,
      pax: data.pax ?? existing.pax,
      actualPrice: data.actualPrice ?? existing.actualPrice,
      markup: data.markup ?? existing.markup,
      currency: data.currency ?? existing.currency,
      hotels: data.hotels ?? existing.hotels,
      hotelName: data.hotelName ?? existing.hotelName,
      hotelStars: data.hotelStars ?? existing.hotelStars,
      mealPlan: data.mealPlan ?? existing.mealPlan,
      includesVisa: data.includesVisa ?? existing.includesVisa,
      includesFlight: data.includesFlight ?? existing.includesFlight,
      includesHotel: data.includesHotel ?? existing.includesHotel,
      includesTransfer: data.includesTransfer ?? existing.includesTransfer,
      includesInsurance: data.includesInsurance ?? existing.includesInsurance,
      notes: data.notes ?? existing.notes,
    });

    const updated = {
      ...existing,
      ...fields,
      updatedAt: new Date().toISOString(),
    };
    list[idx] = updated;
    prefs.offers = list;
    await this.prisma.client.update({ where: { id: clientId }, data: { preferences: prefs } });

    // Timeline
    await this.prisma.clientTimeline.create({
      data: {
        clientId,
        type: 'offer_updated',
        title: 'Taklif tahrirlandi: ' + updated.tourName,
        description: '$' + updated.clientPrice.toLocaleString(),
        metadata: { offerId },
      } as any,
    }).catch(() => {});

    return updated;
  }

  // ─── v29: Taklif shablonlari ────────────────────────────────────────────
  // Agent bir xil turlarni (masalan "Antalya, Rixos 5*") kuniga o'nlab
  // marta qo'lda qayta terib chiqmasin deb, tayyor taklifni "shablon"
  // sifatida saqlab qo'yadi va keyingi mijozlarga bor-yo'g'i 2 marta
  // bosib (shablon tanlash + narx/sana tekshirish) taklif yuboradi.
  // Prisma migratsiya kerak emas — Tenant.settings JSON ichida saqlanadi
  // (xuddi AI Marketing shablon tizimi kabi bir xil andoza bo'yicha).
  private static readonly MAX_OFFER_TEMPLATES = 60;

  async listTemplates(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
    const settings: any = tenant?.settings || {};
    const list = Array.isArray(settings.offerTemplates) ? settings.offerTemplates : [];
    return [...list].reverse();
  }

  async saveTemplate(tenantId: string, agentId: string, data: any) {
    const name = (data.name || data.tourName || '').toString().trim();
    if (!name) throw new BadRequestException("Shablon nomi kerak");

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
    const settings: any = tenant?.settings || {};
    const list = Array.isArray(settings.offerTemplates) ? settings.offerTemplates : [];

    // v29: shablonda FORM qiymatlari (frontend `f` state bilan bir xil shakl)
    // saqlanadi — shunda "shablonni qo'llash" bor-yo'g'i setF(template) bo'ladi,
    // qayta konvertatsiya/hisoblash shart emas.
    const template = {
      id: Date.now().toString(),
      name,
      agentId,
      createdAt: new Date().toISOString(),
      tourName: data.tourName || '',
      destination: data.destination || '',
      pax: data.pax ?? 1,
      children: data.children ?? 0,
      departFlightTime: data.departFlightTime || '',
      returnFlightTime: data.returnFlightTime || '',
      actualPrice: data.actualPrice ?? '',
      markup: data.markup ?? '',
      childActualPrice: data.childActualPrice ?? '',
      childMarkup: data.childMarkup ?? '',
      currency: data.currency || 'USD',
      bookingLink: data.bookingLink || '',
      hotels: Array.isArray(data.hotels) ? data.hotels.slice(0, 5) : [],
      mealPlan: data.mealPlan || 'NONE',
      includesVisa: !!data.includesVisa,
      includesFlight: data.includesFlight !== false,
      includesHotel: data.includesHotel !== false,
      includesTransfer: !!data.includesTransfer,
      includesInsurance: !!data.includesInsurance,
      notes: data.notes || '',
    };

    list.push(template);
    // Eskirgan shablonlarni tozalab boramiz — cheksiz o'sib ketmasin
    while (list.length > OffersService.MAX_OFFER_TEMPLATES) list.shift();

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: { ...settings, offerTemplates: list } },
    });

    return template;
  }

  async deleteTemplate(tenantId: string, templateId: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } });
    const settings: any = tenant?.settings || {};
    const list = Array.isArray(settings.offerTemplates) ? settings.offerTemplates : [];
    const next = list.filter((t: any) => t.id !== templateId);
    if (next.length === list.length) throw new NotFoundException('Shablon topilmadi');

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { settings: { ...settings, offerTemplates: next } },
    });

    return { success: true };
  }

  /**
   * v11: Taklifni endi shunchaki "SENT" deb belgilab qo'ymaymiz — chiroyli
   * shablon asosida HAQIQATDA Telegram orqali yuboramiz:
   *   • Klient bilan mavjud Telegram suhbat bo'lsa — o'sha suhbat qaysi
   *     kanaldan (bot yoki shaxsiy akkaunt) borayotgan bo'lsa, o'shandan davom etadi.
   *   • Klient bilan hali suhbat bo'lmasa (birinchi xabar) — albatta agentning
   *     SHAXSIY Telegram akkaunti orqali yuboriladi (sovuq xabar botdan emas,
   *     jonli odamdan kelgandek bo'lishi uchun).
   */
  async send(tenantId: string, clientId: string, offerId: string, agentId: string, role: string) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    const list = prefs.offers || [];
    const offer = list.find((o: any) => o.id === offerId);
    if (!offer) throw new NotFoundException('Taklif topilmadi');

    const text = this.buildOfferMessage(offer);

    // Klient bilan eng so'nggi Telegram suhbatini qidiramiz
    const existingConv = await this.prisma.conversation.findFirst({
      where: { tenantId, clientId, channel: 'TELEGRAM' },
      include: { account: true },
      orderBy: { lastMessageAt: 'desc' },
    });

    let deliveryInfo: { via: 'bot' | 'personal'; conversationId: string };

    // v14: taklif rasmlarini yig'amiz — endi bittalab EMAS, BITTA ALBOM bo'lib ketadi
    const hotelsForPhotos = Array.isArray(offer.hotels) ? offer.hotels : [];
    const allPhotos: string[] = [];
    for (const h of hotelsForPhotos) {
      if (Array.isArray(h?.photos)) for (const p of h.photos) if (p) allPhotos.push(p);
    }
    const photoList = allPhotos.slice(0, 10); // Telegram albom limiti 10

    const isBotConv = !!(existingConv && !(existingConv as any).account?.isPersonal && existingConv.accountId);
    // Bitta xabar: mavjud shaxsiy suhbat + rasm(lar) bor + matn caption'ga sig'adi
    const oneMessageAlbum = !!existingConv && !isBotConv && photoList.length > 0 && text.length <= 1024;

    if (oneMessageAlbum) {
      // v14: HAMMASI BITTA XABARDA — matn caption, rasmlar flexible albom
      await this.userTelegram.sendMediaGroup(tenantId, agentId, existingConv!.id, photoList, text);
      deliveryInfo = { via: 'personal', conversationId: existingConv!.id };
    } else {
      // 1) Avval matn (link preview shu yerda saqlanadi)
      if (isBotConv) {
        try {
          await this.telegram.sendMessage(tenantId, existingConv!.id, text, agentId, role, false);
          deliveryInfo = { via: 'bot', conversationId: existingConv!.id };
        } catch (e: any) {
          // 🩹 TUZATISH: bot orqali yuborish muvaffaqiyatsiz bo'lsa (masalan
          // bot vaqtincha aktiv emas), TAKLIF UMUMAN YUBORILMAY qolmasin —
          // shaxsiy Telegram orqali zaxira yo'l sifatida urinamiz.
          this.logger.warn(`Taklif bot orqali yuborilmadi, shaxsiyga o'tildi: ${e?.message || e}`);
          const result = await this.userTelegram.sendPersonalMessage(tenantId, agentId, {
            conversationId: existingConv?.id,
            text,
            clientId,
          });
          deliveryInfo = { via: 'personal', conversationId: result.conversationId };
        }
      } else {
        const result = await this.userTelegram.sendPersonalMessage(tenantId, agentId, {
          conversationId: existingConv?.id,
          username: !existingConv ? (client.telegramUsername || undefined) : undefined,
          phone: !existingConv ? (client.phone || undefined) : undefined,
          userId: !existingConv ? (client.telegramId || undefined) : undefined,
          text,
          clientId,
        });
        deliveryInfo = { via: 'personal', conversationId: result.conversationId };
      }

      // 2) Rasmlar — shaxsiy: BITTA ALBOM; bot: bittalab
      if (photoList.length) {
        try {
          if (deliveryInfo.via === 'personal') {
            await this.userTelegram.sendMediaGroup(tenantId, agentId, deliveryInfo.conversationId, photoList, '');
          } else {
            for (const photoUrl of photoList) {
              await this.telegram.sendMedia(tenantId, deliveryInfo.conversationId, agentId, role, {
                fileUrl: photoUrl, mediaType: 'photo', caption: '',
              }).catch((e: any) => this.logger.warn(`Taklif rasmi (bot) yuborilmadi: ${e?.message || e}`));
            }
          }
        } catch (e: any) {
          this.logger.warn(`Taklif albomi yuborilmadi (offerId=${offerId}): ${e?.message || e}`);
        }
      }
    }

    prefs.offers = list.map((o: any) =>
      o.id === offerId ? { ...o, status: 'SENT', sentAt: new Date().toISOString(), sentVia: deliveryInfo.via } : o
    );
    // Move pipeline stage to NEGOTIATION after offer sent
    const updateData: any = { preferences: prefs };
    const curStage = (client as any).pipelineStage;
    if (['OFFER_SENT', 'NEW_LEAD', 'CONTACTED', 'INTERESTED'].includes(curStage)) {
      updateData.pipelineStage = 'NEGOTIATION';
      updateData.pipelineStageAt = new Date();
    }

    await this.prisma.client.update({ where: { id: clientId }, data: updateData });

    // Timeline
    await this.prisma.clientTimeline.create({
      data: {
        clientId,
        userId: agentId,
        type: 'offer_sent',
        title: `Taklif yuborildi (${deliveryInfo.via === 'personal' ? 'shaxsiy Telegram' : 'Telegram bot'})`,
        metadata: { offerId, conversationId: deliveryInfo.conversationId },
      } as any,
    }).catch(() => {});

    return { success: true, ...deliveryInfo, photosSent: photoList.length };
  }

  /**
   * v10: Taklif SOTILDI deb belgilanadi va shu ma'lumotlar asosida
   * AVTOMATIK ravishda real Booking yaratiladi (Bookinglar sahifasida
   * ko'rinadi). Qo'lda "Yangi booking" to'ldirish shart emas — narxni
   * qayta kiritish kerak bo'lmaydi, xatoliklarning oldi olinadi.
   */
  async markSold(tenantId: string, userId: string, role: string, clientId: string, offerId: string, overrides: any = {}) {
    const client = await this.prisma.client.findFirst({ where: { id: clientId, tenantId } });
    if (!client) throw new NotFoundException();
    const prefs: any = (client as any).preferences || {};
    const list = prefs.offers || [];
    const idx = list.findIndex((o: any) => o.id === offerId);
    if (idx === -1) throw new NotFoundException('Taklif topilmadi');
    const offer = list[idx];
    if (offer.status === 'SOLD') {
      throw new BadRequestException('Bu taklif allaqachon sotilgan deb belgilangan');
    }

    const hotel = Array.isArray(offer.hotels) && offer.hotels.length ? offer.hotels[0] : null;

    // v10.3: Frontend "Booking yaratish" modalidan kelgan tahrirlangan
    // qiymatlar (overrides) offer qiymatlaridan ustun turadi — agent
    // yaratishdan oldin narx/sana/pax ni o'zgartira oladi.
    const ov = overrides || {};

    // 1) Booking DRAFT sifatida yaratiladi (offerdagi barcha ma'lumotlar bilan)
    const booking = await this.bookings.create(tenantId, userId, role, {
      clientId,
      tourName: ov.tourName || offer.tourName,
      destination: ov.destination || offer.destination || offer.tourName,
      departureDate: ov.departureDate || offer.departDate || undefined,
      returnDate: ov.returnDate || offer.returnDate || undefined,
      adults: Number(ov.adults ?? offer.pax ?? 1) || 1,
      children: Number(ov.children ?? 0) || 0,
      totalPrice: Number(ov.totalPrice ?? offer.clientPrice) || 0,
      supplierCost: Number(ov.supplierCost ?? offer.actualPrice) || 0,
      discount: Number(ov.discount ?? 0) || 0,
      currency: ov.currency || 'USD', // taklif allaqachon USD da saqlangan
      hotelName: hotel?.name || offer.hotelName || undefined,
      hotelStars: hotel?.stars || offer.hotelStars || undefined,
      mealPlan: offer.mealPlan || undefined,
      includesVisa: !!offer.includesVisa,
      includesFlights: !!offer.includesFlight,
      includesHotel: !!offer.includesHotel,
      includesTransfer: !!offer.includesTransfer,
      includesInsurance: !!offer.includesInsurance,
      notes: ov.notes || offer.notes || undefined,
      status: 'DRAFT',
    });

    // 2) DRAFT -> CONFIRMED — shu bosqichda BookingsService.update() ichidagi
    //    komissiya hisoblash logikasi ishga tushadi (xuddi xodim qo'lda
    //    tasdiqlagandagidek — Commission yozuvi avtomatik yaratiladi)
    const confirmed = await this.bookings.update(tenantId, booking.id, userId, role, { status: 'CONFIRMED' });

    // 2.5) Taklif "sotildi" deb belgilanganda — mijoz to'lovni allaqachon
    //      kelishib olgan deb hisoblanadi, shuning uchun booking to'liq
    //      TO'LANGAN deb avtomatik belgilanadi (to'liq summaga Payment
    //      yozuvi yaratiladi). Kerak bo'lsa, agent buni keyinchalik
    //      To'lovlar bo'limidan qo'lda tuzatishi mumkin.
    if (confirmed.totalPrice > 0) {
      await this.payments.addManual(tenantId, userId, role, {
        bookingId: confirmed.id,
        amount: confirmed.totalPrice,
        currency: 'USD',
        method: 'CASH',
        note: "Taklif 'Sotildi' deb belgilanganda avtomatik to'langan deb qayd etildi",
      }).catch((e: any) => {
        // v23 FIX: to'lov yozuvi yaratilmasa (masalan validatsiya xatosi),
        // ilgari bu HECH QAYERDA ko'rinmasdi — booking "CONFIRMED" bo'lib
        // qolardi, lekin moliyaviy hisobotda to'lov yo'q edi va buni
        // hech kim bilmasdi. Booking yaratilishi baribir buzilmasin
        // (shu sabab bloklamaymiz), lekin endi aniq loglanadi.
        this.logger.error(
          `[MOLIYA] Taklif SOTILDI deb belgilanganda avtomatik to'lov yozuvi ` +
          `yaratilmadi (booking ${confirmed.id}, summa ${confirmed.totalPrice}). ` +
          `To'lovni qo'lda kiriting! Xato: ${e?.message}`,
        );
      });

    }

    // 3) Taklifni SOTILDI deb belgilaymiz va yaratilgan bookingga bog'laymiz
    list[idx] = { ...offer, status: 'SOLD', soldAt: new Date().toISOString(), bookingId: confirmed.id };
    prefs.offers = list;
    await this.prisma.client.update({ where: { id: clientId }, data: { preferences: prefs } });

    // Timeline
    await this.prisma.clientTimeline.create({
      data: {
        clientId,
        userId,
        type: 'offer_sold',
        title: 'Taklif sotildi: ' + offer.tourName,
        description: '$' + (offer.clientPrice || 0).toLocaleString() + ' • ' + confirmed.bookingRef,
        metadata: { offerId, bookingId: confirmed.id },
      } as any,
    }).catch(() => {});

    return confirmed;
  }
}

@Controller('offers')
@UseGuards(JwtAuthGuard)
export class OffersController {
  constructor(private svc: OffersService) {}

  // v29: Taklif shablonlari — /offers/client/:clientId dan OLDIN turishi
  // shart, aks holda Nest 'templates' so'zini :clientId parametri deb
  // qabul qilib qo'yishi mumkin edi (aniq path avval tekshirilsin).
  @Get('templates')
  listTemplates(@CurrentUser() u: any) {
    return this.svc.listTemplates(u.tenantId);
  }

  @Post('templates')
  saveTemplate(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.saveTemplate(u.tenantId, u.id || u.sub, body);
  }

  @Delete('templates/:id')
  deleteTemplate(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.deleteTemplate(u.tenantId, id);
  }

  @Get('client/:clientId')
  list(@CurrentUser() u: any, @Param('clientId') id: string) {
    return this.svc.list(u.tenantId, id);
  }

  @Post()
  create(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.create(u.tenantId, u.id || u.sub, body);
  }

  @Put(':id')
  update(@CurrentUser() u: any, @Param('id') offerId: string, @Body() body: any) {
    return this.svc.update(u.tenantId, body.clientId, offerId, body);
  }

  @Post(':id/send')
  send(@CurrentUser() u: any, @Body() body: any, @Param('id') offerId: string) {
    return this.svc.send(u.tenantId, body.clientId, offerId, u.id || u.sub, u.role);
  }

  @Post(':id/mark-sold')
  markSold(@CurrentUser() u: any, @Body() body: any, @Param('id') offerId: string) {
    return this.svc.markSold(u.tenantId, u.id || u.sub, u.role, body.clientId, offerId, body.overrides);
  }
}

@Module({
  imports: [BookingsModule, PaymentsModule, TelegramModule, UserTelegramModule],
  controllers: [OffersController],
  providers: [OffersService],
  exports: [OffersService],
})
export class OffersModule {}