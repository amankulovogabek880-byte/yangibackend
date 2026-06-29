import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';

const METHOD_TO_ACTION: Record<string, string> = {
  POST: 'CREATE',
  PUT: 'UPDATE',
  PATCH: 'UPDATE',
  DELETE: 'DELETE',
};

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const method = req.method;
    const user = req.user;

    if (!METHOD_TO_ACTION[method] || !user?.sub) {
      return next.handle();
    }

    const path = req.path;
    const action = METHOD_TO_ACTION[method] as any;
    const entity = path.split('/')[3] || 'unknown';

    return next.handle().pipe(
      tap(async (result) => {
        try {
          await this.prisma.auditLog.create({
            data: {
              tenantId: user.tenantId,
              userId: user.sub,
              action,
              entity,
              entityId: result?.id,
              metadata: { method, path, params: req.params || {} },
              ip: req.ip,
              userAgent: req.headers['user-agent']?.slice(0, 200),
            },
          });
        } catch {
          /* never block on audit */
        }
      }),
      catchError((err) => {
        this.prisma.auditLog
          .create({
            data: {
              tenantId: user.tenantId,
              userId: user.sub,
              action,
              entity,
              metadata: { method, path, error: err?.message?.slice(0, 200) },
              ip: req.ip,
            },
          })
          .catch(() => {});
        return throwError(() => err);
      }),
    );
  }
}
