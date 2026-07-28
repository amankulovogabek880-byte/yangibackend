// Auto-generated prisma types for TypeScript compatibility
// This file provides type definitions when prisma generate is not available

export const Role = {
  PLATFORM_OWNER: 'PLATFORM_OWNER' as const,
  TENANT_ADMIN: 'TENANT_ADMIN' as const,
  MANAGER: 'MANAGER' as const,
  AGENT: 'AGENT' as const,
  ACCOUNTANT: 'ACCOUNTANT' as const,
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const UserStatus = {
  ACTIVE: 'ACTIVE' as const,
  INACTIVE: 'INACTIVE' as const,
  LOCKED: 'LOCKED' as const,
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const TenantStatus = {
  ACTIVE: 'ACTIVE' as const,
  TRIAL: 'TRIAL' as const,
  SUSPENDED: 'SUSPENDED' as const,
} as const;
export type TenantStatus = (typeof TenantStatus)[keyof typeof TenantStatus];

export const SubscriptionPlan = {
  FREE: 'FREE' as const,
  STARTER: 'STARTER' as const,
  PROFESSIONAL: 'PROFESSIONAL' as const,
  ENTERPRISE: 'ENTERPRISE' as const,
} as const;
export type SubscriptionPlan = (typeof SubscriptionPlan)[keyof typeof SubscriptionPlan];

export const ClientStatus = {
  ACTIVE: 'ACTIVE' as const,
  INACTIVE: 'INACTIVE' as const,
  BLACKLISTED: 'BLACKLISTED' as const,
} as const;
export type ClientStatus = (typeof ClientStatus)[keyof typeof ClientStatus];

export const ClientTier = {
  REGULAR: 'REGULAR' as const,
  SILVER: 'SILVER' as const,
  GOLD: 'GOLD' as const,
  VIP: 'VIP' as const,
} as const;
export type ClientTier = (typeof ClientTier)[keyof typeof ClientTier];

export const LeadSource = {
  TELEGRAM: 'TELEGRAM' as const,
  INSTAGRAM: 'INSTAGRAM' as const,
  WHATSAPP: 'WHATSAPP' as const,
  REFERRAL: 'REFERRAL' as const,
  WALKIN: 'WALKIN' as const,
  WEBSITE: 'WEBSITE' as const,
  CALL: 'CALL' as const,
  FACEBOOK: 'FACEBOOK' as const,
  GOOGLE_ADS: 'GOOGLE_ADS' as const,
  OTHER: 'OTHER' as const,
} as const;
export type LeadSource = (typeof LeadSource)[keyof typeof LeadSource];

export const Language = {
  UZ: 'UZ' as const,
  RU: 'RU' as const,
  EN: 'EN' as const,
} as const;
export type Language = (typeof Language)[keyof typeof Language];

export const PhoneProvider = {
  STUB: 'STUB' as const,
  TEL_LINK: 'TEL_LINK' as const,
  TWILIO: 'TWILIO' as const,
  ONLINEPBX: 'ONLINEPBX' as const,
  MYATI: 'MYATI' as const,
  CUSTOM_SIP: 'CUSTOM_SIP' as const,
  MOIZVONKI: 'MOIZVONKI' as const,
} as const;
export type PhoneProvider = (typeof PhoneProvider)[keyof typeof PhoneProvider];

export const LeadAssignmentStrategy = {
  MANUAL: 'MANUAL' as const,
  ROUND_ROBIN: 'ROUND_ROBIN' as const,
  LEAST_BUSY: 'LEAST_BUSY' as const,
} as const;
export type LeadAssignmentStrategy = (typeof LeadAssignmentStrategy)[keyof typeof LeadAssignmentStrategy];

export const Currency = {
  USD: 'USD' as const,
  UZS: 'UZS' as const,
  EUR: 'EUR' as const,
  RUB: 'RUB' as const,
} as const;
export type Currency = (typeof Currency)[keyof typeof Currency];

export const PipelineStage = {
  NEW_LEAD: 'NEW_LEAD' as const,
  CONTACTED: 'CONTACTED' as const,
  INTERESTED: 'INTERESTED' as const,
  OFFER_SENT: 'OFFER_SENT' as const,
  NEGOTIATION: 'NEGOTIATION' as const,
  DEPOSIT_PAID: 'DEPOSIT_PAID' as const,
  CONFIRMED: 'CONFIRMED' as const,
  TRAVELING: 'TRAVELING' as const,
  COMPLETED: 'COMPLETED' as const,
  LOST: 'LOST' as const,
} as const;
export type PipelineStage = (typeof PipelineStage)[keyof typeof PipelineStage];

export const LostReason = {
  PRICE: 'PRICE' as const,
  TIMING: 'TIMING' as const,
  COMPETITOR: 'COMPETITOR' as const,
  NOT_INTERESTED: 'NOT_INTERESTED' as const,
  NO_RESPONSE: 'NO_RESPONSE' as const,
  OTHER: 'OTHER' as const,
} as const;
export type LostReason = (typeof LostReason)[keyof typeof LostReason];

export const BookingStatus = {
  DRAFT: 'DRAFT' as const,
  CONFIRMED: 'CONFIRMED' as const,
  IN_PROGRESS: 'IN_PROGRESS' as const,
  COMPLETED: 'COMPLETED' as const,
  CANCELLED: 'CANCELLED' as const,
} as const;
export type BookingStatus = (typeof BookingStatus)[keyof typeof BookingStatus];

export const TourType = {
  PACKAGE: 'PACKAGE' as const,
  INDIVIDUAL: 'INDIVIDUAL' as const,
  GROUP: 'GROUP' as const,
  VISA_SUPPORT: 'VISA_SUPPORT' as const,
  HOTEL_ONLY: 'HOTEL_ONLY' as const,
  FLIGHT_ONLY: 'FLIGHT_ONLY' as const,
  CRUISE: 'CRUISE' as const,
} as const;
export type TourType = (typeof TourType)[keyof typeof TourType];

export const PaymentMethod = {
  CASH: 'CASH' as const,
  BANK_TRANSFER: 'BANK_TRANSFER' as const,
  CARD: 'CARD' as const,
  PAYME: 'PAYME' as const,
  CLICK: 'CLICK' as const,
  UZUM: 'UZUM' as const,
  CRYPTO: 'CRYPTO' as const,
  OTHER: 'OTHER' as const,
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PaymentStatus = {
  PENDING: 'PENDING' as const,
  COMPLETED: 'COMPLETED' as const,
  FAILED: 'FAILED' as const,
  REFUNDED: 'REFUNDED' as const,
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const MessageDirection = {
  INBOUND: 'INBOUND' as const,
  OUTBOUND: 'OUTBOUND' as const,
} as const;
export type MessageDirection = (typeof MessageDirection)[keyof typeof MessageDirection];

export const MessageType = {
  TEXT: 'TEXT' as const,
  PHOTO: 'PHOTO' as const,
  DOCUMENT: 'DOCUMENT' as const,
  VOICE: 'VOICE' as const,
  VIDEO: 'VIDEO' as const,
  STICKER: 'STICKER' as const,
  LOCATION: 'LOCATION' as const,
  CONTACT: 'CONTACT' as const,
  FORWARD: 'FORWARD' as const,
  SYSTEM: 'SYSTEM' as const,
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const Channel = {
  TELEGRAM: 'TELEGRAM' as const,
  WHATSAPP: 'WHATSAPP' as const,
  INSTAGRAM: 'INSTAGRAM' as const,
  EMAIL: 'EMAIL' as const,
  WEB: 'WEB' as const,
  PHONE: 'PHONE' as const,
  MANUAL: 'MANUAL' as const,
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

export const CallDirection = {
  INBOUND: 'INBOUND' as const,
  OUTBOUND: 'OUTBOUND' as const,
} as const;
export type CallDirection = (typeof CallDirection)[keyof typeof CallDirection];

export const CallStatus = {
  QUEUED: 'QUEUED' as const,
  INITIATED: 'INITIATED' as const,
  RINGING: 'RINGING' as const,
  ANSWERED: 'ANSWERED' as const,
  IN_PROGRESS: 'IN_PROGRESS' as const,
  COMPLETED: 'COMPLETED' as const,
  FAILED: 'FAILED' as const,
  NO_ANSWER: 'NO_ANSWER' as const,
  BUSY: 'BUSY' as const,
  MISSED: 'MISSED' as const,
  CANCELED: 'CANCELED' as const,
} as const;
export type CallStatus = (typeof CallStatus)[keyof typeof CallStatus];

export const TaskPriority = {
  LOW: 'LOW' as const,
  MEDIUM: 'MEDIUM' as const,
  HIGH: 'HIGH' as const,
  URGENT: 'URGENT' as const,
} as const;
export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

export const TaskStatus = {
  TODO: 'TODO' as const,
  IN_PROGRESS: 'IN_PROGRESS' as const,
  DONE: 'DONE' as const,
  CANCELLED: 'CANCELLED' as const,
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const NotificationType = {
  LEAD_ASSIGNED: 'LEAD_ASSIGNED' as const,
  LEAD_NEW: 'LEAD_NEW' as const,
  NEW_MESSAGE: 'NEW_MESSAGE' as const,
  TASK_DUE: 'TASK_DUE' as const,
  TASK_ASSIGNED: 'TASK_ASSIGNED' as const,
  FOLLOWUP_DUE: 'FOLLOWUP_DUE' as const,
  BOOKING_CREATED: 'BOOKING_CREATED' as const,
  BOOKING_UPDATED: 'BOOKING_UPDATED' as const,
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED' as const,
  CALL_MISSED: 'CALL_MISSED' as const,
  CALL_INCOMING: 'CALL_INCOMING' as const,
  CALL_COMPLETED: 'CALL_COMPLETED' as const,
  STAGE_CHANGED: 'STAGE_CHANGED' as const,
  MENTION: 'MENTION' as const,
  SYSTEM: 'SYSTEM' as const,
  SECURITY_NEW_LOGIN: 'SECURITY_NEW_LOGIN' as const,
  SECURITY_FAILED_LOGIN: 'SECURITY_FAILED_LOGIN' as const,
  SECURITY_2FA_ENABLED: 'SECURITY_2FA_ENABLED' as const,
  SECURITY_PASSWORD_CHANGED: 'SECURITY_PASSWORD_CHANGED' as const,
  SECURITY_SUSPICIOUS_ACTIVITY: 'SECURITY_SUSPICIOUS_ACTIVITY' as const,
  APPROVAL_REQUESTED: 'APPROVAL_REQUESTED' as const,
  APPROVAL_APPROVED: 'APPROVAL_APPROVED' as const,
  APPROVAL_REJECTED: 'APPROVAL_REJECTED' as const,
  CLIENT_ASSIGNED: 'CLIENT_ASSIGNED' as const,
} as const;
export type NotificationType = (typeof NotificationType)[keyof typeof NotificationType];

export const NotificationChannel = {
  IN_APP: 'IN_APP' as const,
  EMAIL: 'EMAIL' as const,
  TELEGRAM: 'TELEGRAM' as const,
  SMS: 'SMS' as const,
} as const;
export type NotificationChannel = (typeof NotificationChannel)[keyof typeof NotificationChannel];

export const AuditAction = {
  CREATE: 'CREATE' as const,
  READ: 'READ' as const,
  UPDATE: 'UPDATE' as const,
  DELETE: 'DELETE' as const,
  LOGIN: 'LOGIN' as const,
  LOGOUT: 'LOGOUT' as const,
  EXPORT: 'EXPORT' as const,
  IMPORT: 'IMPORT' as const,
  STAGE_CHANGE: 'STAGE_CHANGE' as const,
  ASSIGN: 'ASSIGN' as const,
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export const DocumentCategory = {
  PASSPORT: 'PASSPORT' as const,
  VISA: 'VISA' as const,
  TICKET: 'TICKET' as const,
  CONTRACT: 'CONTRACT' as const,
  INVOICE: 'INVOICE' as const,
  RECEIPT: 'RECEIPT' as const,
  PHOTO: 'PHOTO' as const,
  OTHER: 'OTHER' as const,
} as const;
export type DocumentCategory = (typeof DocumentCategory)[keyof typeof DocumentCategory];

export const KpiPeriod = {
  DAILY: 'DAILY' as const,
  WEEKLY: 'WEEKLY' as const,
  MONTHLY: 'MONTHLY' as const,
  QUARTERLY: 'QUARTERLY' as const,
  YEARLY: 'YEARLY' as const,
} as const;
export type KpiPeriod = (typeof KpiPeriod)[keyof typeof KpiPeriod];

export const KpiMetric = {
  REVENUE: 'REVENUE' as const,
  BOOKINGS: 'BOOKINGS' as const,
  NEW_CLIENTS: 'NEW_CLIENTS' as const,
  CONVERSIONS: 'CONVERSIONS' as const,
  CALLS: 'CALLS' as const,
  MESSAGES: 'MESSAGES' as const,
  TASKS_COMPLETED: 'TASKS_COMPLETED' as const,
} as const;
export type KpiMetric = (typeof KpiMetric)[keyof typeof KpiMetric];

export const AutomationTrigger = {
  LEAD_CREATED: 'LEAD_CREATED' as const,
  STAGE_CHANGED: 'STAGE_CHANGED' as const,
  BOOKING_CREATED: 'BOOKING_CREATED' as const,
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED' as const,
  NO_RESPONSE_24H: 'NO_RESPONSE_24H' as const,
  NO_RESPONSE_7D: 'NO_RESPONSE_7D' as const,
  TAG_ADDED: 'TAG_ADDED' as const,
  CALL_MISSED: 'CALL_MISSED' as const,
} as const;
export type AutomationTrigger = (typeof AutomationTrigger)[keyof typeof AutomationTrigger];

export const AutomationAction = {
  ASSIGN_AGENT: 'ASSIGN_AGENT' as const,
  SEND_NOTIFICATION: 'SEND_NOTIFICATION' as const,
  CREATE_TASK: 'CREATE_TASK' as const,
  CREATE_FOLLOWUP: 'CREATE_FOLLOWUP' as const,
  SEND_TELEGRAM_MESSAGE: 'SEND_TELEGRAM_MESSAGE' as const,
  ADD_TAG: 'ADD_TAG' as const,
  CHANGE_STAGE: 'CHANGE_STAGE' as const,
  SET_PRIORITY: 'SET_PRIORITY' as const,
} as const;
export type AutomationAction = (typeof AutomationAction)[keyof typeof AutomationAction];

export const InvoiceStatus = {
  DRAFT: 'DRAFT' as const,
  ISSUED: 'ISSUED' as const,
  SENT: 'SENT' as const,
  PARTIALLY_PAID: 'PARTIALLY_PAID' as const,
  PAID: 'PAID' as const,
  OVERDUE: 'OVERDUE' as const,
  CANCELLED: 'CANCELLED' as const,
  REFUNDED: 'REFUNDED' as const,
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const EmailStatus = {
  QUEUED: 'QUEUED' as const,
  SENT: 'SENT' as const,
  FAILED: 'FAILED' as const,
  BOUNCED: 'BOUNCED' as const,
  DELIVERED: 'DELIVERED' as const,
  OPENED: 'OPENED' as const,
} as const;
export type EmailStatus = (typeof EmailStatus)[keyof typeof EmailStatus];

export const PassengerType = {
  ADULT: 'ADULT' as const,
  CHILD: 'CHILD' as const,
  INFANT: 'INFANT' as const,
  SENIOR: 'SENIOR' as const,
} as const;
export type PassengerType = (typeof PassengerType)[keyof typeof PassengerType];

export const ApprovalType = {
  DISCOUNT: 'DISCOUNT' as const,
  REFUND: 'REFUND' as const,
  PRICE_CHANGE: 'PRICE_CHANGE' as const,
  BOOKING_CANCEL: 'BOOKING_CANCEL' as const,
  PAYMENT_DELETE: 'PAYMENT_DELETE' as const,
  COMMISSION_OVERRIDE: 'COMMISSION_OVERRIDE' as const,
  OTHER: 'OTHER' as const,
} as const;
export type ApprovalType = (typeof ApprovalType)[keyof typeof ApprovalType];

export const ApprovalStatus = {
  PENDING: 'PENDING' as const,
  APPROVED: 'APPROVED' as const,
  REJECTED: 'REJECTED' as const,
  CANCELLED: 'CANCELLED' as const,
} as const;
export type ApprovalStatus = (typeof ApprovalStatus)[keyof typeof ApprovalStatus];

export const ServiceType = {
  TAXI: 'TAXI' as const,
  TRANSFER: 'TRANSFER' as const,
  INSURANCE: 'INSURANCE' as const,
  VISA: 'VISA' as const,
  SIM_CARD: 'SIM_CARD' as const,
  VIP_MEET: 'VIP_MEET' as const,
  GUIDE: 'GUIDE' as const,
  HOTEL_UPGRADE: 'HOTEL_UPGRADE' as const,
  TOUR_GUIDE: 'TOUR_GUIDE' as const,
  EXCURSION: 'EXCURSION' as const,
  RESTAURANT: 'RESTAURANT' as const,
  OTHER: 'OTHER' as const,
} as const;
export type ServiceType = (typeof ServiceType)[keyof typeof ServiceType];

export const ServiceStatus = {
  PENDING: 'PENDING' as const,
  CONFIRMED: 'CONFIRMED' as const,
  COMPLETED: 'COMPLETED' as const,
  CANCELLED: 'CANCELLED' as const,
} as const;
export type ServiceStatus = (typeof ServiceStatus)[keyof typeof ServiceStatus];

export namespace Prisma {
  export type TenantWhereInput = any;
  export type TenantWhereUniqueInput = any;
  export type TenantCreateInput = any;
  export type TenantUpdateInput = any;
  export type TenantOrderByWithRelationInput = any;
  export type UserWhereInput = any;
  export type UserWhereUniqueInput = any;
  export type UserCreateInput = any;
  export type UserUpdateInput = any;
  export type UserOrderByWithRelationInput = any;
  export type UserSessionWhereInput = any;
  export type UserSessionWhereUniqueInput = any;
  export type UserSessionCreateInput = any;
  export type UserSessionUpdateInput = any;
  export type UserSessionOrderByWithRelationInput = any;
  export type LoginAttemptWhereInput = any;
  export type LoginAttemptWhereUniqueInput = any;
  export type LoginAttemptCreateInput = any;
  export type LoginAttemptUpdateInput = any;
  export type LoginAttemptOrderByWithRelationInput = any;
  export type ClientWhereInput = any;
  export type ClientWhereUniqueInput = any;
  export type ClientCreateInput = any;
  export type ClientUpdateInput = any;
  export type ClientOrderByWithRelationInput = any;
  export type ClientTimelineWhereInput = any;
  export type ClientTimelineWhereUniqueInput = any;
  export type ClientTimelineCreateInput = any;
  export type ClientTimelineUpdateInput = any;
  export type ClientTimelineOrderByWithRelationInput = any;
  export type StageHistoryWhereInput = any;
  export type StageHistoryWhereUniqueInput = any;
  export type StageHistoryCreateInput = any;
  export type StageHistoryUpdateInput = any;
  export type StageHistoryOrderByWithRelationInput = any;
  export type PipelineWhereInput = any;
  export type PipelineWhereUniqueInput = any;
  export type PipelineCreateInput = any;
  export type PipelineUpdateInput = any;
  export type PipelineOrderByWithRelationInput = any;
  export type CustomStageWhereInput = any;
  export type CustomStageWhereUniqueInput = any;
  export type CustomStageCreateInput = any;
  export type CustomStageUpdateInput = any;
  export type CustomStageOrderByWithRelationInput = any;
  export type BookingWhereInput = any;
  export type BookingWhereUniqueInput = any;
  export type BookingCreateInput = any;
  export type BookingUpdateInput = any;
  export type BookingOrderByWithRelationInput = any;
  export type InvoiceWhereInput = any;
  export type InvoiceWhereUniqueInput = any;
  export type InvoiceCreateInput = any;
  export type InvoiceUpdateInput = any;
  export type InvoiceOrderByWithRelationInput = any;
  export type PaymentWhereInput = any;
  export type PaymentWhereUniqueInput = any;
  export type PaymentCreateInput = any;
  export type PaymentUpdateInput = any;
  export type PaymentOrderByWithRelationInput = any;
  export type TelegramAccountWhereInput = any;
  export type TelegramAccountWhereUniqueInput = any;
  export type TelegramAccountCreateInput = any;
  export type TelegramAccountUpdateInput = any;
  export type TelegramAccountOrderByWithRelationInput = any;
  export type ConversationWhereInput = any;
  export type ConversationWhereUniqueInput = any;
  export type ConversationCreateInput = any;
  export type ConversationUpdateInput = any;
  export type ConversationOrderByWithRelationInput = any;
  export type MessageWhereInput = any;
  export type MessageWhereUniqueInput = any;
  export type MessageCreateInput = any;
  export type MessageUpdateInput = any;
  export type MessageOrderByWithRelationInput = any;
  export type MessageTemplateWhereInput = any;
  export type MessageTemplateWhereUniqueInput = any;
  export type MessageTemplateCreateInput = any;
  export type MessageTemplateUpdateInput = any;
  export type MessageTemplateOrderByWithRelationInput = any;
  export type CallWhereInput = any;
  export type CallWhereUniqueInput = any;
  export type CallCreateInput = any;
  export type CallUpdateInput = any;
  export type CallOrderByWithRelationInput = any;
  export type TaskWhereInput = any;
  export type TaskWhereUniqueInput = any;
  export type TaskCreateInput = any;
  export type TaskUpdateInput = any;
  export type TaskOrderByWithRelationInput = any;
  export type FollowUpWhereInput = any;
  export type FollowUpWhereUniqueInput = any;
  export type FollowUpCreateInput = any;
  export type FollowUpUpdateInput = any;
  export type FollowUpOrderByWithRelationInput = any;
  export type DocumentWhereInput = any;
  export type DocumentWhereUniqueInput = any;
  export type DocumentCreateInput = any;
  export type DocumentUpdateInput = any;
  export type DocumentOrderByWithRelationInput = any;
  export type NotificationWhereInput = any;
  export type NotificationWhereUniqueInput = any;
  export type NotificationCreateInput = any;
  export type NotificationUpdateInput = any;
  export type NotificationOrderByWithRelationInput = any;
  export type EmailLogWhereInput = any;
  export type EmailLogWhereUniqueInput = any;
  export type EmailLogCreateInput = any;
  export type EmailLogUpdateInput = any;
  export type EmailLogOrderByWithRelationInput = any;
  export type ApiKeyWhereInput = any;
  export type ApiKeyWhereUniqueInput = any;
  export type ApiKeyCreateInput = any;
  export type ApiKeyUpdateInput = any;
  export type ApiKeyOrderByWithRelationInput = any;
  export type AutomationWhereInput = any;
  export type AutomationWhereUniqueInput = any;
  export type AutomationCreateInput = any;
  export type AutomationUpdateInput = any;
  export type AutomationOrderByWithRelationInput = any;
  export type AutoReplyRuleWhereInput = any;
  export type AutoReplyRuleWhereUniqueInput = any;
  export type AutoReplyRuleCreateInput = any;
  export type AutoReplyRuleUpdateInput = any;
  export type AutoReplyRuleOrderByWithRelationInput = any;
  export type LeadFormWhereInput = any;
  export type LeadFormWhereUniqueInput = any;
  export type LeadFormCreateInput = any;
  export type LeadFormUpdateInput = any;
  export type LeadFormOrderByWithRelationInput = any;
  export type LeadFormSubmissionWhereInput = any;
  export type LeadFormSubmissionWhereUniqueInput = any;
  export type LeadFormSubmissionCreateInput = any;
  export type LeadFormSubmissionUpdateInput = any;
  export type LeadFormSubmissionOrderByWithRelationInput = any;
  export type KpiWhereInput = any;
  export type KpiWhereUniqueInput = any;
  export type KpiCreateInput = any;
  export type KpiUpdateInput = any;
  export type KpiOrderByWithRelationInput = any;
  export type TagWhereInput = any;
  export type TagWhereUniqueInput = any;
  export type TagCreateInput = any;
  export type TagUpdateInput = any;
  export type TagOrderByWithRelationInput = any;
  export type AuditLogWhereInput = any;
  export type AuditLogWhereUniqueInput = any;
  export type AuditLogCreateInput = any;
  export type AuditLogUpdateInput = any;
  export type AuditLogOrderByWithRelationInput = any;
  export type BookingChecklistWhereInput = any;
  export type BookingChecklistWhereUniqueInput = any;
  export type BookingChecklistCreateInput = any;
  export type BookingChecklistUpdateInput = any;
  export type BookingChecklistOrderByWithRelationInput = any;
  export type SavedFilterWhereInput = any;
  export type SavedFilterWhereUniqueInput = any;
  export type SavedFilterCreateInput = any;
  export type SavedFilterUpdateInput = any;
  export type SavedFilterOrderByWithRelationInput = any;
  export type CommissionWhereInput = any;
  export type CommissionWhereUniqueInput = any;
  export type CommissionCreateInput = any;
  export type CommissionUpdateInput = any;
  export type CommissionOrderByWithRelationInput = any;
  export type PassengerWhereInput = any;
  export type PassengerWhereUniqueInput = any;
  export type PassengerCreateInput = any;
  export type PassengerUpdateInput = any;
  export type PassengerOrderByWithRelationInput = any;
  export type ApprovalRequestWhereInput = any;
  export type ApprovalRequestWhereUniqueInput = any;
  export type ApprovalRequestCreateInput = any;
  export type ApprovalRequestUpdateInput = any;
  export type ApprovalRequestOrderByWithRelationInput = any;
  export type BookingServiceWhereInput = any;
  export type BookingServiceWhereUniqueInput = any;
  export type BookingServiceCreateInput = any;
  export type BookingServiceUpdateInput = any;
  export type BookingServiceOrderByWithRelationInput = any;
  export type WebhookLogWhereInput = any;
  export type WebhookLogWhereUniqueInput = any;
  export type WebhookLogCreateInput = any;
  export type WebhookLogUpdateInput = any;
  export type WebhookLogOrderByWithRelationInput = any;
  export type InputJsonValue = any;
  export type JsonValue = any;
  export type SortOrder = 'asc' | 'desc';
  export class PrismaClientKnownRequestError extends Error {
    code: string; meta?: any; clientVersion: string;
    constructor(message: string, { code, clientVersion, meta }: any) {
      super(message); this.code = code; this.clientVersion = clientVersion; this.meta = meta;
    }
  }
  export class PrismaClientValidationError extends Error {}
}