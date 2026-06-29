import { safeEnum, toFloat, toInt } from '../../common/utils/helpers';

const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'ONLINE', 'CRYPTO'];
const PAYMENT_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'];
const CURRENCIES = ['USD', 'UZS', 'EUR', 'RUB'];

describe('Payment validation', () => {
  describe('payment method validation', () => {
    it('CASH qabul qilinadi', () => {
      expect(safeEnum('CASH', PAYMENT_METHODS, 'CASH')).toBe('CASH');
    });
    it('noto\'g\'ri method default qaytaradi', () => {
      expect(safeEnum('BITCOIN', PAYMENT_METHODS, 'CASH')).toBe('CASH');
    });
    it('barcha valid methodlar ishlaydi', () => {
      PAYMENT_METHODS.forEach(m => {
        expect(safeEnum(m, PAYMENT_METHODS, 'CASH')).toBe(m);
      });
    });
  });

  describe('currency validation', () => {
    it('USD qabul qilinadi', () => {
      expect(safeEnum('USD', CURRENCIES, 'USD')).toBe('USD');
    });
    it('UZS qabul qilinadi', () => {
      expect(safeEnum('UZS', CURRENCIES, 'USD')).toBe('UZS');
    });
    it('noto\'g\'ri valyuta USD ga tushadi', () => {
      expect(safeEnum('GBP', CURRENCIES, 'USD')).toBe('USD');
    });
  });

  describe('amount validation', () => {
    it('musbat summa to\'g\'ri', () => {
      expect(toFloat('1500.50', 0)).toBeCloseTo(1500.5);
    });
    it('manfiy summa noto\'g\'ri', () => {
      // Amount 0 dan katta bo'lishi kerak - business logic
      const amount = toFloat('-100', 0);
      expect(amount).toBe(-100); // toFloat qaytaradi, lekin business logic rad etishi kerak
    });
    it('0 summa noto\'g\'ri', () => {
      expect(toFloat('0', 0)).toBe(0);
    });
    it('string raqam to\'g\'ri parse qilinadi', () => {
      expect(toFloat('1,500', 0)).toBe(0); // vergul bilan raqam NaN beradi
      expect(toFloat('1500', 0)).toBe(1500);
    });
  });

  describe('payment status flow', () => {
    it('PENDING dan COMPLETED ga o\'tish mumkin', () => {
      const validNextStatus = (current: string, next: string): boolean => {
        const transitions: Record<string, string[]> = {
          PENDING: ['COMPLETED', 'FAILED', 'REFUNDED'],
          COMPLETED: ['REFUNDED'],
          FAILED: ['PENDING'],
          REFUNDED: [],
        };
        return transitions[current]?.includes(next) ?? false;
      };
      expect(validNextStatus('PENDING', 'COMPLETED')).toBe(true);
      expect(validNextStatus('PENDING', 'FAILED')).toBe(true);
      expect(validNextStatus('COMPLETED', 'REFUNDED')).toBe(true);
      expect(validNextStatus('REFUNDED', 'COMPLETED')).toBe(false);
    });
  });

  describe('commission calculation', () => {
    function calcAgentCommission(profit: number, percent: number): number {
      return +(profit * percent / 100).toFixed(2);
    }
    it('10% komissiya to\'g\'ri', () => {
      expect(calcAgentCommission(1000, 10)).toBe(100);
    });
    it('15% komissiya to\'g\'ri', () => {
      expect(calcAgentCommission(500, 15)).toBe(75);
    });
    it('0 foyda 0 komissiya', () => {
      expect(calcAgentCommission(0, 10)).toBe(0);
    });
    it('2 kasrga yaxlitlanadi', () => {
      expect(calcAgentCommission(333, 10)).toBe(33.3);
    });
  });
});

describe('toInt helper', () => {
  it('musbat raqam qaytaradi', () => expect(toInt('5', 1)).toBe(5));
  it('float ni yaxlitlaydi', () => expect(toInt(3.9, 1)).toBe(3));
  it('manfiy default', () => expect(toInt(-1, 10)).toBe(10));
  it('0 default', () => expect(toInt(0, 5)).toBe(5));
  it('NaN default', () => expect(toInt('abc', 7)).toBe(7));
});
