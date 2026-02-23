import { DataObjectErrorHandler } from "./dataObject";
import { SupabaseClient } from '@supabase/supabase-js';


export class DataObjectStorage {
    private _dataObjectName: string;
    private _allowedBuckets: string[] = [];
    private _errorHandler?: DataObjectErrorHandler;
    private _supabaseStorage: SupabaseClient['storage'];

    constructor(
        dataObjectName: string,
        storage: SupabaseClient['storage'],
        allowedBuckets?: string[],
        errorHandler?: DataObjectErrorHandler
    ) {
        this._dataObjectName = dataObjectName;
        this._supabaseStorage = storage;
        this._allowedBuckets = allowedBuckets ?? [];
        this._errorHandler = errorHandler;
    }

    /** Checks for existence of the specified bucket in the allowedBuckets array. */
    private assertBucketAllowed(bucket: string): boolean {
        if (this._allowedBuckets.length == 0) { return true; }
        if (!this._allowedBuckets.includes(bucket)) {
            if (this._errorHandler?.onError) {
                this._errorHandler?.onError(`Bucket "${bucket}" is not allowed to upload for DataObject "${this._dataObjectName}".`)
            }
            return false;
        }
        return true;
    }

    public async uploadToBucket(
        bucket: string,
        filePath: string,
        file: Blob | File,
        options?: {
            contentType?: string;
            upsert?: boolean;
        }
    ): Promise<void> {
        if (this.assertBucketAllowed(bucket)) {
            const { error } = await this._supabaseStorage
                .from(bucket)
                .upload(filePath, file, {
                    contentType: options?.contentType,
                    upsert: options?.upsert ?? true
                });
    
            if (error) {
                if (this._errorHandler) {
                    this._errorHandler?.onError?.(error.message);
                }
            }
        }
    }

    public async deleteFromBucket(
        bucket: string,
        filePath: string
    ): Promise<void> {
        if (this.assertBucketAllowed(bucket)) {
            const { error } = await this._supabaseStorage
                .from(bucket)
                .remove([filePath]);
    
            if (error) {
                if (this._errorHandler) {
                    this._errorHandler?.onError?.(error.message);
                }
            }
        }
    }

    public getPublicUrl(bucket: string, filePath: string): string | null {
        if (this.assertBucketAllowed(bucket)) {
            const { data } = this._supabaseStorage
                .from(bucket)
                .getPublicUrl(filePath);

            return data.publicUrl;
        } else {
            return null;
        }
    }

    //** Uploads to specified bucket and returns public url. */
    public async uploadAndGetUrl(
        bucket: string, 
        filePath: string, 
        file: Blob | File, 
        options?: { contentType?: string; upsert?: boolean }
    ): Promise<string | null> {
        await this.uploadToBucket(bucket, filePath, file, options);
        return this.getPublicUrl(bucket, filePath);
    }
}