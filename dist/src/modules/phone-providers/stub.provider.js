"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StubProvider = void 0;
class StubProvider {
    constructor() {
        this.name = 'STUB';
    }
    async initiate(options) {
        const fakeId = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return {
            providerCallId: fakeId,
            status: 'queued',
            raw: { stub: true, options },
        };
    }
    isConfigured() {
        return true;
    }
}
exports.StubProvider = StubProvider;
//# sourceMappingURL=stub.provider.js.map