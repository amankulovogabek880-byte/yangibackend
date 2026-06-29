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
} from '@nestjs/common';
import { ClientsService } from './clients.service';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RoundRobinModule } from '../v9/round-robin.module';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';

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
    return this.svc.create(u.tenantId, u.sub, body);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() u: any) {
    return this.svc.update(u.tenantId, id, u.sub, u.role, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.tenantId, id, u.sub, u.role);
  }

  @Post(':id/notes')
  addNote(@Param('id') id: string, @Body('note') note: string, @CurrentUser() u: any) {
    return this.svc.addNote(u.tenantId, id, u.sub, u.role, note);
  }

  @Patch(':id/tier')
  setTier(@Param('id') id: string, @Body('tier') tier: string, @CurrentUser() u: any) {
    return this.svc.setTier(u.tenantId, id, u.sub, u.role, tier);
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
  imports: [RoundRobinModule, EventEmitterModule.forRoot()],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
