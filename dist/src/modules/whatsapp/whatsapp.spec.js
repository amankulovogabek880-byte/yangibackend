describe('WhatsApp phone formatting', () => {
    function formatPhone(phone) {
        return phone.replace(/[^0-9]/g, '');
    }
    it('+998901234567 formatlanadi', () => {
        expect(formatPhone('+998901234567')).toBe('998901234567');
    });
    it('bo\'sh joy va tire olib tashlanadi', () => {
        expect(formatPhone('+998 90 123 45 67')).toBe('998901234567');
    });
    it('faqat raqamlar qoladi', () => {
        expect(formatPhone('(998)90-123-45-67')).toBe('998901234567');
    });
    it('qisqa raqam xato', () => {
        expect(formatPhone('+99890').length).toBeLessThan(9);
    });
});
describe('WhatsApp message templates', () => {
    function bookingConfirmationMsg(data) {
        return [
            `✈️ *Booking tasdiqlandi!*`,
            ``,
            `Hurmatli *${data.clientName}*,`,
            ``,
            `• Ref: \`${data.bookingRef}\``,
            `• Tur: ${data.tourName}`,
            data.departureDate ? `• Ketish: ${data.departureDate}` : null,
            data.totalPrice ? `• Narx: *${data.totalPrice} ${data.currency || 'USD'}*` : null,
        ].filter(Boolean).join('\n');
    }
    it('to\'liq xabar generatsiya', () => {
        const msg = bookingConfirmationMsg({
            clientName: 'Aziz',
            tourName: 'Dubay turi',
            bookingRef: 'TRV-2026-0001',
            departureDate: '2026-07-15',
            totalPrice: 1500,
            currency: 'USD',
        });
        expect(msg).toContain('Aziz');
        expect(msg).toContain('TRV-2026-0001');
        expect(msg).toContain('Dubay turi');
        expect(msg).toContain('1500 USD');
        expect(msg).toContain('2026-07-15');
    });
    it('ixtiyoriy maydonlarsiz', () => {
        const msg = bookingConfirmationMsg({
            clientName: 'Test', tourName: 'Tur', bookingRef: 'REF-001',
        });
        expect(msg).toContain('Test');
        expect(msg).not.toContain('undefined');
        expect(msg).not.toContain('null');
    });
    it('xabar bo\'sh emas', () => {
        const msg = bookingConfirmationMsg({
            clientName: 'A', tourName: 'B', bookingRef: 'C',
        });
        expect(msg.trim().length).toBeGreaterThan(10);
    });
});
describe('WhatsApp config validation', () => {
    function validateConfig(cfg) {
        if (!cfg.instanceId?.trim())
            return 'instanceId majburiy';
        if (!cfg.token?.trim())
            return 'token majburiy';
        return null;
    }
    it('to\'g\'ri config', () => {
        expect(validateConfig({ instanceId: 'abc123', token: 'tok456' })).toBeNull();
    });
    it('instanceId yo\'q', () => {
        expect(validateConfig({ token: 'tok' })).not.toBeNull();
    });
    it('token yo\'q', () => {
        expect(validateConfig({ instanceId: 'id' })).not.toBeNull();
    });
    it('bo\'sh string', () => {
        expect(validateConfig({ instanceId: '  ', token: 'tok' })).not.toBeNull();
    });
});
//# sourceMappingURL=whatsapp.spec.js.map