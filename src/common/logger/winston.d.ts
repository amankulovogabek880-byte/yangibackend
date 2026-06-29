declare module 'winston' {
  interface Logger {
    info(message: string, meta?: any): Logger;
    error(message: string, meta?: any): Logger;
    warn(message: string, meta?: any): Logger;
    debug(message: string, meta?: any): Logger;
  }
  namespace transports {
    class Console { constructor(opts?: any); }
    class File { constructor(opts?: any); }
  }
  namespace format {
    function combine(...formats: any[]): any;
    function timestamp(opts?: any): any;
    function printf(fn: (info: any) => string): any;
    function colorize(opts?: any): any;
    function errors(opts?: any): any;
  }
  function createLogger(opts?: any): Logger;
}
