import { IPhoneProvider, CallInitiateOptions, CallInitiateResult, WebhookEvent } from './provider.interface';
export declare class CustomSipProvider implements IPhoneProvider {
    name: string;
    private cfg;
    private logger;
    constructor(config?: any);
    initiate(data: CallInitiateOptions): Promise<CallInitiateResult>;
    private initiateViaRest;
    private initiateViaAmi;
    isConfigured(): boolean;
    parseWebhook(body: any): WebhookEvent | null;
    hangup(callId: string): Promise<void>;
}
