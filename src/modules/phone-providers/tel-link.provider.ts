import { IPhoneProvider, CallInitiateOptions, CallInitiateResult } from './provider.interface';

/**
 * TEL_LINK Provider — BEPUL, sodda yechim.
 *
 * Qanday ishlaydi:
 *  1. Agent CRM'da Call tugmasini bosadi
 *  2. Backend `tel:` link qaytaradi
 *  3. Frontend `window.location.href = tel:+998901234567` qiladi
 *  4. Agent'ning brauzeri/mobil telefonidan ochiladi
 *  5. Agent o'z mobil telefonidan qo'ng'iroq qiladi
 *  6. Suhbatdan keyin CRM'da izoh yozadi (qo'lda)
 *
 * Afzalliklari:
 *  - Bepul
 *  - Server kerak emas
 *  - Klient agentning shaxsiy raqamini ko'radi (tanish)
 *  - Mobile va desktop'da ishlaydi
 *
 * Kamchiliklari:
 *  - Avtomatik recording yo'q
 *  - Avtomatik vaqt qayd qilmaydi (agent qo'lda kiritadi)
 */
export class TelLinkProvider implements IPhoneProvider {
  name = 'TEL_LINK';

  async initiate(options: CallInitiateOptions): Promise<CallInitiateResult> {
    // E.164 formatga keltirish
    let phone = options.toPhone.replace(/[^\d+]/g, '');
    if (!phone.startsWith('+')) {
      if (phone.startsWith('998')) phone = '+' + phone;
      else if (phone.startsWith('8') && phone.length === 9) phone = '+998' + phone;
      else phone = '+' + phone;
    }

    const id = `tel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    return {
      providerCallId: id,
      status: 'initiated',
      clientAction: {
        type: 'tel',
        payload: `tel:${phone}`,
      },
      raw: { telLink: `tel:${phone}` },
    };
  }

  isConfigured(): boolean {
    return true; // Hech qanday config kerak emas
  }
}
