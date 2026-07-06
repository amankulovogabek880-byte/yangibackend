import type { Redis } from 'ioredis';
import type { Store } from 'cache-manager';

/**
 * Redis'dan pattern bo'yicha kalitlarni SCAN orqali (blokirovkasiz) yig'ib beradi.
 *
 * `KEYS` buyrug'i katta bazada Redis'ni bloklaydi — production'da xavfli.
 * Shuning uchun kursorli `SCAN` ishlatamiz (bir necha marta, kichik bo'laklarda).
 */
export async function scanKeys(client: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (batch.length) found.push(...batch);
  } while (cursor !== '0');
  return found;
}

/**
 * cache-manager v5 `Store` interfeysini ioredis ustida amalga oshiradi.
 * Bu `@nestjs/cache-manager` ga `store` sifatida uzatiladi — natijada
 * `CACHE_MANAGER` in-memory emas, Redis bilan ishlaydi.
 *
 * Qiymatlar JSON sifatida saqlanadi. TTL — millisekundda (cache-manager standarti),
 * Redis'ga `PX` (millisekund) bilan yoziladi.
 */
export function ioRedisStore(client: Redis, defaultTtlMs = 0): Store {
  const serialize = (v: unknown): string => JSON.stringify(v);
  const deserialize = <T>(raw: string | null): T | undefined =>
    raw === null || raw === undefined ? undefined : (JSON.parse(raw) as T);

  return {
    async get<T>(key: string): Promise<T | undefined> {
      return deserialize<T>(await client.get(key));
    },

    async set<T>(key: string, data: T, ttl?: number): Promise<void> {
      const ms = ttl ?? defaultTtlMs;
      const payload = serialize(data);
      if (ms && ms > 0) {
        await client.set(key, payload, 'PX', ms);
      } else {
        await client.set(key, payload);
      }
    },

    async del(key: string): Promise<void> {
      await client.del(key);
    },

    /**
     * Xavfsizlik: bu MULTI-TENANT umumiy Redis bo'lishi mumkin, shuning uchun
     * `FLUSHALL`/`FLUSHDB` QILMAYMIZ — boshqa tenant/ilova ma'lumotini o'chirib
     * yubormaslik uchun. `reset` — ataylab no-op.
     */
    async reset(): Promise<void> {
      /* intentionally no-op — see comment above */
    },

    async mset(args: Array<[string, unknown]>, ttl?: number): Promise<void> {
      const ms = ttl ?? defaultTtlMs;
      const pipeline = client.pipeline();
      for (const [k, v] of args) {
        if (ms && ms > 0) pipeline.set(k, serialize(v), 'PX', ms);
        else pipeline.set(k, serialize(v));
      }
      await pipeline.exec();
    },

    async mget(...keys: string[]): Promise<unknown[]> {
      if (keys.length === 0) return [];
      const raw = await client.mget(...keys);
      return raw.map((r) => deserialize(r));
    },

    async mdel(...keys: string[]): Promise<void> {
      if (keys.length) await client.del(...keys);
    },

    async keys(pattern = '*'): Promise<string[]> {
      return scanKeys(client, pattern);
    },

    async ttl(key: string): Promise<number> {
      return client.pttl(key);
    },
  };
}