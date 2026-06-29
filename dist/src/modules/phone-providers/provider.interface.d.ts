export interface CallInitiateOptions {
    toPhone: string;
    agentId: string;
    agentPhone?: string;
    agentExtension?: string;
    clientName?: string;
}
export interface CallInitiateResult {
    providerCallId: string;
    status: string;
    raw?: any;
    clientAction?: {
        type: 'tel' | 'redirect' | 'none';
        payload: string;
    };
}
export interface WebhookEvent {
    providerCallId: string;
    status: 'queued' | 'initiated' | 'ringing' | 'in_progress' | 'completed' | 'busy' | 'failed' | 'no_answer' | 'canceled';
    duration?: number;
    recordingUrl?: string;
    raw?: any;
}
export interface IPhoneProvider {
    name: string;
    initiate(options: CallInitiateOptions): Promise<CallInitiateResult>;
    hangup?(providerCallId: string): Promise<void>;
    parseWebhook?(body: any): WebhookEvent | null;
    getRecordingUrl?(providerCallId: string): Promise<string | null>;
    isConfigured(): boolean;
}
export interface PhoneConfig {
    enabled?: boolean;
    defaultProvider?: string;
    onlinepbx?: {
        domain?: string;
        apiKey?: string;
        apiId?: string;
        callerId?: string;
        recordingEnabled?: boolean;
    };
    twilio?: {
        accountSid?: string;
        authToken?: string;
        fromNumber?: string;
        twimlUrl?: string;
        recordingEnabled?: boolean;
    };
    customSip?: {
        amiHost?: string;
        amiPort?: number;
        amiUser?: string;
        amiPassword?: string;
        context?: string;
        callerId?: string;
        restUrl?: string;
        restKey?: string;
        restType?: string;
    };
    myati?: {
        apiKey?: string;
        domain?: string;
    };
}
