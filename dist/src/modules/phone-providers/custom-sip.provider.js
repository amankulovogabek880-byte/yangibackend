"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomSipProvider = void 0;
const common_1 = require("@nestjs/common");
const net = __importStar(require("net"));
class CustomSipProvider {
    constructor(config = {}) {
        this.name = 'CUSTOM_SIP';
        this.logger = new common_1.Logger('CustomSipProvider');
        this.cfg = config || {};
    }
    async initiate(data) {
        const ext = data.agentExtension || data.agentPhone || '100';
        this.logger.log('CustomSIP call: ext=' + ext + ' to=' + data.toPhone);
        if (this.cfg.restUrl) {
            return this.initiateViaRest(data.toPhone, ext);
        }
        if (this.cfg.amiHost) {
            return this.initiateViaAmi(data.toPhone, ext);
        }
        return { providerCallId: 'tel-' + Date.now(), status: 'INITIATED', clientAction: { type: 'tel', payload: data.toPhone } };
    }
    async initiateViaRest(toPhone, extension) {
        const callId = 'sip-' + Date.now();
        try {
            let url = this.cfg.restUrl;
            let body = { to: toPhone, from: extension, callerId: this.cfg.callerId };
            const headers = { 'Content-Type': 'application/json' };
            if (this.cfg.restType === 'freepbx') {
                url = this.cfg.restUrl + '/api/rest/call';
                body = { extension, number: toPhone, context: this.cfg.context || 'from-internal' };
                if (this.cfg.restKey)
                    headers['X-API-Key'] = this.cfg.restKey;
            }
            else if (this.cfg.restType === 'fusionpbx') {
                url = this.cfg.restUrl + '/app/originate/originate_call.php';
                body = { extension, destination: toPhone, caller_id: this.cfg.callerId || extension };
                if (this.cfg.restKey)
                    headers['Authorization'] = 'Bearer ' + this.cfg.restKey;
            }
            else {
                if (this.cfg.restKey)
                    headers['Authorization'] = 'Bearer ' + this.cfg.restKey;
            }
            const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
            const json = await res.json().catch(() => ({}));
            return { providerCallId: json.call_id || json.uuid || callId, status: 'INITIATED' };
        }
        catch (e) {
            throw new Error('CustomSIP REST error: ' + e.message);
        }
    }
    async initiateViaAmi(toPhone, extension) {
        const callId = 'ami-' + Date.now();
        const CR = String.fromCharCode(13);
        const LF = String.fromCharCode(10);
        const CRLF = CR + LF;
        const SEP = CRLF + CRLF;
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            const host = this.cfg.amiHost;
            const port = this.cfg.amiPort || 5038;
            let authed = false;
            let buf = '';
            const timer = setTimeout(() => { socket.destroy(); reject(new Error('AMI timeout')); }, 8000);
            socket.connect(port, host, () => { this.logger.log('AMI ok: ' + host + ':' + port); });
            socket.on('data', (d) => {
                buf += d.toString();
                const blocks = buf.split(SEP);
                for (const block of blocks) {
                    if (!block.trim())
                        continue;
                    if (!authed && block.includes('Asterisk Call Manager')) {
                        socket.write('Action: Login' + CRLF + 'Username: ' + this.cfg.amiUser + CRLF + 'Secret: ' + this.cfg.amiPassword + SEP);
                    }
                    if (block.includes('Authentication accepted')) {
                        authed = true;
                        const cmd = 'Action: Originate' + CRLF
                            + 'Channel: SIP/' + extension + CRLF
                            + 'Context: ' + (this.cfg.context || 'from-internal') + CRLF
                            + 'Exten: ' + toPhone + CRLF
                            + 'Priority: 1' + CRLF
                            + 'CallerID: ' + (this.cfg.callerId || extension) + CRLF
                            + 'Timeout: 30000' + CRLF
                            + 'ActionID: ' + callId + SEP;
                        socket.write(cmd);
                    }
                    if (block.includes('Response: Success') && block.includes(callId)) {
                        clearTimeout(timer);
                        socket.write('Action: Logoff' + SEP);
                        socket.destroy();
                        resolve({ providerCallId: callId, status: 'INITIATED' });
                    }
                    if (block.includes('Response: Error')) {
                        clearTimeout(timer);
                        socket.destroy();
                        reject(new Error('AMI error'));
                    }
                }
                buf = blocks[blocks.length - 1] || '';
            });
            socket.on('error', (e) => { clearTimeout(timer); reject(e); });
        });
    }
    isConfigured() {
        return !!(this.cfg.amiHost || this.cfg.restUrl);
    }
    parseWebhook(body) {
        if (!body)
            return null;
        const statusMap = {
            'ANSWERED': 'completed', 'NO ANSWER': 'no_answer', 'BUSY': 'busy', 'FAILED': 'failed',
        };
        const status = statusMap[body.disposition] || null;
        if (!status)
            return null;
        return {
            raw: body,
            providerCallId: body.uniqueid || body.callId || body.uuid,
            status,
            duration: parseInt(body.billsec || body.duration || '0'),
            recordingUrl: body.recordingUrl || null,
        };
    }
    async hangup(callId) {
        if (!this.cfg.amiHost)
            return;
        const CR = String.fromCharCode(13);
        const LF = String.fromCharCode(10);
        const CRLF = CR + LF;
        const SEP = CRLF + CRLF;
        const socket = new net.Socket();
        socket.connect(this.cfg.amiPort || 5038, this.cfg.amiHost, () => {
            socket.write('Action: Login' + CRLF + 'Username: ' + this.cfg.amiUser + CRLF + 'Secret: ' + this.cfg.amiPassword + SEP);
            setTimeout(() => {
                socket.write('Action: Hangup' + CRLF + 'Channel: ' + callId + SEP);
                setTimeout(() => { socket.write('Action: Logoff' + SEP); socket.destroy(); }, 500);
            }, 1000);
        });
        socket.on('error', () => { });
    }
}
exports.CustomSipProvider = CustomSipProvider;
//# sourceMappingURL=custom-sip.provider.js.map