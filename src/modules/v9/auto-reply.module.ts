import { Module, Injectable, Controller, Post, Get, Put, Delete, Param, Body, UseGuards, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';

@Injectable()
export class AutoReplyService {
  constructor(private prisma: PrismaService) {}

  async list(tenantId: string) {
    return this.prisma.autoReplyRule.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(tenantId: string, data: any) {
    if (!data.name?.trim()) throw new BadRequestException('Nom kerak');
    if (!data.channel || !['TELEGRAM', 'EMAIL'].includes(data.channel)) {
      throw new BadRequestException('Kanal: TELEGRAM yoki EMAIL');
    }
    if (!data.template?.trim()) throw new BadRequestException('Matn kerak');

    return this.prisma.autoReplyRule.create({
      data: {
        tenantId,
        name: data.name.trim(),
        source: data.source || null,
        channel: data.channel,
        template: data.template,
        delayMs: Math.max(0, parseInt(data.delayMs) || 0),
        isActive: data.isActive !== false,
      },
    });
  }

  async update(tenantId: string, ruleId: string, data: any) {
    const rule = await this.prisma.autoReplyRule.findFirst({
      where: { id: ruleId, tenantId },
    });
    if (!rule) throw new BadRequestException('Qoida topilmadi');

    return this.prisma.autoReplyRule.update({
      where: { id: ruleId },
      data: {
        name: data.name || rule.name,
        source: data.source !== undefined ? data.source : rule.source,
        channel: data.channel || rule.channel,
        template: data.template || rule.template,
        delayMs: data.delayMs !== undefined ? Math.max(0, parseInt(data.delayMs)) : rule.delayMs,
        isActive: data.isActive !== undefined ? data.isActive : rule.isActive,
      },
    });
  }

  async delete(tenantId: string, ruleId: string) {
    const rule = await this.prisma.autoReplyRule.findFirst({
      where: { id: ruleId, tenantId },
    });
    if (!rule) throw new BadRequestException('Qoida topilmadi');

    await this.prisma.autoReplyRule.delete({ where: { id: ruleId } });
    return { success: true };
  }

  async toggle(tenantId: string, ruleId: string) {
    const rule = await this.prisma.autoReplyRule.findFirst({
      where: { id: ruleId, tenantId },
    });
    if (!rule) throw new BadRequestException('Qoida topilmadi');

    return this.prisma.autoReplyRule.update({
      where: { id: ruleId },
      data: { isActive: !rule.isActive },
    });
  }

  // Placeholder almashtirgich
  async renderTemplate(template: string, client: any): Promise<string> {
    let result = template;
    const placeholders: Record<string, string> = {
      'client.fullName': client.fullName || '',
      'client.phone': client.phone || '',
      'client.email': client.email || '',
      'client.source': client.source || '',
    };

    for (const [key, value] of Object.entries(placeholders)) {
      result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
    }

    return result;
  }

  async triggerRules(tenantId: string, clientId: string, source: string) {
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, tenantId },
    });
    if (!client) return;

    const rules = await this.prisma.autoReplyRule.findMany({
      where: {
        tenantId,
        isActive: true,
        OR: [{ source: null }, { source }],
      },
    });

    for (const rule of rules) {
      const message = await this.renderTemplate(rule.template, client);

      // BUG3 FIX: Delay bilan Telegram xabar yuborish
      setTimeout(async () => {
        try {
          if (rule.channel === 'TELEGRAM' && (client as any).telegramId) {
            // Active Telegram bot topamiz
            const accounts = await (this.prisma as any).telegramAccount.findMany({
              where: { tenantId, isActive: true, botToken: { not: null } },
              take: 1,
            });
            if (accounts.length > 0 && accounts[0].botToken) {
              // telegram-bot-api orqali yuborish
              const chatId = (client as any).telegramId;
              const token  = accounts[0].botToken;
              await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
              }).catch((e: any) => console.error('[AutoReply] Telegram send error:', e?.message));
            }
          } else if (rule.channel === 'EMAIL' && (client as any).email) {
            console.log(`[AutoReply] Email to ${(client as any).email}: ${message}`);
          }
          // Trigger count update
          await this.prisma.autoReplyRule.update({
            where: { id: rule.id },
            data: { triggerCount: { increment: 1 } },
          });
        } catch (e: any) {
          console.error(`[AutoReply] Error rule ${rule.id}:`, e?.message);
        }
      }, rule.delayMs || 0);
    }
  }
}

@Controller('auto-reply-rules')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TENANT_ADMIN')
export class AutoReplyController {
  constructor(private svc: AutoReplyService) {}

  @Get()
  list(@CurrentUser() u: any) {
    return this.svc.list(u.tenantId);
  }

  @Post()
  create(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.create(u.tenantId, body);
  }

  @Put(':id')
  update(@CurrentUser() u: any, @Param('id') id: string, @Body() body: any) {
    return this.svc.update(u.tenantId, id, body);
  }

  @Delete(':id')
  delete(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.delete(u.tenantId, id);
  }

  @Post(':id/toggle')
  toggle(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.toggle(u.tenantId, id);
  }
}

@Module({
  controllers: [AutoReplyController],
  providers: [AutoReplyService],
  exports: [AutoReplyService],
})
export class AutoReplyModule {}
