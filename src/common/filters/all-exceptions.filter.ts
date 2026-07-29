import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import {
  PrismaClientKnownRequestError,
  PrismaClientValidationError,
  PrismaClientInitializationError,
  PrismaClientUnknownRequestError,
} from '@prisma/client/runtime/library';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Ichki server xatosi';
    let errorCode: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r: any = exception.getResponse();
      message = typeof r === 'string' ? r : r.message || r.error || message;
    } else if (exception instanceof PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        status = HttpStatus.CONFLICT;
        const field = (exception.meta as any)?.target?.[0] || 'qiymat';
        message = `Bu ${field} allaqachon mavjud`;
        errorCode = 'DUPLICATE';
      } else if (exception.code === 'P2025') {
        status = HttpStatus.NOT_FOUND;
        message = 'Topilmadi';
        errorCode = 'NOT_FOUND';
      } else if (exception.code === 'P2003') {
        status = HttpStatus.BAD_REQUEST;
        message = "Bog'liq ma'lumot topilmadi";
        errorCode = 'FK_VIOLATION';
      } else {
        status = HttpStatus.BAD_REQUEST;
        message = exception.message;
        errorCode = exception.code;
      }
    } else if (
      // 🩹 MUHIM TUZATISH: bazaga ulanish vaqtincha uzilib qolganda
      // (masalan Render Postgres bo'sh ulanishni yopib qo'yganda)
      // Prisma "Server has closed the connection" kabi texnik xato
      // beradi — bu avval TO'G'RIDAN-TO'G'RI foydalanuvchiga
      // ko'rsatilib kelingan (tushunarsiz va qo'rqinchli). Endi
      // odam tushunadigan xabar beramiz; texnik tafsilot faqat
      // serverdagi log'ga yoziladi.
      exception instanceof PrismaClientInitializationError ||
      exception instanceof PrismaClientUnknownRequestError ||
      /server has closed the connection|connection.*(closed|reset|terminated)|econnreset/i.test(String(exception?.message || ''))
    ) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      message = "Ma'lumotlar bazasiga vaqtincha ulanib bo'lmadi. Birozdan so'ng qayta urinib ko'ring.";
      errorCode = 'DB_UNAVAILABLE';
    } else if (exception instanceof PrismaClientValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = "Ma'lumot formati noto'g'ri";
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}`,
        exception.stack,
      );
    }

    response.status(status).json({
      statusCode: status,
      message,
      errorCode,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}