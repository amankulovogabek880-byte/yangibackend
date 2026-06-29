import { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
export declare class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
    private jwt;
    server: Server;
    private readonly logger;
    private userSockets;
    constructor(jwt: JwtService);
    handleConnection(client: Socket): Promise<void>;
    handleDisconnect(client: Socket): void;
    onTyping(data: {
        conversationId: string;
        isTyping: boolean;
    }, client: Socket): void;
    onJoin(data: {
        conversationId: string;
    }, client: Socket): void;
    onLeave(data: {
        conversationId: string;
    }, client: Socket): void;
    emitToUser(userId: string, event: string, data: any): void;
    emitToTenant(tenantId: string, event: string, data: any): void;
    emitToConversation(conversationId: string, event: string, data: any): void;
    isUserOnline(userId: string): boolean;
    getOnlineUsers(): string[];
}
