"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealtimeGateway = void 0;
const websockets_1 = require("@nestjs/websockets");
const socket_io_1 = require("socket.io");
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
let RealtimeGateway = class RealtimeGateway {
    constructor(jwt) {
        this.jwt = jwt;
        this.logger = new common_1.Logger('Realtime');
        this.userSockets = new Map();
    }
    async handleConnection(client) {
        try {
            const token = client.handshake.auth?.token ||
                client.handshake.headers.authorization?.replace(/^Bearer\s+/i, '');
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
            if (!this.userSockets.has(userId))
                this.userSockets.set(userId, new Set());
            this.userSockets.get(userId).add(client.id);
            client.join(`user:${userId}`);
            client.join(`tenant:${tenantId}`);
            this.logger.log(`✅ Ulandi: user=${userId} socket=${client.id}`);
            client.emit('connected', { userId, tenantId });
        }
        catch (e) {
            this.logger.warn(`Auth xatosi: ${e.message}`);
            client.emit('error', { message: 'Invalid token' });
            client.disconnect();
        }
    }
    handleDisconnect(client) {
        const userId = client.data.userId;
        if (userId && this.userSockets.has(userId)) {
            this.userSockets.get(userId).delete(client.id);
            if (this.userSockets.get(userId).size === 0) {
                this.userSockets.delete(userId);
            }
        }
        this.logger.log(`❌ Uzildi: socket=${client.id}`);
    }
    onTyping(data, client) {
        if (!data?.conversationId)
            return;
        this.server.to(`tenant:${client.data.tenantId}`).emit('user:typing', {
            conversationId: data.conversationId,
            userId: client.data.userId,
            isTyping: !!data.isTyping,
        });
    }
    onJoin(data, client) {
        if (!data?.conversationId)
            return;
        client.join(`conv:${data.conversationId}`);
    }
    onLeave(data, client) {
        if (!data?.conversationId)
            return;
        client.leave(`conv:${data.conversationId}`);
    }
    emitToUser(userId, event, data) {
        this.server.to(`user:${userId}`).emit(event, data);
    }
    emitToTenant(tenantId, event, data) {
        this.server.to(`tenant:${tenantId}`).emit(event, data);
    }
    emitToConversation(conversationId, event, data) {
        this.server.to(`conv:${conversationId}`).emit(event, data);
    }
    isUserOnline(userId) {
        return this.userSockets.has(userId) && this.userSockets.get(userId).size > 0;
    }
    getOnlineUsers() {
        return Array.from(this.userSockets.keys());
    }
};
exports.RealtimeGateway = RealtimeGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", socket_io_1.Server)
], RealtimeGateway.prototype, "server", void 0);
__decorate([
    (0, websockets_1.SubscribeMessage)('typing'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RealtimeGateway.prototype, "onTyping", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('conversation:join'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RealtimeGateway.prototype, "onJoin", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('conversation:leave'),
    __param(0, (0, websockets_1.MessageBody)()),
    __param(1, (0, websockets_1.ConnectedSocket)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, socket_io_1.Socket]),
    __metadata("design:returntype", void 0)
], RealtimeGateway.prototype, "onLeave", null);
exports.RealtimeGateway = RealtimeGateway = __decorate([
    (0, websockets_1.WebSocketGateway)({
        cors: { origin: '*', credentials: false },
        transports: ['websocket', 'polling'],
    }),
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [jwt_1.JwtService])
], RealtimeGateway);
//# sourceMappingURL=realtime.gateway.js.map