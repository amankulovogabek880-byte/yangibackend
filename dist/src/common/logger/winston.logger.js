"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppLogger = exports.winstonLogger = void 0;
const winston = __importStar(require("winston"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const logDir = process.env.LOG_DIR || './logs';
try {
    if (!fs.existsSync(logDir))
        fs.mkdirSync(logDir, { recursive: true });
}
catch { }
const { combine, timestamp, printf, colorize, errors } = winston.format;
const logFormat = printf(({ level, message, timestamp: ts, context, trace, ...meta }) => {
    const ctx = context ? `[${context}] ` : '';
    const err = trace ? `\n${trace}` : '';
    const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
    return `${ts} ${level} ${ctx}${message}${extra}${err}`;
});
exports.winstonLogger = winston.createLogger({
    transports: [
        new winston.transports.Console({
            level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
            format: combine(colorize({ all: true }), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), logFormat),
        }),
        new winston.transports.File({
            filename: path.join(logDir, 'app.log'),
            level: 'info',
            maxsize: 10 * 1024 * 1024,
            maxFiles: 5,
            tailable: true,
            format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), logFormat),
        }),
        new winston.transports.File({
            filename: path.join(logDir, 'error.log'),
            level: 'error',
            maxsize: 10 * 1024 * 1024,
            maxFiles: 10,
            tailable: true,
            format: combine(timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), logFormat),
        }),
    ],
});
class AppLogger {
    constructor(context) { this.context = context; }
    format(msg, meta) {
        return meta?.length ? `${msg} ${JSON.stringify(meta)}` : msg;
    }
    log(msg, ctx) { exports.winstonLogger.info(msg, { context: ctx || this.context }); }
    error(msg, trace, ctx) { exports.winstonLogger.error(msg, { context: ctx || this.context, trace }); }
    warn(msg, ctx) { exports.winstonLogger.warn(msg, { context: ctx || this.context }); }
    debug(msg, ctx) { exports.winstonLogger.debug(msg, { context: ctx || this.context }); }
    verbose(msg, ctx) { exports.winstonLogger.verbose?.(msg, { context: ctx || this.context }); }
}
exports.AppLogger = AppLogger;
//# sourceMappingURL=winston.logger.js.map