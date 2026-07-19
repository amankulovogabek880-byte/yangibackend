import {
  WebSocketGateway, WebSocketServer, OnGatewayInit,
  OnGatewayConnection, OnGatewayDisconnect,
  SubscribeMessage, MessageBody, ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { isOriginAllowed } from '../../common/config/cors.config';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { REDIS_CLIENT } from '../../common/cache/cache.constants';
import { JwtService } from '@nestjs/jwt';

/**
 * XAVFSIZLIK (v12.5): ilgari bu yerda `origin: '*'` turardi — ya'ni
 * istalgan sayt CRM'ning WebSocket kanaliga ulana olardi, HTTP CORS
 * qat'iy yopiq bo'lsa ham. Endi ikkalasi ham bitta ro'yxatdan
 * (CORS_ORIGINS env) foydalanadi.
 */
@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, cb: (err: Error | null, ok?: boolean) => void) => {
      if (isOriginAllowed(origin)) return cb(null, true);
      cb(new Error(`WebSocket CORS: ${origin} ga ruxsat yo'q`));
    },
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
@Injectable()
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('Realtime');

  // userId → Set<socketId>
  private userSockets = new Map<string, Set<string>>();

  constructor(
    private jwt: JwtService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  /**
   * ═══════════════════════════════════════════════════════════
   * REDIS ADAPTER — bir nechta instansda ishlash uchun (v12.5)
   * ═══════════════════════════════════════════════════════════
   *
   * MUAMMO: ulanishlar `userSockets` Map'ida, ya'ni O'SHA jarayonning
   * xotirasida saqlanadi. Bitta server bo'lsa muammo yo'q. Lekin
   * ikkita instans ishlab tursa:
   *
   *   Agent A → instans-1 ga ulangan
   *   Yangi lead → instans-2 da yaratildi
   *   instans-2 `emitToUser(A)` chaqiradi → o'z xotirasida A yo'q
   *   → xabar YETIB BORMAYDI (jimgina yo'qoladi)
   *
   * Redis adapter barcha instanslarni bitta pub/sub kanali orqali
   * bog'laydi — emit qaysi instansdan chiqsa ham hammaga yetadi.
   *
   * REDIS_URL yo'q bo'lsa: adapter ulanmaydi, tizim eski holatda
   * (in-memory) ishlashda davom etadi. Bu bitta instans uchun
   * mutlaqo to'g'ri — shuning uchun majburiy qilmaymiz.
   */
  async afterInit(server: Server) {
    if (!this.redis) {
      this.logger.warn(
        "REDIS_URL yo'q — WebSocket in-memory rejimda. " +
        "Bu BITTA instans uchun normal, lekin 2+ instans bo'lsa " +
        "xabarlar instanslar orasida yetib bormaydi.",
      );
      return;
    }

    try {
      // Adapter IKKITA alohida ulanish talab qiladi: biri e'lon qilish,
      // ikkinchisi tinglash uchun (subscriber rejimidagi ulanishda
      // boshqa buyruq bajarib bo'lmaydi).
      // DIQQAT: asosiy mijoz CACHE uchun sozlangan —
      // `enableOfflineQueue: false` va `maxRetriesPerRequest: 1`.
      // Bu cache uchun to'g'ri (so'rov osilib qolmasin), lekin pub/sub
      // uchun NOTO'G'RI: adapter ulanish tiklanayotganda buyruq yuborsa
      // "Stream isn't writeable" xatosi chiqadi va jarayon yiqiladi.
      //
      // Shuning uchun dublikatlarda bu sozlamalarni ATAYLAB bekor qilamiz:
      // pub/sub ulanishi doimiy bo'lishi va buyruqlarni navbatga qo'yishi kerak.
      const pubSubOptions = {
        enableOfflineQueue: true,
        maxRetriesPerRequest: null as any,
      };
      const pubClient = this.redis.duplicate(pubSubOptions);
      const subClient = this.redis.duplicate(pubSubOptions);

      pubClient.on('error', (e) =>
        this.logger.error(`Redis pub xatosi: ${e?.message}`));
      subClient.on('error', (e) =>
        this.logger.error(`Redis sub xatosi: ${e?.message}`));

      server.adapter(createAdapter(pubClient, subClient));
      this.logger.log('WebSocket Redis adapter ulandi ✓ (ko\'p instans qo\'llab-quvvatlanadi)');
    } catch (e: any) {
      // Adapter ulanmasa ham WebSocket ishlashda davom etsin —
      // faqat ko'p instansli rejim ishlamaydi.
      this.logger.error(
        `WebSocket Redis adapter ulanmadi: ${e?.message}. ` +
        'In-memory rejimda davom etilmoqda.',
      );
    }
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        (client.handshake.headers.authorization as string)?.replace(/^Bearer\s+/i, '');
      if (!token) {
        client.emit('error', { message: 'No token' });
        client.disconnect();
        return;
      }
      const payload = await this.jwt.verifyAsync(token, {
        secret: process.env.JWT_ACCESS_SECRET,
      });
      const userId = payload.sub;
      const tenantId = payload.tenantId;

      client.data.userId = userId;
      client.data.tenantId = tenantId;
      client.data.role = payload.role;

      // Track socket
      if (!this.userSockets.has(userId)) this.userSockets.set(userId, new Set());
      this.userSockets.get(userId)!.add(client.id);

      // Join rooms
      client.join(`user:${userId}`);
      client.join(`tenant:${tenantId}`);
      // v10 MUAMMO 4 FIX: rolga asoslangan xona — shu orqali "faqat
      // TENANT_ADMIN/MANAGER'larga" yoki "faqat AGENT'larga" yuborish mumkin
      // bo'ladi, butun tenant emas.
      if (payload.role) {
        client.join(`role:${tenantId}:${payload.role}`);
      }

      this.logger.log(`✅ Ulandi: user=${userId} socket=${client.id}`);
      client.emit('connected', { userId, tenantId });
    } catch (e: any) {
      this.logger.warn(`Auth xatosi: ${e.message}`);
      client.emit('error', { message: 'Invalid token' });
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.userId;
    if (userId && this.userSockets.has(userId)) {
      this.userSockets.get(userId)!.delete(client.id);
      if (this.userSockets.get(userId)!.size === 0) {
        this.userSockets.delete(userId);
      }
    }
    this.logger.log(`❌ Uzildi: socket=${client.id}`);
  }

  // ─── EVENTS ───────────────────────────────────────────────

  /** Userni typing status */
  @SubscribeMessage('typing')
  onTyping(@MessageBody() data: { conversationId: string; isTyping: boolean }, @ConnectedSocket() client: Socket) {
    if (!data?.conversationId) return;
    this.server.to(`tenant:${client.data.tenantId}`).emit('user:typing', {
      conversationId: data.conversationId,
      userId: client.data.userId,
      isTyping: !!data.isTyping,
    });
  }

  /** Conversation ochish — join room */
  @SubscribeMessage('conversation:join')
  onJoin(@MessageBody() data: { conversationId: string }, @ConnectedSocket() client: Socket) {
    if (!data?.conversationId) return;
    client.join(`conv:${data.conversationId}`);
  }

  @SubscribeMessage('conversation:leave')
  onLeave(@MessageBody() data: { conversationId: string }, @ConnectedSocket() client: Socket) {
    if (!data?.conversationId) return;
    client.leave(`conv:${data.conversationId}`);
  }

  // ─── PUBLIC EMIT METHODS (boshqa servislardan chaqirish) ───

  emitToUser(userId: string, event: string, data: any) {
    this.server.to(`user:${userId}`).emit(event, data);
  }

  /**
   * v10 MUAMMO 4 FIX: avval BARCHA tenant xabarlari `emitToTenant` orqali
   * butun tenant xonasiga (har qanday autentifikatsiyalangan foydalanuvchi
   * a'zo bo'lgan `tenant:${tenantId}`) yuborilardi — ya'ni istalgan agent
   * boshqa agentning shaxsiy suhbatidagi xabarlarni ham real-vaqtda ko'rib
   * turardi. Bu xavfsizlik/maxfiylik muammosi edi.
   *
   * `emitToTenant` umumiy tenant-darajasidagi hodisalar uchun (masalan
   * sozlamalar o'zgarishi) qoldirilgan — lekin SUHBAT/XABAR hodisalari uchun
   * quyidagi ikkita metoddan foydalaniladi.
   */
  emitToTenant(tenantId: string, event: string, data: any) {
    this.server.to(`tenant:${tenantId}`).emit(event, data);
  }

  /** Faqat berilgan rol(lar)dagi foydalanuvchilarga yuboradi (masalan faqat adminlarga) */
  emitToRole(tenantId: string, roles: string[], event: string, data: any) {
    for (const role of roles) {
      this.server.to(`role:${tenantId}:${role}`).emit(event, data);
    }
  }

  /**
   * v10 MUAMMO 4 FIX: suhbat/xabar hodisasini FAQAT tegishli odamlarga
   * yuboradi:
   *  - Suhbat biriktirilgan bo'lsa (assignedAgentId bor) — o'sha agentga.
   *  - Har doim TENANT_ADMIN va MANAGER'larga (nazorat/eskalatsiya uchun).
   *  - Agar hech kimga biriktirilmagan bo'lsa — "umumiy lead" sifatida
   *    barcha AGENT'larga ham yuboriladi (front-end buni alohida "Umumiy"
   *    belgisi bilan ko'rsatishi kerak — Muammo 5).
   * Barcha telegram/telegram-personal modullaridagi eski
   * `emitToTenant(tenantId, 'message:new'/'conversation:updated', ...)`
   * chaqiruvlari shu metodga almashtirildi.
   */
  emitConversationEvent(tenantId: string, assignedAgentId: string | null | undefined, event: string, data: any) {
    if (assignedAgentId) {
      this.emitToUser(assignedAgentId, event, data);
    } else {
      this.emitToRole(tenantId, ['AGENT'], event, data);
    }
    this.emitToRole(tenantId, ['TENANT_ADMIN', 'MANAGER'], event, data);
  }

  emitToConversation(conversationId: string, event: string, data: any) {
    this.server.to(`conv:${conversationId}`).emit(event, data);
  }

  isUserOnline(userId: string): boolean {
    return this.userSockets.has(userId) && this.userSockets.get(userId)!.size > 0;
  }

  getOnlineUsers(): string[] {
    return Array.from(this.userSockets.keys());
  }
}