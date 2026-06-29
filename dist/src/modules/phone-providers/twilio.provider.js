"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TwilioProvider = void 0;
const common_1 = require("@nestjs/common");
const twilio_1 = require("twilio");
class TwilioProvider {
    constructor(config) {
        this.config = config;
        this.name = 'TWILIO';
        this.logger = new common_1.Logger('TwilioProvider');
        this.twilio = null;
        if (config?.accountSid && config?.authToken) {
            this.twilio = new twilio_1.Twilio(config.accountSid, config.authToken);
        }
    }
    async initiate(options) {
        if (!this.isConfigured() || !this.twilio) {
            throw new Error('Twilio sozlanmagan');
        }
        try {
            const call = await this.twilio.calls.create({
                to: options.toPhone,
                from: this.config.fromNumber,
                url: this.config.twimlUrl || 'http://demo.twilio.com/docs/voice.xml',
                record: this.config.recordingEnabled !== false,
                recordingStatusCallback: process.env.PUBLIC_URL
                    ? `${process.env.PUBLIC_URL}/api/v1/calls/webhook`
                    : undefined,
            });
            return {
                providerCallId: call.sid,
                status: 'queued',
                raw: { sid: call.sid },
            };
        }
        catch (e) {
            this.logger.error(`Twilio xato: ${e.message}`);
            throw new Error(`Twilio: ${e.message}`);
        }
    }
    async hangup(providerCallId) {
        if (!this.twilio)
            return;
        try {
            await this.twilio.calls(providerCallId).update({ status: 'completed' });
        }
        catch (e) {
            this.logger.warn(`Twilio hangup xato: ${e.message}`);
        }
    }
    parseWebhook(body) {
        const sid = body?.CallSid;
        if (!sid)
            return null;
        const statusMap = {
            'queued': 'queued', 'initiated': 'initiated', 'ringing': 'ringing',
            'in-progress': 'in_progress', 'completed': 'completed',
            'busy': 'busy', 'failed': 'failed',
            'no-answer': 'no_answer', 'canceled': 'canceled',
        };
        return {
            providerCallId: sid,
            status: statusMap[body.CallStatus] || 'completed',
            duration: parseInt(body.CallDuration || '0', 10),
            recordingUrl: body.RecordingUrl || undefined,
            raw: body,
        };
    }
    isConfigured() {
        return !!(this.config?.accountSid &&
            this.config?.authToken &&
            this.config?.fromNumber);
    }
}
exports.TwilioProvider = TwilioProvider;
//# sourceMappingURL=twilio.provider.js.map