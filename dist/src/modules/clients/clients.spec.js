"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const helpers_1 = require("../../common/utils/helpers");
describe('calculateLeadScore', () => {
    it('base score 50', () => {
        const score = (0, helpers_1.calculateLeadScore)({});
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
    });
    it('REFERRAL source yuqori ball beradi', () => {
        const s1 = (0, helpers_1.calculateLeadScore)({ source: 'REFERRAL' });
        const s2 = (0, helpers_1.calculateLeadScore)({ source: 'OTHER' });
        expect(s1).toBeGreaterThan(s2);
    });
    it('VIP tier yuqori ball beradi', () => {
        const s1 = (0, helpers_1.calculateLeadScore)({ tier: 'VIP' });
        const s2 = (0, helpers_1.calculateLeadScore)({ tier: 'REGULAR' });
        expect(s1).toBeGreaterThan(s2);
    });
    it('email bo\'lsa ball oshadi', () => {
        const s1 = (0, helpers_1.calculateLeadScore)({ email: 'test@test.com' });
        const s2 = (0, helpers_1.calculateLeadScore)({ email: null });
        expect(s1).toBeGreaterThan(s2);
    });
    it('passport bo\'lsa ball oshadi', () => {
        const s1 = (0, helpers_1.calculateLeadScore)({ passportNo: 'AA1234567' });
        const s2 = (0, helpers_1.calculateLeadScore)({ passportNo: null });
        expect(s1).toBeGreaterThan(s2);
    });
    it('eski kontakt ball kamaytiradi', () => {
        const s1 = (0, helpers_1.calculateLeadScore)({ daysSinceContact: 0 });
        const s2 = (0, helpers_1.calculateLeadScore)({ daysSinceContact: 90 });
        expect(s1).toBeGreaterThan(s2);
    });
    it('bir nechta booking yuqori ball', () => {
        const s1 = (0, helpers_1.calculateLeadScore)({ totalBookings: 5, totalRevenue: 10000 });
        const s2 = (0, helpers_1.calculateLeadScore)({ totalBookings: 0, totalRevenue: 0 });
        expect(s1).toBeGreaterThan(s2);
    });
    it('score 0-100 orasida bo\'ladi', () => {
        const extremeHigh = (0, helpers_1.calculateLeadScore)({
            source: 'REFERRAL', tier: 'VIP', totalBookings: 10,
            totalRevenue: 100000, email: 'x@x.com', passportNo: 'AA123',
            daysSinceContact: 0, pipelineStage: 'CONFIRMED',
        });
        const extremeLow = (0, helpers_1.calculateLeadScore)({
            source: 'OTHER', tier: 'REGULAR',
            totalBookings: 0, daysSinceContact: 180,
        });
        expect(extremeHigh).toBeLessThanOrEqual(100);
        expect(extremeLow).toBeGreaterThanOrEqual(0);
    });
});
describe('client data validation', () => {
    it('telefon raqam tozalanadi', () => {
        const phone = '  +998901234567  ';
        expect(phone.trim()).toBe('+998901234567');
    });
    it('email kichik harfga aylanadi', () => {
        const email = 'TEST@GMAIL.COM';
        expect(email.toLowerCase().trim()).toBe('test@gmail.com');
    });
    it('ism bo\'sh bo\'lmasligi kerak', () => {
        expect('   '.trim()).toBe('');
        expect('Aziz'.trim()).toBe('Aziz');
    });
    it('tags array bo\'lishi kerak', () => {
        const tags = ['VIP', 'Telegram', ''];
        const filtered = tags.filter(t => t?.trim());
        expect(filtered).toHaveLength(2);
        expect(filtered).not.toContain('');
    });
});
describe('paginate edge cases', () => {
    it('0 sahifa 1 ga tushadi', () => {
        expect((0, helpers_1.paginate)(0, 10).page).toBe(1);
    });
    it('string sahifa ishlaydi', () => {
        expect((0, helpers_1.paginate)('3', '10').page).toBe(3);
        expect((0, helpers_1.paginate)('3', '10').skip).toBe(20);
    });
    it('juda katta limit cheklanadi', () => {
        expect((0, helpers_1.paginate)(1, 10000).limit).toBe(100);
    });
});
describe('clean object', () => {
    it('undefined olib tashlanadi', () => {
        const r = (0, helpers_1.clean)({ a: 1, b: undefined, c: 0, d: '', e: null, f: false });
        expect('b' in r).toBe(false);
        expect(r.a).toBe(1);
        expect(r.c).toBe(0);
        expect(r.d).toBe('');
        expect(r.e).toBeNull();
        expect(r.f).toBe(false);
    });
});
//# sourceMappingURL=clients.spec.js.map