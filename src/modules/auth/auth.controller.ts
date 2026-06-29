import {
  Controller, Post, Get, Patch, Delete, Body, Param,
  Req, UseGuards, HttpCode, BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { LoginRateLimitGuard } from '../../common/guards/rate-limit.guard';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  // ─── PUBLIC ENDPOINTS ────────────────────────────────────

  @Post('login')
  @Public()
  @UseGuards(LoginRateLimitGuard)
  @HttpCode(200)
  async login(
    @Body() body: { email: string; password: string; twoFactorCode?: string },
    @Req() req: Request,
  ) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const userAgent = req.headers['user-agent'];
    return this.auth.login(body.email, body.password, body.twoFactorCode, ip, userAgent);
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(@Body() body: { refreshToken: string }, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    return this.auth.refresh(body.refreshToken, ip, req.headers['user-agent']);
  }

  // ─── AUTHENTICATED ENDPOINTS ─────────────────────────────

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async logout(@Body() body: { refreshToken: string }) {
    return this.auth.logout(body.refreshToken);
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async logoutAll(@CurrentUser() u: any) {
    return this.auth.logoutAll(u.sub);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() u: any) {
    return this.auth.me(u.sub);
  }

  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async changePassword(
    @CurrentUser() u: any,
    @Body() body: { oldPassword: string; newPassword: string },
  ) {
    if (!body.oldPassword || !body.newPassword) {
      throw new BadRequestException("Eski va yangi parol majburiy");
    }
    return this.auth.changePassword(u.sub, body.oldPassword, body.newPassword);
  }

  // ─── 2FA ─────────────────────────────────────────────────

  @Post('2fa/setup')
  @UseGuards(JwtAuthGuard)
  async setup2FA(@CurrentUser() u: any) {
    return this.auth.setup2FA(u.sub);
  }

  @Post('2fa/enable')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async enable2FA(@CurrentUser() u: any, @Body() body: { code: string }) {
    if (!body.code) throw new BadRequestException("Kod kerak");
    return this.auth.enable2FA(u.sub, body.code);
  }

  @Post('2fa/disable')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async disable2FA(@CurrentUser() u: any, @Body() body: { password: string }) {
    if (!body.password) throw new BadRequestException("Parol kerak");
    return this.auth.disable2FA(u.sub, body.password);
  }

  // ─── SESSIONS ────────────────────────────────────────────

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async sessions(@CurrentUser() u: any, @Req() req: Request) {
    const refreshToken = req.headers['x-refresh-token'] as string | undefined;
    return this.auth.sessions(u.sub, refreshToken);
  }

  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  async revokeSession(@CurrentUser() u: any, @Param('id') id: string) {
    return this.auth.revokeSession(u.sub, id);
  }


  // ─── PASSWORD RESET ──────────────────────────────────────
  @Post('forgot-password')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 3, ttl: 3600000 } }) // 1 soatda 3 urinish
  async forgotPassword(@Body() body: { email: string }) {
    if (!body.email?.trim()) throw new BadRequestException('Email majburiy');
    return this.auth.forgotPassword(body.email);
  }

  @Post('reset-password')
  @Public()
  @HttpCode(200)
  async resetPassword(@Body() body: { email: string; token: string; newPassword: string }) {
    return this.auth.resetPassword(body.email, body.token, body.newPassword);
  }

  @Get('login-history')
  @UseGuards(JwtAuthGuard)
  async loginHistory(@CurrentUser() u: any) {
    return this.auth.loginHistory(u.sub);
  }

  // ─── ADMIN ───────────────────────────────────────────────

  @Post('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('TENANT_ADMIN', 'MANAGER')
  async createUser(@CurrentUser() u: any, @Body() body: any) {
    return this.auth.createUser(u.tenantId, body);
  }
}
