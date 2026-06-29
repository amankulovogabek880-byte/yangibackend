import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: (() => {
        const s = process.env.JWT_ACCESS_SECRET;
        if (!s || s === 'change-me') {
          if (process.env.NODE_ENV === 'production') throw new Error('JWT_ACCESS_SECRET env kerak!');
          return 'dev-only-change-in-production';
        }
        return s;
      })(),
      signOptions: { expiresIn: process.env.JWT_ACCESS_EXPIRES || '15m' },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
