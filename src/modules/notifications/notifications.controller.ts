import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private svc: NotificationsService) {}

  @Get()
  list(@CurrentUser() u: any, @Query('unread') unread?: string) {
    return this.svc.list(u.sub, unread === 'true');
  }

  @Get('count')
  count(@CurrentUser() u: any) {
    return this.svc.unreadCount(u.sub);
  }

  @Patch(':id/read')
  read(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.markRead(u.sub, id, u.tenantId);
  }

  @Patch('read-all')
  readAll(@CurrentUser() u: any) {
    return this.svc.markAllRead(u.sub, u.tenantId);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.delete(u.sub, id, u.tenantId);
  }

  /** v9-SECURITY: Delete all with tenantId verification */
  @Delete()
  deleteAll(@CurrentUser() u: any) {
    return this.svc.deleteAll(u.sub, u.tenantId);
  }
}
