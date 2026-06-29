import { BackupService } from './backup.service';
export declare class BackupController {
    private svc;
    constructor(svc: BackupService);
    trigger(): Promise<{
        ok: boolean;
        file?: string;
        size?: number;
        error?: string;
    }>;
    status(): {
        enabled: boolean;
        bucket: string;
        cron: string;
    };
}
export declare class BackupModule {
}
