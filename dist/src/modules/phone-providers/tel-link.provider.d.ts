import { IPhoneProvider, CallInitiateOptions, CallInitiateResult } from './provider.interface';
export declare class TelLinkProvider implements IPhoneProvider {
    name: string;
    initiate(options: CallInitiateOptions): Promise<CallInitiateResult>;
    isConfigured(): boolean;
}
