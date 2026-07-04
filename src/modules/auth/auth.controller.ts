import {
  Controller, Post, Get, Patch, Delete, Body, Param,
  Req, Res, UseGuards, HttpCode, BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, Public, Roles } from '../../common/decorators';
import { LoginRateLimitGuard } from '../../common/guards/rate-limit.guard';

// ─────────────────────────────────────────────────────────────
// XAVFSIZLIK TUZATISH (v10.1):
// Refresh token endi httpOnly cookie'da saqlanadi — JS unga yeta olmaydi,
// demak XSS orqali o'g'irlab bo'lmaydi. Access token esa qisqa muddatli
// (15m) va frontend uni faqat xotirada (memory) ushlaydi.
//
// Orqaga moslik: body'dagi refreshToken hali ham qabul qilinadi
// (mobil app / eski client'lar uchun), lekin cookie ustuvor.
//
// ENV sozlamalari:
//   COOKIE_DOMAIN   — masalan `.omoncrm.uz` (frontend/backend subdomenlarda bo'lsa)
//   COOKIE_SAMESITE — 'lax' (default, bir sayt) | 'none' (turli domenlar, HTTPS shart)
// ─────────────────────────────────────────────────────────────

const REFRESH_COOKIE = 'omon_rt';

function refreshCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  // v14 FIX (refresh qilsa login'ga otib yuborardi): frontend (vercel.app) va
  // backend BOSHQA domenda — bu CROSS-SITE. SameSite=lax bo'lsa brauzer refresh
  // cookie'ni cross-site so'rovda YUBORMAYDI, natijada sahifa yangilanganda
  // /auth/refresh cookie'siz ketib, sessiya tiklanmasdan login'ga otardi.
  // Endi production'da default 'none' (+secure) — cross-domain'da ishlaydi.
  // Agar frontend va backend BIR domenda bo'lsa, COOKIE_SAMESITE=lax qo'ying.
  const sameSite = (process.env.COOKIE_SAMESITE || (isProd ? 'none' : 'lax')) as 'lax' | 'strict' | 'none';
  const days = parseInt((process.env.JWT_REFRESH_EXPIRES || '7d').replace('d', ''), 10) || 7;
  return {
    httpOnly: true,
    secure: isProd || sameSite === 'none', // sameSite=none faqat secure (https) bilan ishlaydi
    sameSite,
    domain: process.env.COOKIE_DOMAIN || undefined,
    path: '/api/v1/auth', // cookie faqat auth endpointlariga yuboriladi
    maxAge: days * 86400000,
  } as const;
}

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, refreshCookieOptions());
}

function clearRefreshCookie(res: Response) {
  const { maxAge, ...opts } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE, opts);
}

function readRefreshToken(req: Request, body?: { refreshToken?: string }): string | undefined {
  // 1) httpOnly cookie (ustuvor)  2) body fallback (eski clientlar)
  return (req.cookies?.[REFRESH_COOKIE] as string | undefined) || body?.refreshToken;
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  // ─── PUBLIC ENDPOINTS ────────────────────────────────────

  // v14 XAVFSIZLIK: login brute-force himoyasi — 1 daqiqada 5 urinish (IP bo'yicha).
  // Global throttle (100/60s) parol tахmin qilishga juda bo'sh edi.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  @Public()
  @UseGuards(LoginRateLimitGuard)
  @HttpCode(200)
  async login(
    @Body() body: { email: string; password: string; twoFactorCode?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const userAgent = req.headers['user-agent'];
    const result = await this.auth.login(body.email, body.password, body.twoFactorCode, ip, userAgent);

    // 2FA talab qilinsa token hali yo'q
    if ((result as any).requires2FA) return result;

    const { refreshToken, ...rest } = result as any;
    setRefreshCookie(res, refreshToken);
    // refreshToken javob body'sida ham qaytadi (mobil client fallback),
    // lekin web frontend uni ENDI localStorage'ga yozmaydi.
    return { ...rest, refreshToken };
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(
    @Body() body: { refreshToken?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip;
    const token = readRefreshToken(req, body);
    const result = await this.auth.refresh(token as string, ip, req.headers['user-agent']);

    const { refreshToken, ...rest } = result as any;
    setRefreshCookie(res, refreshToken); // rotation: yangi token cookie'ga
    return { ...rest, refreshToken };
  }

  // ─── AUTHENTICATED ENDPOINTS ─────────────────────────────

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async logout(
    @Body() body: { refreshToken?: string },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = readRefreshToken(req, body);
    clearRefreshCookie(res);
    return this.auth.logout(token || '');
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async logoutAll(@CurrentUser() u: any, @Res({ passthrough: true }) res: Response) {
    clearRefreshCookie(res);
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
  async disable2FA(
    @CurrentUser() u: any,
    @Body() body: { credential?: string; password?: string; code?: string },
  ) {
    // Yangi frontend `credential` yuboradi; eski `password`/`code` bilan ham ishlaydi.
    const credential = body.credential ?? body.password ?? body.code;
    if (!credential) throw new BadRequestException("Parol yoki kod kerak");
    return this.auth.disable2FA(u.sub, credential);
  }

  // ─── SESSIONS ────────────────────────────────────────────

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async sessions(@CurrentUser() u: any, @Req() req: Request) {
    // Cookie'dan (yoki eski x-refresh-token header'dan) joriy sessiyani aniqlaymiz
    const refreshToken =
      (req.cookies?.[REFRESH_COOKIE] as string | undefined) ||
      (req.headers['x-refresh-token'] as string | undefined);
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

  @Throttle({ default: { limit: 5, ttl: 3600000 } })
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