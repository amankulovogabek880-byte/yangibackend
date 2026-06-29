"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelLinkProvider = void 0;
class TelLinkProvider {
    constructor() {
        this.name = 'TEL_LINK';
    }
    async initiate(options) {
        let phone = options.toPhone.replace(/[^\d+]/g, '');
        if (!phone.startsWith('+')) {
            if (phone.startsWith('998'))
                phone = '+' + phone;
            else if (phone.startsWith('8') && phone.length === 9)
                phone = '+998' + phone;
            else
                phone = '+' + phone;
        }
        const id = `tel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return {
            providerCallId: id,
            status: 'initiated',
            clientAction: {
                type: 'tel',
                payload: `tel:${phone}`,
            },
            raw: { telLink: `tel:${phone}` },
        };
    }
    isConfigured() {
        return true;
    }
}
exports.TelLinkProvider = TelLinkProvider;
//# sourceMappingURL=tel-link.provider.js.map