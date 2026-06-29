import { IPhoneProvider, CallInitiateOptions, CallInitiateResult } from './provider.interface';

/**
 * STUB Provider — demo va sotuv ko'rgazmasi uchun.
 * Hech qanday real qo'ng'iroq qilmaydi, lekin UI to'liq ishlaydi.
 */
export class StubProvider implements IPhoneProvider {
  name = 'STUB';

  async initiate(options: CallInitiateOptions): Promise<CallInitiateResult> {
    const fakeId = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      providerCallId: fakeId,
      status: 'queued',
      raw: { stub: true, options },
    };
  }

  isConfigured(): boolean {
    return true; // Har doim ishlaydi
  }
}
