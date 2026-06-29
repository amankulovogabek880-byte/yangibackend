export declare class UploadsService {
}
export declare class UploadsController {
    uploadOne(file: Express.Multer.File, u: any): {
        url: string;
        filename: string;
        originalName: string;
        mimeType: string;
        size: number;
        type: string;
    };
    uploadBatch(files: Express.Multer.File[], u: any): {
        count: number;
        files: {
            url: string;
            filename: string;
            originalName: string;
            mimeType: string;
            size: number;
            type: string;
        }[];
    };
}
export declare class UploadsModule {
}
