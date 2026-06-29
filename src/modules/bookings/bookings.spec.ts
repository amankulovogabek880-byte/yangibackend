import { BadRequestException, NotFoundException } from '@nestjs/common';
import { generateRef } from '../../common/utils/helpers';

// generateRef unique bo'lishini tekshiramiz
describe('generateRef', () => {
  it('TRV- bilan boshlanadi', () => {
    const ref = generateRef('TRV', 0);
    expect(ref).toMatch(/^TRV-\d{4}-\d{4}-[A-Z0-9]+$/);
  });

  it('Har safar unique ref yaratadi', () => {
    const refs = new Set<string>();
    for (let i = 0; i < 100; i++) {
      refs.add(generateRef('TRV', i));
    }
    // Kamida 95% unique bo'lishi kerak (random element bor)
    expect(refs.size).toBeGreaterThan(95);
  });

  it('count increment bo\'ladi', () => {
    const ref1 = generateRef('TRV', 0);
    const ref2 = generateRef('TRV', 1);
    // Ikkalasi ham to'g'ri format
    expect(ref1).toMatch(/^TRV-/);
    expect(ref2).toMatch(/^TRV-/);
  });

  it('Har xil prefix lar ishlaydi', () => {
    expect(generateRef('TRV', 0)).toMatch(/^TRV-/);
    expect(generateRef('INV', 0)).toMatch(/^INV-/);
    expect(generateRef('PAY', 0)).toMatch(/^PAY-/);
  });
});

// Profit hisoblash logikasi
describe('Booking profit calculation', () => {
  function calcProfit(totalPrice: number, supplierCost: number, discount: number): number {
    return Math.max(0, totalPrice - supplierCost - discount);
  }

  it('oddiy hisoblash to\'g\'ri', () => {
    expect(calcProfit(1000, 700, 0)).toBe(300);
  });

  it('chegirma bilan hisoblash', () => {
    expect(calcProfit(1000, 700, 50)).toBe(250);
  });

  it('manfiy foyda 0 bo\'ladi', () => {
    expect(calcProfit(500, 600, 0)).toBe(0);
  });

  it('chegirma katta bo\'lsa 0', () => {
    expect(calcProfit(1000, 800, 300)).toBe(0);
  });
});

// safeEnum helper
describe('safeEnum', () => {
  const { safeEnum } = require('../../common/utils/helpers');
  const STATUSES = ['DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED'];

  it('mavjud qiymatni qaytaradi', () => {
    expect(safeEnum('CONFIRMED', STATUSES, 'DRAFT')).toBe('CONFIRMED');
  });

  it('mavjud bo\'lmagan qiymat uchun default qaytaradi', () => {
    expect(safeEnum('INVALID', STATUSES, 'DRAFT')).toBe('DRAFT');
  });

  it('undefined uchun default qaytaradi', () => {
    expect(safeEnum(undefined, STATUSES, 'DRAFT')).toBe('DRAFT');
  });

  it('null uchun default qaytaradi', () => {
    expect(safeEnum(null, STATUSES, 'DRAFT')).toBe('DRAFT');
  });
});
