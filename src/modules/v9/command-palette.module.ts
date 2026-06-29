import {
  Module,
  Injectable,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';

/**
 * v9: COMMAND PALETTE (Ctrl+K)
 *
 * Universal qidiruv va tezkor amallar.
 *
 * Foydalanuvchi Ctrl+K bosadi va:
 *   - Klient nomini yozadi → mijoz topiladi
 *   - "yangi" yozadi → "Yangi mijoz", "Yangi booking" amallari chiqadi
 *   - Booking REF yozadi → booking topiladi
 *
 * Bu endpoint barcha kerakli ma'lumotlarni bitta call'da qaytaradi.
 * Frontend lokal filterlash bilan ishlatadi (tez).
 */
@Injectable()
export class CommandPaletteService {
  constructor(private prisma: PrismaService) {}

  async search(tenantId: string, userId: string, role: string, query: string) {
    const q = query.trim();
    if (q.length < 1) {
      return { results: [], actions: this.getActions(role) };
    }

    const limit = 5;
    const agentFilter = role === 'AGENT';

    // Parallel qidiruv 4 ta entity bo'yicha
    const [clients, bookings, invoices, conversations] = await Promise.all([
      this.prisma.client.findMany({
        where: {
          tenantId,
          ...(agentFilter ? { assignedAgentId: userId } : {}),
          OR: [
            { fullName: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, fullName: true, phone: true, tier: true, pipelineStage: true },
        take: limit,
      }),
      this.prisma.booking.findMany({
        where: {
          tenantId,
          ...(agentFilter ? { agentId: userId } : {}),
          OR: [
            { bookingRef: { contains: q, mode: 'insensitive' } },
            { tourName: { contains: q, mode: 'insensitive' } },
            { destination: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true, bookingRef: true, tourName: true, destination: true,
          totalPrice: true, currency: true, status: true,
        },
        take: limit,
      }),
      this.prisma.invoice.findMany({
        where: {
          tenantId,
          ...(agentFilter ? { agentId: userId } : {}),
          OR: [
            { invoiceNumber: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, invoiceNumber: true, salePrice: true, currency: true, status: true },
        take: limit,
      }),
      this.prisma.conversation.findMany({
        where: {
          tenantId,
          ...(agentFilter ? { OR: [{ assignedAgentId: userId }, { assignedAgentId: null }] } : {}),
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { username: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, firstName: true, lastName: true, username: true, channel: true },
        take: 3,
      }),
    ]);

    // Hammasini Result formatga keltiramiz
    const results = [
      ...clients.map((c) => ({
        type: 'client',
        id: c.id,
        title: c.fullName,
        subtitle: `${c.phone || '—'} • ${c.tier}`,
        icon: '👤',
        url: `/clients/${c.id}`,
      })),
      ...bookings.map((b) => ({
        type: 'booking',
        id: b.id,
        title: b.tourName,
        subtitle: `${b.bookingRef} • ${b.destination} • ${b.currency} ${b.totalPrice}`,
        icon: '✈️',
        url: `/bookings/${b.id}`,
      })),
      ...invoices.map((i) => ({
        type: 'invoice',
        id: i.id,
        title: `Invoice ${i.invoiceNumber}`,
        subtitle: `${i.currency} ${i.salePrice} • ${i.status}`,
        icon: '🧾',
        url: `/invoices/${i.id}`,
      })),
      ...conversations.map((c) => ({
        type: 'conversation',
        id: c.id,
        title: `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.username || 'Suhbat',
        subtitle: `${c.channel} • @${c.username || '—'}`,
        icon: '💬',
        url: `/inbox?conv=${c.id}`,
      })),
    ];

    return {
      query: q,
      results,
      actions: this.getActions(role).filter((a) =>
        a.title.toLowerCase().includes(q.toLowerCase()) ||
        a.keywords?.some((k) => k.toLowerCase().includes(q.toLowerCase()))
      ),
    };
  }

  /**
   * Tezkor amallar - "yangi mijoz", "yangi booking", va h.k.
   */
  private getActions(role: string) {
    const all = [
      { type: 'action', id: 'new-client', title: '👤 Yangi mijoz', subtitle: 'Yangi klient yaratish', url: '/clients?new=1', icon: '➕', shortcut: 'C', keywords: ['mijoz', 'klient', 'new', 'create', 'create client'] },
      { type: 'action', id: 'new-booking', title: '✈️ Yangi booking', subtitle: 'Yangi sayohat buyurtmasi', url: '/bookings?new=1', icon: '➕', shortcut: 'B', keywords: ['booking', 'buyurtma', 'sayohat', 'tur'] },
      { type: 'action', id: 'new-invoice', title: '🧾 Yangi invoice', subtitle: 'Hisob-faktura yaratish', url: '/invoices?new=1', icon: '➕', shortcut: 'I', keywords: ['invoice', 'hisob', 'faktura'] },
      { type: 'action', id: 'new-task', title: '☑ Yangi vazifa', subtitle: 'Vazifa qo\'shish', url: '/tasks?new=1', icon: '➕', keywords: ['task', 'vazifa', 'topshiriq'] },
      { type: 'action', id: 'inbox', title: '✉ Inbox', subtitle: 'Suhbatlar', url: '/inbox', icon: '💬', keywords: ['inbox', 'chat', 'xabar', 'suhbat'] },
      { type: 'action', id: 'pipeline', title: '⊞ Pipeline', subtitle: 'Sotuv bosqichlari', url: '/pipeline', icon: '📊', keywords: ['pipeline', 'kanban', 'sotuv'] },
      { type: 'action', id: 'reports', title: '◬ Hisobotlar', subtitle: 'Statistika va tahlil', url: '/reports', icon: '📈', keywords: ['report', 'hisobot', 'stat', 'kpi'] },
      { type: 'action', id: 'settings', title: '⚙ Sozlamalar', subtitle: 'Profil va kompaniya', url: '/settings', icon: '⚙', keywords: ['settings', 'sozlama', 'profil'] },
    ];

    if (['TENANT_ADMIN', 'MANAGER'].includes(role)) {
      all.push(
        { type: 'action', id: 'team', title: '👥 Jamoa', subtitle: 'Agentlar va xodimlar', url: '/settings?tab=team', icon: '👥', keywords: ['team', 'jamoa', 'agent'] },
        { type: 'action', id: 'approvals', title: '✅ Tasdiqlar', subtitle: 'Kutilayotgan so\'rovlar', url: '/approvals', icon: '✅', keywords: ['approval', 'tasdiq', 'so\'rov'] },
      );
    }

    return all;
  }
}

@Controller('command-palette')
@UseGuards(JwtAuthGuard)
export class CommandPaletteController {
  constructor(private svc: CommandPaletteService) {}

  @Get('search')
  search(@Query('q') q: string, @CurrentUser() u: any) {
    return this.svc.search(u.tenantId, u.sub, u.role, q || '');
  }
}

@Module({
  controllers: [CommandPaletteController],
  providers: [CommandPaletteService],
  exports: [CommandPaletteService],
})
export class CommandPaletteModule {}
