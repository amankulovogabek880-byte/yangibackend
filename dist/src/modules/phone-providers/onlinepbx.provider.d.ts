import { IPhoneProvider, CallInitiateOptions, CallInitiateResult, WebhookEvent, PhoneConfig } from './provider.interface';
export declare class OnlinePbxProvider implements IPhoneProvider {
    private config;
    name: string;
    private readonly logger;
    constructor(config: PhoneConfig['onlinepbx']);
    initiate(options: CallInitiateOptions): Promise<CallInitiateResult>;
    hangup(providerCallId: string): Promise<void>;
    parseWebhook(body: any): WebhookEvent | null;
    getRecordingUrl(providerCallId: string): Promise<string | null>;
    isConfigured(): boolean;
}
