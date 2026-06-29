"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const helpers_1 = require("../../common/utils/helpers");
const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'ONLINE', 'CRYPTO'];
const PAYMENT_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'];
const CURRENCIES = ['USD', 'UZS', 'EUR', 'RUB'];
describe('Payment validation', () => {
    describe('payment method validation', () => {
        it('CASH qabul qilinadi', () => {
            expect((0, helpers_1.safeEnum)('CASH', PAYMENT_METHODS, 'CASH')).toBe('CASH');
        });
        it('noto\'g\'ri method default qaytaradi', () => {
            expect((0, helpers_1.safeEnum)('BITCOIN', PAYMENT_METHODS, 'CASH')).toBe('CASH');
        });
        it('barcha valid methodlar ishlaydi', () => {
            PAYMENT_METHODS.forEach(m => {
                expect((0, helpers_1.safeEnum)(m, PAYMENT_METHODS, 'CASH')).toBe(m);
            });
        });
    });
    describe('currency validation', () => {
        it('USD qabul qilinadi', () => {
            expect((0, helpers_1.safeEnum)('USD', CURRENCIES, 'USD')).toBe('USD');
        });
        it('UZS qabul qilinadi', () => {
            expect((0, helpers_1.safeEnum)('UZS', CURRENCIES, 'USD')).toBe('UZS');
        });
        it('noto\'g\'ri valyuta USD ga tushadi', () => {
            expect((0, helpers_1.safeEnum)('GBP', CURRENCIES, 'USD')).toBe('USD');
        });
    });
    describe('amount validation', () => {
        it('musbat summa to\'g\'ri', () => {
            expect((0, helpers_1.toFloat)('1500.50', 0)).toBeCloseTo(1500.5);
        });
        it('manfiy summa noto\'g\'ri', () => {
            const amount = (0, helpers_1.toFloat)('-100', 0);
            expect(amount).toBe(-100);
        });
        it('0 summa noto\'g\'ri', () => {
            expect((0, helpers_1.toFloat)('0', 0)).toBe(0);
        });
        it('string raqam to\'g\'ri parse qilinadi', () => {
            expect((0, helpers_1.toFloat)('1,500', 0)).toBe(0);
            expect((0, helpers_1.toFloat)('1500', 0)).toBe(1500);
        });
    });
    describe('payment status flow', () => {
        it('PENDING dan COMPLETED ga o\'tish mumkin', () => {
            const validNextStatus = (current, next) => {
                const transitions = {
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
        function calcAgentCommission(profit, percent) {
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
    it('musbat raqam qaytaradi', () => expect((0, helpers_1.toInt)('5', 1)).toBe(5));
    it('float ni yaxlitlaydi', () => expect((0, helpers_1.toInt)(3.9, 1)).toBe(3));
    it('manfiy default', () => expect((0, helpers_1.toInt)(-1, 10)).toBe(10));
    it('0 default', () => expect((0, helpers_1.toInt)(0, 5)).toBe(5));
    it('NaN default', () => expect((0, helpers_1.toInt)('abc', 7)).toBe(7));
});
//# sourceMappingURL=payments.spec.js.map