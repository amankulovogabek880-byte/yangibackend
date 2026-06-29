import { PrismaService } from '../../prisma/prisma.service';
import { IPhoneProvider } from './provider.interface';
export * from './provider.interface';
export declare class PhoneProviderFactory {
    private prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    getProvider(tenantId: string): Promise<IPhoneProvider>;
    identifyProvider(body: any): 'ONLINEPBX' | 'TWILIO' | null;
}
export declare class PhoneProvidersModule {
}
