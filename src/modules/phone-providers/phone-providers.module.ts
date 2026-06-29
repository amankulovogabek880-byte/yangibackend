import { Injectable, Module, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { IPhoneProvider, PhoneConfig } from './provider.interface';
import { StubProvider } from './stub.provider';
import { TelLinkProvider } from './tel-link.provider';
import { OnlinePbxProvider } from './onlinepbx.provider';
import { TwilioProvider } from './twilio.provider';
import { CustomSipProvider } from './custom-sip.provider';

export * from './provider.interface';

/**
 * v8: PhoneProviderFactory
 *
 * Tenant'ning sozlamasiga qarab to'g'ri provayder qaytaradi.
 * Har tenant o'z provayderini tanlay oladi.
 */
@Injectable()
export class PhoneProviderFactory {
  private readonly logger = new Logger('PhoneProviderFactory');

  constructor(private prisma: PrismaService) {}

  /**
   * Tenant uchun aktiv provayder
   */
  async getProvider(tenantId: string): Promise<IPhoneProvider> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { phoneProvider: true, phoneConfig: true },
    });

    if (!tenant) return new StubProvider();

    const config = (tenant.phoneConfig as PhoneConfig) || {};

    switch (tenant.phoneProvider) {
      case 'ONLINEPBX':
        return new OnlinePbxProvider(config.onlinepbx);
      case 'TWILIO':
        return new TwilioProvider(config.twilio);
      case 'TEL_LINK':
        return new TelLinkProvider();
      case 'CUSTOM_SIP':
        return new CustomSipProvider(config.customSip);
      case 'MYATI':
        // TODO: MyAti provider qo'shilganda
        this.logger.warn("MyAti hozircha qo'llab-quvvatlanmaydi, STUB ishlaydi");
        return new StubProvider();
      case 'STUB':
      default:
        return new StubProvider();
    }
  }

  /**
   * Webhook'dan kelgan ma'lumotni qaysi provayder degan tushunish.
   * Body structura'sidan aniqlaymiz.
   */
  identifyProvider(body: any): 'ONLINEPBX' | 'TWILIO' | null {
    if (body?.CallSid) return 'TWILIO';
    if (body?.uuid || body?.call_id) return 'ONLINEPBX';
    if (body?.uniqueid || body?.disposition) return 'CUSTOM_SIP' as any;
    return null;
  }
}

@Module({
  providers: [PhoneProviderFactory],
  exports: [PhoneProviderFactory],
})
export class PhoneProvidersModule {}
