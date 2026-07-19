import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RealtimeGateway } from './realtime.gateway';
import { RedisClientModule } from '../../common/cache/redis-client.module';

@Global()
@Module({
  imports: [
    // v12.5: WebSocket Redis adapteri uchun (ko'p instans)
    RedisClientModule,
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET || 'dev-only-change-in-production',
    }),
  ],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}