import { safeEnum, paginate, meta, generateRef, clean, toInt, toFloat } from './helpers';

describe('helpers', () => {
  describe('safeEnum', () => {
    const list = ['A', 'B', 'C'] as const;
    it('valid qiymat qaytaradi', () => expect(safeEnum('A', list, 'A')).toBe('A'));
    it('invalid uchun default', () => expect(safeEnum('X', list, 'A')).toBe('A'));
    it('undefined uchun default', () => expect(safeEnum(undefined, list, 'B')).toBe('B'));
  });

  describe('paginate', () => {
    it('default qiymatlar', () => {
      const r = paginate(undefined, undefined);
      expect(r.page).toBe(1);
      expect(r.limit).toBe(25);
      expect(r.skip).toBe(0);
    });

    it('2-sahifa', () => {
      const r = paginate(2, 10);
      expect(r.skip).toBe(10);
      expect(r.take).toBe(10);
    });

    it('max limit 100', () => {
      const r = paginate(1, 9999);
      expect(r.limit).toBeLessThanOrEqual(100);
    });

    it('manfiy sahifa 1 ga tushadi', () => {
      const r = paginate(-5, 10);
      expect(r.page).toBe(1);
    });
  });

  describe('meta', () => {
    it('to\'g\'ri meta', () => {
      const m = meta(100, 2, 10);
      expect(m.total).toBe(100);
      expect(m.totalPages).toBe(10);
    });
  });

  describe('generateRef', () => {
    it('to\'g\'ri format', () => {
      const r = generateRef('TRV', 5);
      expect(r).toMatch(/^TRV-\d{4}-0006-/);
    });
    it('unique', () => {
      const refs = Array.from({length: 50}, (_, i) => generateRef('TRV', i));
      const unique = new Set(refs);
      expect(unique.size).toBeGreaterThan(45);
    });
  });

  describe('clean', () => {
    it('undefined qiymatlarni olib tashlaydi', () => {
      const r = clean({ a: 1, b: undefined, c: 'hello', d: null });
      expect(r).toEqual({ a: 1, c: 'hello', d: null });
      expect('b' in r).toBe(false);
    });
  });

  describe('toInt', () => {
    it('raqamni to\'g\'ri o\'giradi', () => expect(toInt('5', 1)).toBe(5));
    it('noto\'g\'ri string uchun default', () => expect(toInt('abc', 10)).toBe(10));
    it('manfiy uchun default', () => expect(toInt(-1, 10)).toBe(10));
  });

  describe('toFloat', () => {
    it('float to\'g\'ri', () => expect(toFloat('3.14', 0)).toBeCloseTo(3.14));
    it('noto\'g\'ri uchun default', () => expect(toFloat('abc', 0)).toBe(0));
  });
});
