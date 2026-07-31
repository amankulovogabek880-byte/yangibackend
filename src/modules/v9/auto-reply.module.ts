import { Module, Injectable, Controller, Post, Get, Put, Delete, Param, Body, UseGuards, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { EmailService } from '../email/email.service';

@Injectable()
export class AutoReplyService {
  // v22 FIX: console.log/error o'rniga markazlashgan Nest Logger — bu
  // winston transport orqali fayl+konsolga birdek yoziladi.
  private readonly logger = new Logger('AutoReply');

  constructor(
    private prisma: PrismaService,
    // v22 FIX: EMAIL kanali ilgari HAQIQATDA email yubormas edi — faqat
    // "console.log(Email to X: ...)" bilan konsolga yozib qo'yardi va
    // triggerCount'ni oshirib, "yuborildi" deb ko'rsatardi. Mijoz hech
    // qanday xat olmasdi, lekin CRM'da "muvaffaqiyatli ishladi" deb
    // ko'rinardi. EmailModule @Global(), shuning uchun bu yerga qo'shimcha
    // import kerak emas — to'g'ridan-to'g'ri inject qilinadi.
    private email: EmailService,
  ) {}

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
              }).catch((e: any) => this.logger.error(`Telegram send error: ${e?.message}`));
            }
          } else if (rule.channel === 'EMAIL' && (client as any).email) {
            // v22 FIX: ilgari bu yerda email UMUMAN yuborilmasdi — faqat
            // konsolga chiqarib qo'yilardi va pastdagi triggerCount baribir
            // oshirilib, "muvaffaqiyatli" deb belgilanardi. Endi haqiqatan
            // EmailService orqali yuboriladi.
            const sendResult = await this.email.send({
              to: (client as any).email,
              toName: client.fullName || undefined,
              subject: rule.name || "Avtomatik javob",
              html: message.replace(/\n/g, '<br/>'),
              text: message,
              tenantId,
              metadata: { autoReplyRuleId: rule.id, clientId: client.id },
            });
            if (!sendResult.ok) {
              this.logger.error(`Email yuborilmadi [rule ${rule.id}]: ${sendResult.error}`);
            }
          }
          // Trigger count update
          await this.prisma.autoReplyRule.update({
            where: { id: rule.id },
            data: { triggerCount: { increment: 1 } },
          });
        } catch (e: any) {
          this.logger.error(`Error rule ${rule.id}: ${e?.message}`);
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