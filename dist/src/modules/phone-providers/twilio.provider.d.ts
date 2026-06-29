import { IPhoneProvider, CallInitiateOptions, CallInitiateResult, WebhookEvent, PhoneConfig } from './provider.interface';
export declare class TwilioProvider implements IPhoneProvider {
    private config;
    name: string;
    private readonly logger;
    private twilio;
    constructor(config: PhoneConfig['twilio']);
    initiate(options: CallInitiateOptions): Promise<CallInitiateResult>;
    hangup(providerCallId: string): Promise<void>;
    parseWebhook(body: any): WebhookEvent | null;
    isConfigured(): boolean;
}
