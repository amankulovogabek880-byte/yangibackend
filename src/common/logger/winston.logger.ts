import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

const logDir = process.env.LOG_DIR || './logs';
try {
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
} catch {}

const { combine, timestamp, printf, colorize, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, context, trace, ...meta }: any) => {
  const ctx = context ? `[${context}] ` : '';
  const err = trace ? `\n${trace}` : '';
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${ts} ${level} ${ctx}${message}${extra}${err}`;
});

export const winstonLogger = winston.createLogger({
  transports: [
    new winston.transports.Console({
      level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
      format: combine(
        colorize({ all: true }),
        timestamp({ format: 'HH:mm:ss' }),
        errors({ stack: true }),
        logFormat,
      ),
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'app.log'),
      level: 'info',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        logFormat,
      ),
    }),
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 10,
      tailable: true,
      format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        errors({ stack: true }),
        logFormat,
      ),
    }),
  ],
});

// NestJS Logger adapter
export class AppLogger {
  private context: string;
  constructor(context: string) { this.context = context; }
  private format(msg: string, meta?: any[]) {
    return meta?.length ? `${msg} ${JSON.stringify(meta)}` : msg;
  }
  log(msg: string, ctx?: string) { winstonLogger.info(msg, { context: ctx || this.context }); }
  error(msg: string, trace?: string, ctx?: string) { winstonLogger.error(msg, { context: ctx || this.context, trace }); }
  warn(msg: string, ctx?: string) { winstonLogger.warn(msg, { context: ctx || this.context }); }
  debug(msg: string, ctx?: string) { winstonLogger.debug(msg, { context: ctx || this.context }); }
  verbose(msg: string, ctx?: string) { (winstonLogger as any).verbose?.(msg, { context: ctx || this.context }); }
}
