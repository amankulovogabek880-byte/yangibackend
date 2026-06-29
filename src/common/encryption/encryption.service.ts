import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * AES-256-GCM Encryption Service
 *
 * Pasport, manzil va boshqa sezgir ma'lumotlarni shifrlash uchun.
 * Format: base64(iv):base64(authTag):base64(ciphertext)
 *
 * ENCRYPTION_KEY .env'da 64-belgili hex (32 bayt) bo'lishi kerak.
 * Generatsiya: openssl rand -hex 32
 */
@Injectable()
export class EncryptionService implements OnModuleInit {
  private readonly logger = new Logger('Encryption');
  private key!: Buffer;
  private readonly algorithm = 'aes-256-gcm';

  onModuleInit() {
    const keyHex = process.env.ENCRYPTION_KEY;
    if (!keyHex) {
      throw new Error(
        'ENCRYPTION_KEY .env faylda mavjud emas! Generatsiya: openssl rand -hex 32',
      );
    }
    if (keyHex.length !== 64) {
      throw new Error(
        `ENCRYPTION_KEY 64 belgi bo'lishi kerak (32 bayt hex). Hozir: ${keyHex.length}`,
      );
    }
    this.key = Buffer.from(keyHex, 'hex');
    this.logger.log('✅ Encryption service tayyor (AES-256-GCM)');
  }

  /**
   * Matnni shifrlash. Bo'sh string yoki null bo'lsa null qaytaradi.
   */
  encrypt(plaintext: string | null | undefined): string | null {
    if (!plaintext) return null;
    try {
      const iv = crypto.randomBytes(12); // GCM uchun 96-bit IV optimal
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      return [
        iv.toString('base64'),
        authTag.toString('base64'),
        encrypted.toString('base64'),
      ].join(':');
    } catch (e: any) {
      this.logger.error(`Encrypt xatosi: ${e.message}`);
      return null;
    }
  }

  /**
   * Shifrlangan matnni dekript qilish. Xato bo'lsa null qaytaradi.
   */
  decrypt(ciphertext: string | null | undefined): string | null {
    if (!ciphertext) return null;
    try {
      const parts = ciphertext.split(':');
      if (parts.length !== 3) return ciphertext; // backwards compat (eski shifrlanmagan)
      const [ivB64, authTagB64, encryptedB64] = parts;
      const iv = Buffer.from(ivB64, 'base64');
      const authTag = Buffer.from(authTagB64, 'base64');
      const encrypted = Buffer.from(encryptedB64, 'base64');
      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch (e: any) {
      this.logger.warn(`Decrypt xatosi (eski format bo'lishi mumkin): ${e.message}`);
      return null;
    }
  }

  /**
   * Maskalashtirish — pasport "AA1234567" → "AA••••567"
   */
  mask(value: string | null | undefined, visibleStart = 2, visibleEnd = 3): string {
    if (!value) return '';
    if (value.length <= visibleStart + visibleEnd) return '•'.repeat(value.length);
    return (
      value.slice(0, visibleStart) +
      '•'.repeat(Math.max(3, value.length - visibleStart - visibleEnd)) +
      value.slice(-visibleEnd)
    );
  }

  /**
   * Telefon raqamini maskalashtirish: +998 90 123 45 67 → +998 90 *** ** 67
   */
  maskPhone(phone: string | null | undefined): string {
    if (!phone) return '';
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.length < 7) return cleaned;
    return cleaned.slice(0, -5) + '***' + cleaned.slice(-2);
  }

  /**
   * Hash qilish (parol bilan adashtirmaslik kerak — bu faqat tracking uchun)
   */
  hash(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }
}
