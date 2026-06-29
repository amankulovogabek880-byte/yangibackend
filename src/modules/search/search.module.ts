import {
  Module, Injectable, Controller, Get, Query, UseGuards, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';

@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}

  async global(tenantId: string, userId: string, role: string, q: string) {
    if (!q?.trim() || q.trim().length < 2) {
      throw new BadRequestException("Kamida 2 belgi kiriting");
    }
    const search = q.trim();
    const limit = 8;

    const agentFilter = role === 'AGENT';

    const [clients, bookings, conversations, tasks, invoices, documents] = await Promise.all([
      // Clients
      this.prisma.client.findMany({
        where: {
          tenantId,
          ...(agentFilter ? { assignedAgentId: userId } : {}),
          OR: [
            { fullName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
            { email: { contains: search, mode: 'insensitive' } },
            { passportNo: { contains: search } },
            { telegramUsername: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true, fullName: true, phone: true, email: true,
          tier: true, pipelineStage: true,
        },
        take: limit,
      }),
      // Bookings
      this.prisma.booking.findMany({
        where: {
          tenantId,
          ...(agentFilter ? { agentId: userId } : {}),
          OR: [
            { bookingRef: { contains: search, mode: 'insensitive' } },
            { tourName: { contains: search, mode: 'insensitive' } },
            { destination: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true, bookingRef: true, tourName: true, destination: true,
          totalPrice: true, status: true,
          client: { select: { id: true, fullName: true } },
        },
        take: limit,
      }),
      // Conversations
      this.prisma.conversation.findMany({
        where: {
          tenantId,
          ...(agentFilter ? { OR: [{ assignedAgentId: userId }, { assignedAgentId: null }] } : {}),
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { username: { contains: search, mode: 'insensitive' } },
            { lastMessageText: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true, firstName: true, lastName: true, username: true,
          channel: true, lastMessageText: true,
        },
        take: limit,
      }),
      // Tasks
      this.prisma.task.findMany({
        where: {
          tenantId,
          ...(agentFilter ? { assigneeId: userId } : {}),
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: { id: true, title: true, status: true, priority: true, dueAt: true },
        take: limit,
      }),
      // Invoices
      this.prisma.invoice.findMany({
        where: {
          tenantId,
          ...(agentFilter ? { agentId: userId } : {}),
          OR: [
            { invoiceNumber: { contains: search, mode: 'insensitive' } },
            { client: { fullName: { contains: search, mode: 'insensitive' } } },
          ],
        },
        select: {
          id: true, invoiceNumber: true, salePrice: true, status: true, currency: true,
          client: { select: { id: true, fullName: true } },
        },
        take: limit,
      }),
      // Documents
      this.prisma.document.findMany({
        where: {
          tenantId,
          OR: [
            { fileName: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true, fileName: true, name: true, fileUrl: true, category: true,
          client: { select: { id: true, fullName: true } },
        },
        take: limit,
      }),
    ]);

    return { clients, bookings, conversations, tasks, invoices, documents };
  }
}

@Controller('search')
@UseGuards(JwtAuthGuard)
export class SearchController {
  constructor(private svc: SearchService) {}

  @Get()
  global(@CurrentUser() u: any, @Query('q') q: string) {
    return this.svc.global(u.tenantId, u.sub, u.role, q);
  }
}

@Module({
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
