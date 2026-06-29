import { IPhoneProvider, CallInitiateOptions, CallInitiateResult, WebhookEvent, PhoneConfig } from './provider.interface';
import { Logger } from '@nestjs/common';
import * as net from 'net';

interface CustomSipConfig {
  amiHost?: string;
  amiPort?: number;
  amiUser?: string;
  amiPassword?: string;
  context?: string;
  callerId?: string;
  restUrl?: string;
  restKey?: string;
  restType?: string;
}

export class CustomSipProvider implements IPhoneProvider {
  name = 'CUSTOM_SIP';
  private cfg: CustomSipConfig;
  private logger = new Logger('CustomSipProvider');

  constructor(config: any = {}) {
    this.cfg = config || {};
  }

  async initiate(data: CallInitiateOptions): Promise<CallInitiateResult> {
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

  private async initiateViaRest(toPhone: string, extension: string): Promise<CallInitiateResult> {
    const callId = 'sip-' + Date.now();
    try {
      let url = this.cfg.restUrl!;
      let body: any = { to: toPhone, from: extension, callerId: this.cfg.callerId };
      const headers: any = { 'Content-Type': 'application/json' };
      if (this.cfg.restType === 'freepbx') {
        url = this.cfg.restUrl + '/api/rest/call';
        body = { extension, number: toPhone, context: this.cfg.context || 'from-internal' };
        if (this.cfg.restKey) headers['X-API-Key'] = this.cfg.restKey;
      } else if (this.cfg.restType === 'fusionpbx') {
        url = this.cfg.restUrl + '/app/originate/originate_call.php';
        body = { extension, destination: toPhone, caller_id: this.cfg.callerId || extension };
        if (this.cfg.restKey) headers['Authorization'] = 'Bearer ' + this.cfg.restKey;
      } else {
        if (this.cfg.restKey) headers['Authorization'] = 'Bearer ' + this.cfg.restKey;
      }
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      return { providerCallId: json.call_id || json.uuid || callId, status: 'INITIATED' };
    } catch (e: any) {
      throw new Error('CustomSIP REST error: ' + e.message);
    }
  }

  private async initiateViaAmi(toPhone: string, extension: string): Promise<CallInitiateResult> {
    const callId = 'ami-' + Date.now();
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const CRLF = CR + LF;
    const SEP = CRLF + CRLF;
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const host = this.cfg.amiHost!;
      const port = this.cfg.amiPort || 5038;
      let authed = false;
      let buf = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('AMI timeout')); }, 8000);
      socket.connect(port, host, () => { this.logger.log('AMI ok: ' + host + ':' + port); });
      socket.on('data', (d) => {
        buf += d.toString();
        const blocks = buf.split(SEP);
        for (const block of blocks) {
          if (!block.trim()) continue;
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

  isConfigured(): boolean {
    return !!(this.cfg.amiHost || this.cfg.restUrl);
  }

  parseWebhook(body: any): WebhookEvent | null {
    if (!body) return null;
    const statusMap: Record<string, WebhookEvent['status']> = {
      'ANSWERED': 'completed', 'NO ANSWER': 'no_answer', 'BUSY': 'busy', 'FAILED': 'failed',
    };
    const status = statusMap[body.disposition] || null;
    if (!status) return null;
    return {
      raw: body,
      providerCallId: body.uniqueid || body.callId || body.uuid,
      status,
      duration: parseInt(body.billsec || body.duration || '0'),
      recordingUrl: body.recordingUrl || null,
    };
  }

  async hangup(callId: string): Promise<void> {
    if (!this.cfg.amiHost) return;
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
    socket.on('error', () => {});
  }
}
