import { Module, Injectable, Controller, Get, Post, Put, Delete, Param, Body, UseGuards, BadRequestException, Query, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';
import { RoundRobinService, RoundRobinModule } from './round-robin.module';

@Injectable()
export class LeadFormsService {
  // v23 FIX: console yo'q edi, lekin catch(() => {}) bilan xatolar jim
  // yutilardi — endi ko'rinadigan bo'lishi uchun Logger qo'shildi.
  private readonly logger = new Logger('LeadForms');

  constructor(
    private prisma: PrismaService,
    private roundRobin: RoundRobinService,
  ) {}

  async list(tenantId: string) {
    return this.prisma.leadForm.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getBySlug(tenantId: string, slug: string) {
    return this.prisma.leadForm.findFirst({
      where: { tenantId, slug, isActive: true },
    });
  }

  async create(tenantId: string, data: any) {
    if (!data.name?.trim() || !data.slug?.trim()) {
      throw new BadRequestException('Nom va slug kerak');
    }

    const slug = data.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const existing = await this.prisma.leadForm.findFirst({
      where: { tenantId, slug },
    });
    if (existing) throw new BadRequestException('Bu slug allaqachon bor');

    return this.prisma.leadForm.create({
      data: {
        tenantId,
        name: data.name.trim(),
        slug,
        description: data.description || null,
        fields: data.fields || [],
        theme: data.theme || { primaryColor: '#3d7eff' },
        successMsg: data.successMsg || 'Rahmat!',
        redirectUrl: data.redirectUrl || null,
        isActive: data.isActive !== false,
      },
    });
  }

  async update(tenantId: string, formId: string, data: any) {
    const form = await this.prisma.leadForm.findFirst({
      where: { id: formId, tenantId },
    });
    if (!form) throw new BadRequestException('Form topilmadi');

    return this.prisma.leadForm.update({
      where: { id: formId },
      data: {
        name: data.name || form.name,
        description: data.description,
        fields: data.fields || form.fields,
        theme: data.theme || form.theme,
        successMsg: data.successMsg || form.successMsg,
        redirectUrl: data.redirectUrl,
        isActive: data.isActive !== undefined ? data.isActive : form.isActive,
      },
    });
  }

  async delete(tenantId: string, formId: string) {
    const form = await this.prisma.leadForm.findFirst({
      where: { id: formId, tenantId },
    });
    if (!form) throw new BadRequestException('Form topilmadi');

    await this.prisma.leadForm.delete({ where: { id: formId } });
    return { success: true };
  }

  async submit(tenantId: string, slug: string, data: any) {
    const form = await this.getBySlug(tenantId, slug);
    if (!form) throw new BadRequestException('Form topilmadi');

    const fullName = (data.fullName || data.full_name || '').trim();
    const email    = (data.email || data.contact_email || '').trim().toLowerCase() || null;
    const phone    = (data.phone || data.contact_phone || '').trim() || null;
    const message  = data.message || data.notes || null;

    if (!fullName) throw new BadRequestException('Ism majburiy');
    if (!phone && !email) throw new BadRequestException('Telefon yoki email kerak');

    // 1. Submission saqla (xom audit yozuvi — asosiy Client pastda
    // baribir yaratiladi, shuning uchun bu yerda xato blokламайди,
    // lekin endi kamida loglanadi).
    await (this.prisma as any).leadFormSubmission?.create({
      data: { formId: form.id, tenantId, data, email, phone },
    }).catch((e: any) => this.logger.warn(`Submission audit yozuvi saqlanmadi (form ${form.id}): ${e?.message}`));

    // 2. Dublikat tekshir
    let existing: any = null;
    if (phone) existing = await this.prisma.client.findFirst({ where: { tenantId, phone } });
    if (!existing && email) existing = await this.prisma.client.findFirst({ where: { tenantId, email } });

    let clientId: string;
    let assignedAgentId: string | null = null;

    if (existing) {
      clientId = existing.id;
      await (this.prisma as any).clientTimeline?.create({
        data: {
          clientId, type: 'message',
          title: `🔁 Web forma orqali yangi murojaat (${form.name})`,
          description: message,
          metadata: { isDuplicate: true, formSlug: slug, formName: form.name },
        },
      }).catch((e: any) => this.logger.warn(`Timeline yozilmadi (client ${clientId}): ${e?.message}`));
    } else {
      const newClient = await this.prisma.client.create({
        data: {
          tenantId, fullName, phone, email, notes: message,
          source: 'WEBSITE' as any, pipelineStage: 'NEW_LEAD' as any,
          status: 'ACTIVE' as any, tier: 'REGULAR' as any,
        },
      });
      clientId = newClient.id;

      await (this.prisma as any).clientTimeline?.create({
        data: {
          clientId, type: 'created',
          title: `📥 Web forma orqali lead — ${form.name}`,
          description: message,
          metadata: { formSlug: slug, formName: form.name, formId: form.id },
        },
      }).catch((e: any) => this.logger.warn(`Timeline yozilmadi (client ${clientId}): ${e?.message}`));

      // Round Robin tayinlash (strategiya tekshirib). v23 FIX: xato
      // bo'lsa jim qolardi — lead agentsiz qolib ketganini hech kim
      // bilmasdi. Endi loglanadi, admin "Reassign all" bilan tuzatishi mumkin.
      assignedAgentId = await this.roundRobin.assignNewLead({
        tenantId,
        clientId,
        clientName: fullName,
        source: 'WEBSITE',
      }).catch((e: any) => {
        this.logger.warn(`Avtomatik tayinlash muvaffaqiyatsiz (client ${clientId}): ${e?.message}`);
        return null;
      });
    }

    // 3. Submit count yangilash (statistika, ikkinchi darajali)
    await this.prisma.leadForm.update({
      where: { id: form.id },
      data: { submitCount: form.submitCount + 1, lastSubmitAt: new Date() },
    }).catch((e: any) => this.logger.warn(`submitCount yangilanmadi (form ${form.id}): ${e?.message}`));

    return { success: true, message: form.successMsg || 'Rahmat!', clientId, assignedAgentId };
  }

  async getStats(tenantId: string, formId: string) {
    const form = await this.prisma.leadForm.findFirst({
      where: { id: formId, tenantId },
    });
    if (!form) throw new BadRequestException('Form topilmadi');

    return {
      submitCount: form.submitCount,
      lastSubmitAt: form.lastSubmitAt,
    };
  }
}

@Controller('lead-forms')
@UseGuards(JwtAuthGuard)
export class LeadFormsController {
  constructor(private svc: LeadFormsService) {}

  @Get()
  list(@CurrentUser() u: any) {
    return this.svc.list(u.tenantId);
  }

  @Get(':id/stats')
  stats(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.getStats(u.tenantId, id);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  create(@CurrentUser() u: any, @Body() body: any) {
    return this.svc.create(u.tenantId, body);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  update(@CurrentUser() u: any, @Param('id') id: string, @Body() body: any) {
    return this.svc.update(u.tenantId, id, body);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN')
  delete(@CurrentUser() u: any, @Param('id') id: string) {
    return this.svc.delete(u.tenantId, id);
  }
}

// PUBLIC endpoint (no auth) — embed forma uchun
@Controller('public/forms')
export class PublicFormController {
  constructor(private svc: LeadFormsService) {}

  // Forma ma'lumotlarini olish (iframe embed uchun)
  @Get(':tenantId/:slug')
  async getForm(
    @Param('tenantId') tenantId: string,
    @Param('slug') slug: string,
  ) {
    const form = await this.svc.getBySlug(tenantId, slug);
    if (!form) throw new BadRequestException('Form topilmadi');
    return form;
  }

  // Forma submit (iframe ichidan keladi)
  @Post(':tenantId/:slug/submit')
  async submitForm(
    @Param('tenantId') tenantId: string,
    @Param('slug') slug: string,
    @Body() body: any,
  ) {
    return this.svc.submit(tenantId, slug, body);
  }
}

@Module({
  imports: [RoundRobinModule],
  controllers: [LeadFormsController, PublicFormController],
  providers: [LeadFormsService],
  exports: [LeadFormsService],
})
export class LeadFormsModule {}