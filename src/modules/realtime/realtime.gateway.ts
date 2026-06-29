import {
  WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect,
  SubscribeMessage, MessageBody, ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@WebSocketGateway({
  cors: { origin: '*', credentials: false },
  transports: ['websocket', 'polling'],
})
@Injectable()
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger('Realtime');

  // userId → Set<socketId>
  private userSockets = new Map<string, Set<string>>();

  constructor(private jwt: JwtService) {}

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

  emitToTenant(tenantId: string, event: string, data: any) {
    this.server.to(`tenant:${tenantId}`).emit(event, data);
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
