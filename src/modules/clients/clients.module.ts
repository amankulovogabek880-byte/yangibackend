import {
  Module,
  Global,
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ClientsService } from './clients.service';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RoundRobinModule } from '../v9/round-robin.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Roles } from '../../common/decorators';

@Controller('clients')
@UseGuards(JwtAuthGuard)
export class ClientsController {
  constructor(private svc: ClientsService) {}

  @Get()
  list(
    @CurrentUser() u: any,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('tier') tier?: string,
    @Query('source') source?: string,
    @Query('stage') stage?: string,
    @Query('agentId') agentId?: string,
    @Query('tag') tag?: string,
    @Query('sortBy') sortBy?: any,
    @Query('page') page?: any,
    @Query('limit') limit?: any,
  ) {
    return this.svc.findAll(u.tenantId, u.sub, u.role, {
      search, status, tier, source, stage, agentId, tag, sortBy, page, limit,
    });
  }

  @Get('stats')
  stats(@CurrentUser() u: any) {
    return this.svc.getStats(u.tenantId, u.sub, u.role);
  }

  // v12: Yo'qotilgan leadlar — umumiy hovuz (hamma agent ko'radi).
  // MUHIM: bu ':id' route'idan OLDIN turishi kerak, aks holda 'lost' so'zi
  // id sifatida qabul qilinib ketadi.
  @Get('lost')
  lostLeads(
    @CurrentUser() u: any,
    @Query('search') search?: string,
    @Query('page') page?: any,
    @Query('limit') limit?: any,
  ) {
    return this.svc.lostLeads(u.tenantId, { search, page, limit });
  }

  @Get(':id')
  one(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.findOne(u.tenantId, id, u.sub, u.role);
  }

  @Get(':id/timeline')
  timeline(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.getTimeline(u.tenantId, id, u.sub, u.role);
  }

  @Post()
  create(@Body() body: any, @CurrentUser() u: any) {
    return this.svc.create(u.tenantId, u.sub, body, u.role);
  }

  /**
   * v33: Excel (.xlsx) yoki CSV fayldan ko'p sonli lead import qilish.
   * Mijoz CRM'ga o'tganda eski tizimidan (Excel/Google Sheets/boshqa CRM)
   * 1000-2000+ lead ko'chiriladi — har biri ALOHIDA mijoz bo'lib yaraladi,
   * oldingi turgan bosqichi (stage) saqlanib qoladi. Ommaviy operatsiya
   * bo'lgani uchun faqat ADMIN/MANAGER chaqira oladi.
   *
   * Fayl ustunlari (sarlavha qatorida, tartib muhim emas):
   *   Ism* | Telefon | Telefon2 | Email | Manba | Bosqich | Shahar | Davlat |
   *   Yo'nalish | Byudjet | Izoh | Teglar | Agent
   * (* — majburiy, boshqalari ixtiyoriy)
   */
  @Post('import')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB — bir necha ming qatorga yetadi
  }))
  importLeads(@UploadedFile() file: Express.Multer.File, @CurrentUser() u: any) {
    if (!file) throw new BadRequestException("Fayl yuklanmadi (.xlsx yoki .csv kerak, 'file' maydonida)");
    return this.svc.importLeads(u.tenantId, u.sub, file);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, u.sub, u.role, body);
  }

  // v40: ?force=true — bookingi bor klientni ham (barcha booking/to'lov/
  // komissiyasi bilan birga) o'chiradi. Faqat TENANT_ADMIN foydalana oladi
  // (tekshiruv service ichida) — oddiy chaqiruvda avvalgidek bloklanadi.
  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any, @Query('force') force?: string) {
    return this.svc.delete(u.tenantId, id, u.sub, u.role, force === 'true' || force === '1');
  }

  // v40: bronni(larni) bekor qilib, klientni qayta "Yangi lid" hovuziga
  // qaytaradi — bron o'chadi, klient o'chmaydi. Faqat ADMIN/MANAGER.
  @Post(':id/release-to-pool')
  releaseToLeadPool(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.releaseToLeadPool(u.tenantId, id, u.sub, u.role);
  }

  @Post(':id/notes')
  addNote(@Param('id') id: string, @Body('note') note: string, @CurrentUser() u: any) {
    return this.svc.addNote(u.tenantId, id, u.sub, u.role, note);
  }

  @Patch(':id/tier')
  setTier(@Param('id') id: string, @Body('tier') tier: string, @CurrentUser() u: any) {
    return this.svc.setTier(u.tenantId, id, u.sub, u.role, tier);
  }

  /**
   * v37: Admin/Manager mijozni (leadni) biror agentga tayinlaydi yoki
   * qayta tayinlaydi. agentId=null yuborilsa — agentdan bo'shatiladi.
   * Faqat ADMIN/MANAGER chaqira oladi (AGENT o'ziga yoki boshqasiga
   * mijoz tayinlay olmaydi).
   */
  @Patch(':id/assign')
  @UseGuards(RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  assignAgent(@Param('id') id: string, @Body('agentId') agentId: string | null, @CurrentUser() u: any) {
    return this.svc.assignAgent(u.tenantId, id, u.sub, u.role, agentId || null);
  }

  // v14: mijozga ixtiyoriy "key = value" ma'lumotlar (masalan "Qayerga = Istanbul",
  // "Byudjet = 7890"). Server-side merge — offers/travelInfo yo'qolmaydi.
  @Patch(':id/custom-fields')
  setCustomFields(@Param('id') id: string, @Body('fields') fields: any, @CurrentUser() u: any) {
    return this.svc.setCustomFields(u.tenantId, id, u.sub, u.role, fields);
  }

  // v29: "Nima xohlaydi" — QAT'IY 2 ta maydon (yo'nalish + byudjet), erkin
  // key-value emas. Agent bitta qarab, mijoz qayerga bormoqchi va qancha
  // puli borligini darhol ko'rishi uchun — har doim BIR XIL joyda, bir xil
  // nom bilan. setCustomFields kabi server-side merge (boshqa preferences
  // maydonlari, jumladan offers/customFields, saqlanib qoladi).
  @Patch(':id/key-info')
  setKeyInfo(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.setKeyInfo(u.tenantId, id, u.sub, u.role, body);
  }

  /** v5: Open Chat — klient suhbatini Inbox'da ochish */
  @Get(':id/conversation')
  getConversation(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.findOrCreateConversation(u.tenantId, id, u.sub, u.role);
  }

  /**
   * v7: Faqat tekshirish — suhbat mavjudmi?
   * Frontend "Open Chat" tugmasini ko'rsatish/yashirish uchun ishlatadi.
   */
  @Get(':id/conversation/check')
  checkConversation(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.getExistingConversation(u.tenantId, id, u.sub, u.role);
  }

  /** v5: Call — klientga qo'ng'iroq qilish (Twilio) */
  @Post(':id/call')
  callClient(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.initiateCall(u.tenantId, id, u.sub, u.role);
  }

  /** v6: Klientlarni CSV export qilish */
  @Get('actions/export')
  exportCsv(@CurrentUser() u: any) {
    return this.svc.exportCsv(u.tenantId, u.sub, u.role);
  }

  /** v6: Manba bo'yicha statistika */
  @Get('stats/by-source')
  statsBySource(@CurrentUser() u: any) {
    return this.svc.statsBySource(u.tenantId, u.sub, u.role);
  }

  /** v6: Bosqich bo'yicha statistika */
  @Get('stats/by-stage')
  statsByStage(@CurrentUser() u: any) {
    return this.svc.statsByStage(u.tenantId, u.sub, u.role);
  }
}

@Global()
@Module({
  imports: [RoundRobinModule, EventEmitterModule.forRoot(), PipelineModule],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}