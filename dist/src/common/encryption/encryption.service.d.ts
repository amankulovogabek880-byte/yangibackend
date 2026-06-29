import { OnModuleInit } from '@nestjs/common';
export declare class EncryptionService implements OnModuleInit {
    private readonly logger;
    private key;
    private readonly algorithm;
    onModuleInit(): void;
    encrypt(plaintext: string | null | undefined): string | null;
    decrypt(ciphertext: string | null | undefined): string | null;
    mask(value: string | null | undefined, visibleStart?: number, visibleEnd?: number): string;
    maskPhone(phone: string | null | undefined): string;
    hash(value: string): string;
}
