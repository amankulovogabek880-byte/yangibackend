"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OnlinePbxProvider = void 0;
const common_1 = require("@nestjs/common");
class OnlinePbxProvider {
    constructor(config) {
        this.config = config;
        this.name = 'ONLINEPBX';
        this.logger = new common_1.Logger('OnlinePbxProvider');
    }
    async initiate(options) {
        if (!this.isConfigured()) {
            throw new Error('OnlinePBX sozlanmagan. Tenant Settings → Phone Provider');
        }
        const domain = this.config.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const url = `https://${domain}/Mobile/v3/Calls/originate`;
        if (!options.agentExtension) {
            throw new Error("Agentning extension'i kiritilmagan. " +
                "Sozlamalar → Profil → 'ATS ichki raqam' (masalan, 101)");
        }
        let toPhone = options.toPhone.replace(/[^\d+]/g, '');
        if (!toPhone.startsWith('+')) {
            if (toPhone.startsWith('998'))
                toPhone = '+' + toPhone;
            else if (toPhone.startsWith('8') && toPhone.length === 9)
                toPhone = '+998' + toPhone;
            else
                toPhone = '+' + toPhone;
        }
        const body = {
            from: options.agentExtension,
            to: toPhone,
            callerId: this.config.callerId,
            recording: this.config.recordingEnabled !== false,
        };
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': this.config.apiKey || '',
                    'X-API-ID': this.config.apiId || '',
                },
                body: JSON.stringify(body),
            });
            const json = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(`OnlinePBX xato: ${response.status} ${json?.message || json?.error || 'Noma\'lum'}`);
            }
            const callId = json?.call_id || json?.uuid || json?.id;
            if (!callId) {
                throw new Error('OnlinePBX call_id qaytarmadi');
            }
            return {
                providerCallId: String(callId),
                status: json?.status || 'queued',
                raw: json,
            };
        }
        catch (e) {
            this.logger.error(`OnlinePBX xato: ${e.message}`);
            throw e;
        }
    }
    async hangup(providerCallId) {
        if (!this.isConfigured())
            return;
        const domain = this.config.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const url = `https://${domain}/Mobile/v3/Calls/hangup`;
        try {
            await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-KEY': this.config.apiKey || '',
                    'X-API-ID': this.config.apiId || '',
                },
                body: JSON.stringify({ call_id: providerCallId }),
            });
        }
        catch (e) {
            this.logger.warn(`OnlinePBX hangup xato: ${e.message}`);
        }
    }
    parseWebhook(body) {
        if (!body)
            return null;
        const callId = body?.uuid || body?.call_id || body?.id;
        if (!callId)
            return null;
        const statusMap = {
            'queued': 'queued',
            'ringing': 'ringing',
            'in_progress': 'in_progress',
            'answered': 'in_progress',
            'completed': 'completed',
            'finished': 'completed',
            'busy': 'busy',
            'no_answer': 'no_answer',
            'failed': 'failed',
            'canceled': 'canceled',
        };
        return {
            providerCallId: String(callId),
            status: statusMap[String(body.status).toLowerCase()] || 'completed',
            duration: body?.duration_seconds || body?.duration || 0,
            recordingUrl: body?.recording_url || body?.recording || undefined,
            raw: body,
        };
    }
    async getRecordingUrl(providerCallId) {
        if (!this.isConfigured())
            return null;
        const domain = this.config.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const url = `https://${domain}/Mobile/v3/Calls/${providerCallId}/recording`;
        try {
            const res = await fetch(url, {
                headers: {
                    'X-API-KEY': this.config.apiKey || '',
                    'X-API-ID': this.config.apiId || '',
                },
            });
            if (!res.ok)
                return null;
            const json = await res.json().catch(() => null);
            return json?.url || json?.recording_url || null;
        }
        catch {
            return null;
        }
    }
    isConfigured() {
        return !!(this.config?.domain &&
            this.config?.apiKey &&
            this.config?.apiId);
    }
}
exports.OnlinePbxProvider = OnlinePbxProvider;
//# sourceMappingURL=onlinepbx.provider.js.map