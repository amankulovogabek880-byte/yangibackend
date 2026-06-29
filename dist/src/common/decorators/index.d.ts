export declare const CurrentUser: (...dataOrPipes: unknown[]) => ParameterDecorator;
export declare const Roles: (...roles: string[]) => import("@nestjs/common").CustomDecorator<string>;
export declare const Public: () => import("@nestjs/common").CustomDecorator<string>;
export declare const SkipAudit: () => import("@nestjs/common").CustomDecorator<string>;
