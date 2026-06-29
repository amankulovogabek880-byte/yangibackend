"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Prisma = exports.ServiceStatus = exports.ServiceType = exports.ApprovalStatus = exports.ApprovalType = exports.PassengerType = exports.EmailStatus = exports.InvoiceStatus = exports.AutomationAction = exports.AutomationTrigger = exports.KpiMetric = exports.KpiPeriod = exports.DocumentCategory = exports.AuditAction = exports.NotificationChannel = exports.NotificationType = exports.TaskStatus = exports.TaskPriority = exports.CallStatus = exports.CallDirection = exports.Channel = exports.MessageType = exports.MessageDirection = exports.PaymentStatus = exports.PaymentMethod = exports.TourType = exports.BookingStatus = exports.LostReason = exports.PipelineStage = exports.Currency = exports.LeadAssignmentStrategy = exports.PhoneProvider = exports.Language = exports.LeadSource = exports.ClientTier = exports.ClientStatus = exports.SubscriptionPlan = exports.TenantStatus = exports.UserStatus = exports.Role = void 0;
exports.Role = {
    PLATFORM_OWNER: 'PLATFORM_OWNER',
    TENANT_ADMIN: 'TENANT_ADMIN',
    MANAGER: 'MANAGER',
    AGENT: 'AGENT',
    ACCOUNTANT: 'ACCOUNTANT',
};
exports.UserStatus = {
    ACTIVE: 'ACTIVE',
    INACTIVE: 'INACTIVE',
    LOCKED: 'LOCKED',
};
exports.TenantStatus = {
    ACTIVE: 'ACTIVE',
    TRIAL: 'TRIAL',
    SUSPENDED: 'SUSPENDED',
};
exports.SubscriptionPlan = {
    FREE: 'FREE',
    STARTER: 'STARTER',
    PROFESSIONAL: 'PROFESSIONAL',
    ENTERPRISE: 'ENTERPRISE',
};
exports.ClientStatus = {
    ACTIVE: 'ACTIVE',
    INACTIVE: 'INACTIVE',
    BLACKLISTED: 'BLACKLISTED',
};
exports.ClientTier = {
    REGULAR: 'REGULAR',
    SILVER: 'SILVER',
    GOLD: 'GOLD',
    VIP: 'VIP',
};
exports.LeadSource = {
    TELEGRAM: 'TELEGRAM',
    INSTAGRAM: 'INSTAGRAM',
    WHATSAPP: 'WHATSAPP',
    REFERRAL: 'REFERRAL',
    WALKIN: 'WALKIN',
    WEBSITE: 'WEBSITE',
    CALL: 'CALL',
    FACEBOOK: 'FACEBOOK',
    GOOGLE_ADS: 'GOOGLE_ADS',
    OTHER: 'OTHER',
};
exports.Language = {
    UZ: 'UZ',
    RU: 'RU',
    EN: 'EN',
};
exports.PhoneProvider = {
    STUB: 'STUB',
    TEL_LINK: 'TEL_LINK',
    TWILIO: 'TWILIO',
    ONLINEPBX: 'ONLINEPBX',
    MYATI: 'MYATI',
    CUSTOM_SIP: 'CUSTOM_SIP',
};
exports.LeadAssignmentStrategy = {
    MANUAL: 'MANUAL',
    ROUND_ROBIN: 'ROUND_ROBIN',
    LEAST_BUSY: 'LEAST_BUSY',
};
exports.Currency = {
    USD: 'USD',
    UZS: 'UZS',
    EUR: 'EUR',
    RUB: 'RUB',
};
exports.PipelineStage = {
    NEW_LEAD: 'NEW_LEAD',
    CONTACTED: 'CONTACTED',
    INTERESTED: 'INTERESTED',
    OFFER_SENT: 'OFFER_SENT',
    NEGOTIATION: 'NEGOTIATION',
    DEPOSIT_PAID: 'DEPOSIT_PAID',
    CONFIRMED: 'CONFIRMED',
    TRAVELING: 'TRAVELING',
    COMPLETED: 'COMPLETED',
    LOST: 'LOST',
};
exports.LostReason = {
    PRICE: 'PRICE',
    TIMING: 'TIMING',
    COMPETITOR: 'COMPETITOR',
    NOT_INTERESTED: 'NOT_INTERESTED',
    NO_RESPONSE: 'NO_RESPONSE',
    OTHER: 'OTHER',
};
exports.BookingStatus = {
    DRAFT: 'DRAFT',
    CONFIRMED: 'CONFIRMED',
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
};
exports.TourType = {
    PACKAGE: 'PACKAGE',
    INDIVIDUAL: 'INDIVIDUAL',
    GROUP: 'GROUP',
    VISA_SUPPORT: 'VISA_SUPPORT',
    HOTEL_ONLY: 'HOTEL_ONLY',
    FLIGHT_ONLY: 'FLIGHT_ONLY',
    CRUISE: 'CRUISE',
};
exports.PaymentMethod = {
    CASH: 'CASH',
    BANK_TRANSFER: 'BANK_TRANSFER',
    CARD: 'CARD',
    PAYME: 'PAYME',
    CLICK: 'CLICK',
    UZUM: 'UZUM',
    CRYPTO: 'CRYPTO',
    OTHER: 'OTHER',
};
exports.PaymentStatus = {
    PENDING: 'PENDING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    REFUNDED: 'REFUNDED',
};
exports.MessageDirection = {
    INBOUND: 'INBOUND',
    OUTBOUND: 'OUTBOUND',
};
exports.MessageType = {
    TEXT: 'TEXT',
    PHOTO: 'PHOTO',
    DOCUMENT: 'DOCUMENT',
    VOICE: 'VOICE',
    VIDEO: 'VIDEO',
    STICKER: 'STICKER',
    LOCATION: 'LOCATION',
    CONTACT: 'CONTACT',
    FORWARD: 'FORWARD',
    SYSTEM: 'SYSTEM',
};
exports.Channel = {
    TELEGRAM: 'TELEGRAM',
    WHATSAPP: 'WHATSAPP',
    INSTAGRAM: 'INSTAGRAM',
    EMAIL: 'EMAIL',
    WEB: 'WEB',
    PHONE: 'PHONE',
    MANUAL: 'MANUAL',
};
exports.CallDirection = {
    INBOUND: 'INBOUND',
    OUTBOUND: 'OUTBOUND',
};
exports.CallStatus = {
    QUEUED: 'QUEUED',
    INITIATED: 'INITIATED',
    RINGING: 'RINGING',
    ANSWERED: 'ANSWERED',
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    NO_ANSWER: 'NO_ANSWER',
    BUSY: 'BUSY',
    MISSED: 'MISSED',
    CANCELED: 'CANCELED',
};
exports.TaskPriority = {
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
    URGENT: 'URGENT',
};
exports.TaskStatus = {
    TODO: 'TODO',
    IN_PROGRESS: 'IN_PROGRESS',
    DONE: 'DONE',
    CANCELLED: 'CANCELLED',
};
exports.NotificationType = {
    LEAD_ASSIGNED: 'LEAD_ASSIGNED',
    LEAD_NEW: 'LEAD_NEW',
    NEW_MESSAGE: 'NEW_MESSAGE',
    TASK_DUE: 'TASK_DUE',
    TASK_ASSIGNED: 'TASK_ASSIGNED',
    FOLLOWUP_DUE: 'FOLLOWUP_DUE',
    BOOKING_CREATED: 'BOOKING_CREATED',
    BOOKING_UPDATED: 'BOOKING_UPDATED',
    PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
    CALL_MISSED: 'CALL_MISSED',
    CALL_INCOMING: 'CALL_INCOMING',
    CALL_COMPLETED: 'CALL_COMPLETED',
    STAGE_CHANGED: 'STAGE_CHANGED',
    MENTION: 'MENTION',
    SYSTEM: 'SYSTEM',
    SECURITY_NEW_LOGIN: 'SECURITY_NEW_LOGIN',
    SECURITY_FAILED_LOGIN: 'SECURITY_FAILED_LOGIN',
    SECURITY_2FA_ENABLED: 'SECURITY_2FA_ENABLED',
    SECURITY_PASSWORD_CHANGED: 'SECURITY_PASSWORD_CHANGED',
    SECURITY_SUSPICIOUS_ACTIVITY: 'SECURITY_SUSPICIOUS_ACTIVITY',
    APPROVAL_REQUESTED: 'APPROVAL_REQUESTED',
    APPROVAL_APPROVED: 'APPROVAL_APPROVED',
    APPROVAL_REJECTED: 'APPROVAL_REJECTED',
    CLIENT_ASSIGNED: 'CLIENT_ASSIGNED',
};
exports.NotificationChannel = {
    IN_APP: 'IN_APP',
    EMAIL: 'EMAIL',
    TELEGRAM: 'TELEGRAM',
    SMS: 'SMS',
};
exports.AuditAction = {
    CREATE: 'CREATE',
    READ: 'READ',
    UPDATE: 'UPDATE',
    DELETE: 'DELETE',
    LOGIN: 'LOGIN',
    LOGOUT: 'LOGOUT',
    EXPORT: 'EXPORT',
    IMPORT: 'IMPORT',
    STAGE_CHANGE: 'STAGE_CHANGE',
    ASSIGN: 'ASSIGN',
};
exports.DocumentCategory = {
    PASSPORT: 'PASSPORT',
    VISA: 'VISA',
    TICKET: 'TICKET',
    CONTRACT: 'CONTRACT',
    INVOICE: 'INVOICE',
    RECEIPT: 'RECEIPT',
    PHOTO: 'PHOTO',
    OTHER: 'OTHER',
};
exports.KpiPeriod = {
    DAILY: 'DAILY',
    WEEKLY: 'WEEKLY',
    MONTHLY: 'MONTHLY',
    QUARTERLY: 'QUARTERLY',
    YEARLY: 'YEARLY',
};
exports.KpiMetric = {
    REVENUE: 'REVENUE',
    BOOKINGS: 'BOOKINGS',
    NEW_CLIENTS: 'NEW_CLIENTS',
    CONVERSIONS: 'CONVERSIONS',
    CALLS: 'CALLS',
    MESSAGES: 'MESSAGES',
    TASKS_COMPLETED: 'TASKS_COMPLETED',
};
exports.AutomationTrigger = {
    LEAD_CREATED: 'LEAD_CREATED',
    STAGE_CHANGED: 'STAGE_CHANGED',
    BOOKING_CREATED: 'BOOKING_CREATED',
    PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
    NO_RESPONSE_24H: 'NO_RESPONSE_24H',
    NO_RESPONSE_7D: 'NO_RESPONSE_7D',
    TAG_ADDED: 'TAG_ADDED',
    CALL_MISSED: 'CALL_MISSED',
};
exports.AutomationAction = {
    ASSIGN_AGENT: 'ASSIGN_AGENT',
    SEND_NOTIFICATION: 'SEND_NOTIFICATION',
    CREATE_TASK: 'CREATE_TASK',
    CREATE_FOLLOWUP: 'CREATE_FOLLOWUP',
    SEND_TELEGRAM_MESSAGE: 'SEND_TELEGRAM_MESSAGE',
    ADD_TAG: 'ADD_TAG',
    CHANGE_STAGE: 'CHANGE_STAGE',
    SET_PRIORITY: 'SET_PRIORITY',
};
exports.InvoiceStatus = {
    DRAFT: 'DRAFT',
    ISSUED: 'ISSUED',
    SENT: 'SENT',
    PARTIALLY_PAID: 'PARTIALLY_PAID',
    PAID: 'PAID',
    OVERDUE: 'OVERDUE',
    CANCELLED: 'CANCELLED',
    REFUNDED: 'REFUNDED',
};
exports.EmailStatus = {
    QUEUED: 'QUEUED',
    SENT: 'SENT',
    FAILED: 'FAILED',
    BOUNCED: 'BOUNCED',
    DELIVERED: 'DELIVERED',
    OPENED: 'OPENED',
};
exports.PassengerType = {
    ADULT: 'ADULT',
    CHILD: 'CHILD',
    INFANT: 'INFANT',
    SENIOR: 'SENIOR',
};
exports.ApprovalType = {
    DISCOUNT: 'DISCOUNT',
    REFUND: 'REFUND',
    PRICE_CHANGE: 'PRICE_CHANGE',
    BOOKING_CANCEL: 'BOOKING_CANCEL',
    PAYMENT_DELETE: 'PAYMENT_DELETE',
    COMMISSION_OVERRIDE: 'COMMISSION_OVERRIDE',
    OTHER: 'OTHER',
};
exports.ApprovalStatus = {
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED',
};
exports.ServiceType = {
    TAXI: 'TAXI',
    TRANSFER: 'TRANSFER',
    INSURANCE: 'INSURANCE',
    VISA: 'VISA',
    SIM_CARD: 'SIM_CARD',
    VIP_MEET: 'VIP_MEET',
    GUIDE: 'GUIDE',
    HOTEL_UPGRADE: 'HOTEL_UPGRADE',
    TOUR_GUIDE: 'TOUR_GUIDE',
    EXCURSION: 'EXCURSION',
    RESTAURANT: 'RESTAURANT',
    OTHER: 'OTHER',
};
exports.ServiceStatus = {
    PENDING: 'PENDING',
    CONFIRMED: 'CONFIRMED',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
};
var Prisma;
(function (Prisma) {
    class PrismaClientKnownRequestError extends Error {
        constructor(message, { code, clientVersion, meta }) {
            super(message);
            this.code = code;
            this.clientVersion = clientVersion;
            this.meta = meta;
        }
    }
    Prisma.PrismaClientKnownRequestError = PrismaClientKnownRequestError;
    class PrismaClientValidationError extends Error {
    }
    Prisma.PrismaClientValidationError = PrismaClientValidationError;
})(Prisma || (exports.Prisma = Prisma = {}));
//# sourceMappingURL=prisma-types.js.map