import { Injectable, Logger } from '@nestjs/common';
import type {
  ITourAdapter,
  TourAdapterCredentials,
  LiveSearchParams,
  NormalizedSearchResult,
  CredentialCheckResult,
} from './tour-adapter.types';

/**
 * ═══════════════════════════════════════════════════════════════
 * RATEHAWK (Emerging Travel Group / Worldota) — B2B API v3 ADAPTER
 * ═══════════════════════════════════════════════════════════════
 *
 * Manba: https://docs.emergingtravel.com/  (rasmiy, hujjatlashtirilgan)
 *
 * AUTENTIFIKATSIYA:
 *   HTTP Basic Auth: username = KEY_ID, password = API_KEY.
 *   Bu qiymatlar Ratehawk shartnoma kabinetida ("API" bo'limi,
 *   faqat Master account) generatsiya qilinadi. Bizning CRM modeliga
 *   solishtirsak: tenant "Ulanish" formasida
 *     Login    → KEY_ID
 *     Parol    → API_KEY
 *   deb kiritadi (operator-catalog.ts da shunday loginLabel/
 *   passwordLabel ko'rsatilgan).
 *
 * OQIM (bu adapterda ishlatiladigan 3 ta chaqiruv):
 *   1. POST /search/multicomplete/   — "Antalya" kabi matnni
 *      region_id'ga aylantiradi (avtomplit).
 *   2. POST /search/serp/region/     — shu region uchun mavjud
 *      mehmonxonalar + narxlarni (JONLI) qaytaradi. DIQQAT: bu
 *      chaqiruv mehmonxona NOMINI bermaydi — faqat hid/id + rates.
 *   3. POST /hotel/info/             — top-N natija uchun mehmonxona
 *      nomi/yulduzini olish (aks holda foydalanuvchiga faqat ID
 *      ko'rinadi). Xarajatni tejash uchun faqat eng arzon N ta
 *      natija uchun chaqiriladi (RATEHAWK_INFO_LIMIT).
 *
 * KEYINGI BOSQICH (bu adapterga hali kirmagan, alohida topshiriq):
 *   Rate tanlangach — "Prebook" (POST /hotel/prebook/) va keyin
 *   "Booking form/finish" chaqiriladi. Buni booking oqimi tayyor
 *   bo'lgach qo'shamiz — hozircha faqat QIDIRUV ishlaydi.
 *
 * MUHIM CHEKLOV:
 *   `search/serp/*` javobidagi `rates[].book_hash` qiymati atigi
 *   ~38 daqiqa amal qiladi (docs). Shuning uchun natijalarni DB'ga
 *   "doimiy tur" sifatida saqlamang — faqat shu so'rov davomida
 *   frontendga ko'rsating.
 * ═══════════════════════════════════════════════════════════════
 */

// Sandbox: test kalitlari bilan xavfsiz sinash uchun (haqiqiy pul yechilmaydi).
// Ishlab chiqarishga o'tishda RATEHAWK_ENV=production qiling.
const HOSTS = {
  sandbox: 'https://api-sandbox.worldota.net/api/b2b/v3',
  production: 'https://api.worldota.net/api/b2b/v3',
};

function getHost(): string {
  const env = (process.env.RATEHAWK_ENV || 'production').toLowerCase();
  return env === 'sandbox' ? HOSTS.sandbox : HOSTS.production;
}

/** Har bir so'rov uchun eng ko'p necha ta natijaga mehmonxona nomi so'raladi */
const INFO_LIMIT = Number(process.env.RATEHAWK_INFO_LIMIT || 15);

@Injectable()
export class RatehawkAdapter implements ITourAdapter {
  readonly slug = 'ratehawk';
  private readonly logger = new Logger('RatehawkAdapter');

  private authHeader(creds: TourAdapterCredentials): string {
    return 'Basic ' + Buffer.from(`${creds.login}:${creds.password}`).toString('base64');
  }

  private async call<T = any>(
    creds: TourAdapterCredentials,
    path: string,
    body: Record<string, unknown>,
    timeoutMs = 20000,
  ): Promise<{ ok: boolean; status: number; json: T | null; text?: string }> {
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

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, status: res.status, json: null, text };
      }
      const json = (await res.json().catch(() => null)) as T | null;
      return { ok: true, status: res.status, json };
    } catch (e: any) {
      const text = e?.name === 'AbortError' ? "So'rov vaqti tugadi" : String(e?.message || e);
      return { ok: false, status: 0, json: null, text };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 1. AUTENTIFIKATSIYANI TEKSHIRISH ──────────────────────────
  async verifyCredentials(creds: TourAdapterCredentials): Promise<CredentialCheckResult> {
    if (!creds.login || !creds.password) {
      return { ok: false, error: 'KEY_ID va API_KEY kiritilishi shart' };
    }

    // Eng arzon/tez chaqiruv — multicomplete. Faqat auth'ni tekshiramiz.
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

  // ── 2. SHAHAR/MAMLAKAT NOMINI region_id'ga AYLANTIRISH ────────
  private async resolveRegionId(
    creds: TourAdapterCredentials,
    destination: string,
  ): Promise<{ regionId: number | null; error?: string }> {
    const r = await this.call<any>(creds, '/search/multicomplete/', {
      query: destination,
      language: 'ru', // O'zbekiston/MDH agentliklari uchun ru ko'proq mos keladi
    });

    if (!r.ok) {
      return { regionId: null, error: `Yo'nalishni aniqlab bo'lmadi: HTTP ${r.status}` };
    }

    const regions = r.json?.data?.regions || r.json?.regions || [];
    if (!Array.isArray(regions) || regions.length === 0) {
      return { regionId: null, error: `"${destination}" bo'yicha yo'nalish topilmadi` };
    }

    // Birinchi (eng mos) natijani olamiz.
    const first = regions[0];
    const regionId = Number(first?.id ?? first?.region_id);
    if (!Number.isFinite(regionId)) {
      return { regionId: null, error: "Yo'nalish ID formatini tanib bo'lmadi" };
    }
    return { regionId };
  }

  // ── 3. TOP NATIJALAR UCHUN MEHMONXONA NOMINI OLISH ─────────────
  private async enrichNames(
    creds: TourAdapterCredentials,
    hids: number[],
  ): Promise<Map<number, { name: string; stars: number | null }>> {
    const map = new Map<number, { name: string; stars: number | null }>();
    const subset = hids.slice(0, INFO_LIMIT);

    // Ketma-ket emas, parallel — lekin son cheklangani uchun
    // Ratehawk rate-limit'iga (docs: ~30/60s) urilib qolmaymiz.
    await Promise.all(
      subset.map(async (hid) => {
        const r = await this.call<any>(creds, '/hotel/info/', { hid, language: 'ru' }, 10000);
        if (r.ok && r.json?.data) {
          const d = r.json.data;
          map.set(hid, {
            name: d.name || `Mehmonxona #${hid}`,
            stars: Number.isFinite(Number(d.star_rating)) ? Number(d.star_rating) : null,
          });
        }
      }),
    );
    return map;
  }

  // ── 4. JONLI QIDIRUV ────────────────────────────────────────────
  async searchLive(
    creds: TourAdapterCredentials,
    params: LiveSearchParams,
  ): Promise<NormalizedSearchResult[]> {
    let regionId = params.regionId ? Number(params.regionId) : null;

    if (!regionId) {
      const resolved = await this.resolveRegionId(creds, params.destination);
      if (!resolved.regionId) {
        throw new Error(resolved.error || "Yo'nalish topilmadi");
      }
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
    );

    if (!r.ok) {
      throw new Error(
        r.json?.error || r.text || `Ratehawk qidiruv xatosi (HTTP ${r.status})`,
      );
    }

    const hotels: any[] = r.json?.data?.hotels || r.json?.hotels || [];
    if (!Array.isArray(hotels) || hotels.length === 0) {
      return [];
    }

    // Har mehmonxonaning ENG ARZON stavkasini olamiz, keyin narx bo'yicha saralaymiz.
    type Cheapest = { hid: number; rate: any };
    const cheapest: Cheapest[] = [];

    for (const h of hotels) {
      const hid = Number(h.hid ?? h.id);
      const rates: any[] = h.rates || [];
      if (!Number.isFinite(hid) || rates.length === 0) continue;

      let best = rates[0];
      let bestAmount = Number(best?.payment_options?.payment_types?.[0]?.show_amount ?? Infinity);
      for (const rate of rates) {
        const amount = Number(rate?.payment_options?.payment_types?.[0]?.show_amount ?? Infinity);
        if (amount < bestAmount) {
          best = rate;
          bestAmount = amount;
        }
      }
      cheapest.push({ hid, rate: best });
    }

    cheapest.sort((a, b) => {
      const pa = Number(a.rate?.payment_options?.payment_types?.[0]?.show_amount ?? 0);
      const pb = Number(b.rate?.payment_options?.payment_types?.[0]?.show_amount ?? 0);
      return pa - pb;
    });

    const limit = Math.max(1, Math.min(50, params.limit || 30));
    const top = cheapest.slice(0, limit);

    const nameMap = await this.enrichNames(creds, top.map((t) => t.hid));

    return top.map(({ hid, rate }) => {
      const payType = rate?.payment_options?.payment_types?.[0];
      const info = nameMap.get(hid);

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
        price: Number(payType?.show_amount ?? 0),
        currency: String(payType?.show_currency_code || params.currency || 'USD'),
        cancellationPolicy: rate?.payment_options?.payment_types?.[0]?.cancellation_penalties
          ? "Bekor qilish shartlari mavjud — bron qilishdan oldin tekshiring"
          : "Bepul bekor qilish (aniqlashtirish uchun rate detallariga qarang)",
        raw: undefined, // productionda xom javobni saqlamaymiz (hajm/maxfiylik)
      } satisfies NormalizedSearchResult;
    });
  }
}