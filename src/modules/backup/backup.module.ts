import {
  Module, Controller, Get, Post, UseGuards,
} from '@nestjs/common';
import { BackupService } from './backup.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators';

@Controller('backup')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_OWNER')
export class BackupController {
  constructor(private svc: BackupService) {}

  @Post('trigger')
  trigger() {
    return this.svc.triggerManual();
  }

  @Get('status')
  status() {
    return {
      enabled: process.env.BACKUP_ENABLED === 'true',
      bucket: process.env.S3_BUCKET || null,
      cron: process.env.BACKUP_CRON || '0 */6 * * *',
    };
  }
}

@Module({
  controllers: [BackupController],
  providers: [BackupService],
  exports: [BackupService],
})
export class BackupModule {}
