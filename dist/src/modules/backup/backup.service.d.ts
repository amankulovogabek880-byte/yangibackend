export declare class BackupService {
    private readonly logger;
    private enabled;
    private bucket;
    private endpoint;
    private accessKey;
    private secretKey;
    private region;
    constructor();
    scheduled(): Promise<void>;
    runBackup(): Promise<{
        ok: boolean;
        file?: string;
        size?: number;
        error?: string;
    }>;
    private uploadToS3;
    triggerManual(): Promise<{
        ok: boolean;
        file?: string;
        size?: number;
        error?: string;
    }>;
}
