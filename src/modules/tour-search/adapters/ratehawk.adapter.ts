import { Injectable, Logger } from '@nestjs/common';
import type {
  ITourAdapter,
  TourAdapterCredentials,
  LiveSearchParams,
  NormalizedSearchResult,
  CredentialCheckResult,
  RegionSuggestion,
} from './tour-adapter.types';

/**
 * ═══════════════════════════════════════════════════════════════
 * RATEHAWK (Emerging Travel Group / Worldota) — B2B API v3 ADAPTER
 * ═══════════════════════════════════════════════════════════════
 *
 * Manba: https://docs.emergingtravel.com/
 *
 * AUTENTIFIKATSIYA:
 *   HTTP Basic Auth: username = KEY_ID, password = API_KEY.
 *   Bu qiymatlar Ratehawk shartnoma kabinetida ("API" bo'limi, faqat
 *   Master account) generatsiya qilinadi.
 *
 * v14 DA NIMA TUZATILDI:
 *
 *   1. MEHMONXONA NOMLARI KESHLANADI.
 *      Ilgari har bir qidiruvda TOP-15 natija uchun 15 ta alohida
 *      `/hotel/info/` chaqiruvi ketardi. Ratehawk limiti ~30 so'rov/60s,
 *      ya'ni ikki agent bir vaqtda qidirsa limitga urilib, natijalar
 *      nomsiz ("Mehmonxona #12345") chiqardi yoki umuman kelmasdi.
 *      Endi nomlar xotirada 24 soat saqlanadi va takroriy qidiruvda
 *      API'ga umuman murojaat qilinmaydi.
 *
 *   2. LIMITGA URILMASLIK.
 *      Chaqiruvlar 5 talik guruhlarga bo'linadi va oralarida pauza
 *      bor. 429 kelsa — kutib qayta uriniladi (backoff).
 *
 *   3. YO'NALISH ANIQ TANLANADI.
 *      Ilgari `regions[0]` ko'r-ko'rona olinardi. Endi `suggestRegions`
 *      bor — foydalanuvchi ro'yxatdan tanlaydi. Tanlanmagan bo'lsa
 *      eski xatti-harakat saqlanadi (orqaga moslik).
 *
 *   4. NETTO NARX.
 *      Ratehawk `show_amount` (mijoz ko'radigan) va `amount` (agentlik
 *      to'laydigan) beradi. Ilgari faqat birinchisi olinardi va CRM'da
 *      foyda 100% ko'rinardi. Endi ikkalasi ham qaytariladi.
 *
 * MUHIM CHEKLOV:
 *   `rates[].book_hash` atigi ~38 daqiqa amal qiladi. Natijalarni
 *   "doimiy tur" sifatida saqlamang.
 * ═══════════════════════════════════════════════════════════════
 */

const HOSTS = {
  sandbox: 'https://api-sandbox.worldota.net/api/b2b/v3',
  production: 'https://api.worldota.net/api/b2b/v3',
};

function getHost(): string {
  const env = (process.env.RATEHAWK_ENV || 'production').toLowerCase();
  return env === 'sandbox' ? HOSTS.sandbox : HOSTS.production;
}

/** Har bir so'rov uchun eng ko'p necha ta natijaga mehmonxona nomi so'raladi */
const INFO_LIMIT = Number(process.env.RATEHAWK_INFO_LIMIT || 20);
/** Bir vaqtda nechta `/hotel/info/` chaqiruvi ketadi */
const INFO_CONCURRENCY = 5;
/** Nom keshi qancha yashaydi (soat) */
const NAME_CACHE_TTL_MS = Number(process.env.RATEHAWK_NAME_CACHE_HOURS || 24) * 3600 * 1000;

type HotelInfo = { name: string; stars: number | null; at: number };

@Injectable()
export class RatehawkAdapter implements ITourAdapter {
  readonly slug = 'ratehawk';
  private readonly logger = new Logger('RatehawkAdapter');

  /**
   * Mehmonxona nomlari keshi — butun jarayon uchun umumiy.
   * Ratehawk'da mehmonxona nomi deyarli o'zgarmaydi, shuning uchun
   * uzoq muddatli kesh xavfsiz va API chaqiruvlarini keskin kamaytiradi.
   */
  private readonly nameCache = new Map<number, HotelInfo>();

  private authHeader(creds: TourAdapterCredentials): string {
    return 'Basic ' + Buffer.from(`${creds.login}:${creds.password}`).toString('base64');
  }

  /**
   * Ratehawk'ga so'rov. 429 (limit) kelganda kutib qayta uriniladi.
   */
  private async call<T = any>(
    creds: TourAdapterCredentials,
    path: string,
    body: Record<string, unknown>,
    timeoutMs = 20000,
    retries = 2,
  ): Promise<{ ok: boolean; status: number; json: T | null; text?: string }> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${getHost()}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: this.authHeader(creds),
          },
          body: JSON.stringify(body),
          signal: controller.signal as any,
        });

        // Limitga urildik — kutamiz va qayta urinamiz
        if (res.status === 429 && attempt < retries) {
          const wait = 1200 * (attempt + 1);
          this.logger.warn(`Ratehawk limiti (429) — ${wait}ms kutib qayta urinamiz`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { ok: false, status: res.status, json: null, text };
        }
        const json = (await res.json().catch(() => null)) as T | null;
        return { ok: true, status: res.status, json };
      } catch (e: any) {
        const isTimeout = e?.name === 'AbortError';
        if (attempt < retries && !isTimeout) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        const text = isTimeout ? "So'rov vaqti tugadi" : String(e?.message || e);
        return { ok: false, status: 0, json: null, text };
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, status: 0, json: null, text: 'Qayta urinishlar tugadi' };
  }

  // ── 1. AUTENTIFIKATSIYANI TEKSHIRISH ──────────────────────────

  async verifyCredentials(creds: TourAdapterCredentials): Promise<CredentialCheckResult> {
    if (!creds.login || !creds.password) {
      return { ok: false, error: 'KEY_ID va API_KEY kiritilishi shart' };
    }

    const r = await this.call(creds, '/search/multicomplete/', {
      query: 'Dubai',
      language: 'en',
    });

    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: "KEY_ID yoki API_KEY noto'g'ri" };
    }
    if (!r.ok) {
      return {
        ok: false,
        error: `Ratehawk serveri javob bermadi (HTTP ${r.status}): ${(r.text || '').slice(0, 150)}`,
      };
    }
    return { ok: true };
  }

  // ── 2. YO'NALISH AUTOCOMPLETE ─────────────────────────────────

  async suggestRegions(
    creds: TourAdapterCredentials,
    query: string,
  ): Promise<RegionSuggestion[]> {
    const q = String(query || '').trim();
    if (q.length < 2) return [];

    const r = await this.call<any>(creds, '/search/multicomplete/', {
      query: q,
      language: 'ru', // MDH agentliklari uchun ru natijalari aniqroq
    });
    if (!r.ok) return [];

    const regions = r.json?.data?.regions || r.json?.regions || [];
    if (!Array.isArray(regions)) return [];

    return regions.slice(0, 12).map((x: any) => ({
      id: String(x?.id ?? x?.region_id ?? ''),
      name: String(x?.name || ''),
      fullName: x?.country_name ? `${x.name}, ${x.country_name}` : x?.name || null,
      countryCode: x?.country_code || null,
      type: x?.type || null,
    })).filter((x: RegionSuggestion) => x.id && x.name);
  }

  private async resolveRegionId(
    creds: TourAdapterCredentials,
    destination: string,
  ): Promise<{ regionId: number | null; error?: string }> {
    const list = await this.suggestRegions(creds, destination);
    if (list.length === 0) {
      return { regionId: null, error: `"${destination}" bo'yicha yo'nalish topilmadi` };
    }
    const regionId = Number(list[0].id);
    if (!Number.isFinite(regionId)) {
      return { regionId: null, error: "Yo'nalish ID formatini tanib bo'lmadi" };
    }
    return { regionId };
  }

  // ── 3. MEHMONXONA NOMLARI (KESHLI, GURUHLI) ───────────────────

  private async enrichNames(
    creds: TourAdapterCredentials,
    hids: number[],
  ): Promise<Map<number, { name: string; stars: number | null }>> {
    const now = Date.now();
    const result = new Map<number, { name: string; stars: number | null }>();
    const missing: number[] = [];

    // Avval keshdan
    for (const hid of hids.slice(0, INFO_LIMIT)) {
      const cached = this.nameCache.get(hid);
      if (cached && now - cached.at < NAME_CACHE_TTL_MS) {
        result.set(hid, { name: cached.name, stars: cached.stars });
      } else {
        missing.push(hid);
      }
    }

    // Qolganini kichik guruhlarda so'raymiz — limitga urilmaslik uchun
    for (let i = 0; i < missing.length; i += INFO_CONCURRENCY) {
      const chunk = missing.slice(i, i + INFO_CONCURRENCY);
      await Promise.all(
        chunk.map(async (hid) => {
          const r = await this.call<any>(creds, '/hotel/info/', { hid, language: 'ru' }, 10000, 1);
          if (r.ok && r.json?.data) {
            const d = r.json.data;
            const info: HotelInfo = {
              name: d.name || `Mehmonxona #${hid}`,
              stars: Number.isFinite(Number(d.star_rating)) ? Number(d.star_rating) : null,
              at: Date.now(),
            };
            this.nameCache.set(hid, info);
            result.set(hid, { name: info.name, stars: info.stars });
          }
        }),
      );
      if (i + INFO_CONCURRENCY < missing.length) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    // Kesh cheksiz o'smasin
    if (this.nameCache.size > 20000) {
      const keys = Array.from(this.nameCache.keys()).slice(0, 5000);
      for (const k of keys) this.nameCache.delete(k);
    }

    return result;
  }

  // ── 4. JONLI QIDIRUV ──────────────────────────────────────────

  async searchLive(
    creds: TourAdapterCredentials,
    params: LiveSearchParams,
  ): Promise<NormalizedSearchResult[]> {
    let regionId = params.regionId ? Number(params.regionId) : null;

    if (!regionId || !Number.isFinite(regionId)) {
      const resolved = await this.resolveRegionId(creds, params.destination);
      if (!resolved.regionId) throw new Error(resolved.error || "Yo'nalish topilmadi");
      regionId = resolved.regionId;
    }

    const guests = [
      {
        adults: Math.max(1, Math.min(6, Number(params.adults) || 1)),
        children: (params.childrenAges || []).slice(0, 4),
      },
    ];

    const r = await this.call<any>(
      creds,
      '/search/serp/region/',
      {
        checkin: params.checkin,
        checkout: params.checkout,
        residency: (params.residency || 'uz').toLowerCase(),
        language: 'ru',
        guests,
        region_id: regionId,
        currency: (params.currency || 'USD').toUpperCase(),
      },
      30000,
      1,
    );

    if (!r.ok) {
      throw new Error(r.json?.error || r.text || `Ratehawk qidiruv xatosi (HTTP ${r.status})`);
    }

    const hotels: any[] = r.json?.data?.hotels || r.json?.hotels || [];
    if (!Array.isArray(hotels) || hotels.length === 0) return [];

    type Cheapest = { hid: number; rate: any };
    const cheapest: Cheapest[] = [];

    const showAmount = (rate: any): number =>
      Number(rate?.payment_options?.payment_types?.[0]?.show_amount ?? Infinity);

    for (const h of hotels) {
      const hid = Number(h.hid ?? h.id);
      const rates: any[] = h.rates || [];
      if (!Number.isFinite(hid) || rates.length === 0) continue;

      let best = rates[0];
      let bestAmount = showAmount(best);
      for (const rate of rates) {
        const amount = showAmount(rate);
        if (amount < bestAmount) {
          best = rate;
          bestAmount = amount;
        }
      }
      cheapest.push({ hid, rate: best });
    }

    cheapest.sort((a, b) => {
      const pa = showAmount(a.rate);
      const pb = showAmount(b.rate);
      return (Number.isFinite(pa) ? pa : 0) - (Number.isFinite(pb) ? pb : 0);
    });

    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const top = cheapest.slice(0, limit);

    const nameMap = await this.enrichNames(creds, top.map((t) => t.hid));

    return top.map(({ hid, rate }) => {
      const payType = rate?.payment_options?.payment_types?.[0];
      const info = nameMap.get(hid);

      // BRUTTO — mijoz ko'radigan summa
      const gross = Number(payType?.show_amount ?? 0);
      // NETTO — agentlik operatorga to'laydigan summa.
      // Ratehawk `amount` maydonida beradi; valyutasi boshqacha bo'lsa
      // (commission_info.charge) ishonchsiz — shunday holda null qoldiramiz
      // va CRM tenant ustamasi bo'yicha hisoblaydi.
      const netRaw = Number(payType?.amount ?? NaN);
      const sameCurrency =
        String(payType?.currency_code || '').toUpperCase() ===
        String(payType?.show_currency_code || '').toUpperCase();
      const net = Number.isFinite(netRaw) && netRaw > 0 && sameCurrency ? netRaw : null;

      const hasPenalty =
        !!payType?.cancellation_penalties?.policies?.length ||
        !!rate?.payment_options?.payment_types?.[0]?.cancellation_penalties;

      return {
        operatorSlug: this.slug,
        operatorName: 'Ratehawk',
        externalId: String(rate?.book_hash || rate?.match_hash || hid),
        title: info?.name || `Mehmonxona #${hid}`,
        destination: params.destination,
        country: null,
        hotelStars: info?.stars ?? null,
        mealPlan: rate?.meal_data?.value || rate?.room_data_trans?.meal || null,
        roomName: rate?.room_name || rate?.room_data_trans?.main_room_type || null,
        price: gross,
        netPrice: net,
        currency: String(payType?.show_currency_code || params.currency || 'USD'),
        cancellationPolicy: hasPenalty
          ? "Bekor qilish shartlari bor — bron qilishdan oldin tekshiring"
          : 'Bepul bekor qilish (aniqlashtirish uchun rate detallariga qarang)',
        raw: undefined,
      } satisfies NormalizedSearchResult;
    });
  }
}