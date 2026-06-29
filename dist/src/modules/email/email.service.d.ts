import { OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
interface SendEmailParams {
    to: string;
    toName?: string;
    subject: string;
    html: string;
    text?: string;
    tenantId?: string;
    templateId?: string;
    metadata?: Record<string, any>;
}
export declare class EmailService implements OnModuleInit {
    private prisma;
    private readonly logger;
    private enabled;
    private fromEmail;
    private fromName;
    constructor(prisma: PrismaService);
    onModuleInit(): void;
    send(params: SendEmailParams): Promise<{
        ok: boolean;
        error?: string;
    }>;
    private wrap;
    sendLoginAlert(to: string, name: string, params: {
        deviceName?: string;
        ip?: string;
        country?: string;
        city?: string;
        time: Date;
    }): Promise<{
        ok: boolean;
        error?: string;
    }>;
    sendPasswordChanged(to: string, name: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    sendFailedLoginAlert(to: string, name: string, attempts: number): Promise<{
        ok: boolean;
        error?: string;
    }>;
    sendLeadNotification(to: string, name: string, params: {
        leadName: string;
        phone: string;
        source: string;
        campaign?: string;
    }): Promise<{
        ok: boolean;
        error?: string;
    }>;
    sendBookingCreated(to: string, name: string, params: {
        bookingRef: string;
        clientName: string;
        tourName: string;
        totalPrice: number;
    }): Promise<{
        ok: boolean;
        error?: string;
    }>;
    sendPaymentReceived(to: string, name: string, params: {
        amount: number;
        bookingRef: string;
        method: string;
    }): Promise<{
        ok: boolean;
        error?: string;
    }>;
    sendFollowUpDue(to: string, name: string, params: {
        title: string;
        clientName?: string;
        note?: string;
    }): Promise<{
        ok: boolean;
        error?: string;
    }>;
    send2FACode(to: string, name: string, code: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    sendPasswordReset(to: string, name: string, resetUrl: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
}
export {};
