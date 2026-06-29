import * as winston from 'winston';
export declare const winstonLogger: winston.Logger;
export declare class AppLogger {
    private context;
    constructor(context: string);
    private format;
    log(msg: string, ctx?: string): void;
    error(msg: string, trace?: string, ctx?: string): void;
    warn(msg: string, ctx?: string): void;
    debug(msg: string, ctx?: string): void;
    verbose(msg: string, ctx?: string): void;
}
