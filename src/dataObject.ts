import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DataObjectOptions, DataObjectRecord, SupportedOperator, WhereClause, SupabaseConfig, DataObjectEvents, DataObjectCancelableEvent } from './types';
import { EventEmitter } from './eventEmitter';
import { NamedEventEmitter } from './namedEventEmitter';

export interface DataObjectErrorHandler {
    onError?: (error: string) => void;
    onWarning?: (warning: string) => void;
    onInfo?: (info: string) => void;
}

export class DataObject {
    private supabase: SupabaseClient;
    private options: DataObjectOptions;
    private data: DataObjectRecord[] = [];
    private errorHandler?: DataObjectErrorHandler;
    private _isReady: boolean = false;
    private _readyPromise: Promise<void>;
    
    private eventEmitter = new EventEmitter<DataObjectRecord[]>();
    public readonly onDataChanged = this.eventEmitter.event;

    private lifeCycleEvents = new NamedEventEmitter<DataObjectEvents>();
    public readonly on = this.lifeCycleEvents.on.bind(this.lifeCycleEvents);

    private _currentRecord: DataObjectRecord | undefined;

    public get recordCount(): number {
        return this.data.length;
    }

    public get currentRecord(): DataObjectRecord | undefined {
        return this._currentRecord;
    }

    constructor(supabaseConfig: SupabaseConfig, options: DataObjectOptions, errorHandler?: DataObjectErrorHandler) {
        this.supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
        this.options = this.setDefaultOptions(options);
        this.errorHandler = errorHandler;
        this._readyPromise = this.loadData();
    }

    public get isReady(): boolean {
        return this._isReady;
    }

    public async waitForReady(): Promise<void> {
        await this._readyPromise;
    }

    private handleError(message: string): void {
        if (this.errorHandler?.onError) {
            this.errorHandler.onError(message);
        } else {
            console.error(message);
        }
    }

    private handleWarning(message: string): void {
        if (this.errorHandler?.onWarning) {
            this.errorHandler.onWarning(message);
        } else {
            console.warn(message);
        }
    }

    private handleInfo(message: string): void {
        if (this.errorHandler?.onInfo) {
            this.errorHandler.onInfo(message);
        } else {
            console.info(message);
        }
    }

    private async loadData(): Promise<void> {
        const cancelToken: DataObjectCancelableEvent & DataObjectOptions = {
            ...this.options,
            cancel: () => { cancelToken.cancelEvent = true; },
            cancelEvent: false,
        };
        this.lifeCycleEvents.emit('beforeLoad', cancelToken);

        if (cancelToken.cancelEvent) { return; }
        try {
            // Start with base query
            let query: any = this.supabase.from(this.options.viewName);

            // Apply select fields
            if (this.options.fields && this.options.fields.length > 0) {
                const fieldNames = this.options.fields.map(f => f.name).join(',');
                query = query.select(fieldNames);
            } else {
                query = query.select('*');
            }

            // Apply where clauses
            if (this.options.whereClauses) {
                for (const whereClause of this.options.whereClauses) {
                    switch (whereClause.operator) {
                        case 'equals':
                            query = query.eq(whereClause.field, whereClause.value);
                            break;
                        case 'notequals':
                            query = query.neq(whereClause.field, whereClause.value);
                            break;
                        case 'greaterthan':
                            query = query.gt(whereClause.field, whereClause.value);
                            break;
                        case 'lessthan':
                            query = query.lt(whereClause.field, whereClause.value);
                            break;
                    }
                }
            }

            // Apply sorting
            if (this.options.sort) {
                query = query.order(this.options.sort.field, { 
                    ascending: this.options.sort.direction === 'asc' 
                });
            }

            // Apply record limit
            if (this.options.recordLimit) {
                query = query.limit(this.options.recordLimit);
            }

            const { data, error } = await query;

            if (error) {
                this.handleError(`Error loading data: ${error.message}`);
                this._isReady = true; // Mark as ready even if there's an error
                return;
            }

            this.data = data || [];

            if (data.length > 0) {
                this._currentRecord = data[0];
            }
            
            this.eventEmitter.fire(this.data);
            this.lifeCycleEvents.emit('afterLoad', this.data);
        } catch (error) {
            this.handleError(`Error loading data: ${error}`);
        } finally {
            this._isReady = true; // Mark as ready even if there's an error
        }
    }

    public getData(): DataObjectRecord[] {
        return [...this.data];
    }

    public async refresh(): Promise<void> {
        const refreshToken: DataObjectCancelableEvent & DataObjectOptions = {
            ...this.options,
            cancel: () => { refreshToken.cancelEvent = true; },
            cancelEvent: false,
        };
        this.lifeCycleEvents.emit('beforeRefresh', refreshToken);
        if (refreshToken.cancelEvent) { return; }

        await this.loadData();

        this.lifeCycleEvents.emit('afterRefresh', this.data);
    }

    public async insert(record: Partial<DataObjectRecord>): Promise<boolean> {
        if (!this.options.canInsert || !this.options.tableName) {
            this.handleWarning('Insert operation is not allowed for this data object');
            return false;
        }

        const insertToken: DataObjectCancelableEvent & DataObjectOptions = {
            ...this.options,
            cancel: () => { insertToken.cancelEvent = true; },
            cancelEvent: false,
        };
        this.lifeCycleEvents.emit('beforeInsert', insertToken, record);
        if (insertToken.cancelEvent) { return false; }

        try {
            const { data, error } = await this.supabase
                .from(this.options.tableName)
                .insert(record)
                .select();

            if (error) {
                this.handleError(`Error inserting record: ${error.message}`);
                return false;
            }

            this.lifeCycleEvents.emit('afterInsert', data[0]);

            // Refresh data to get the latest state
            await this.refresh();
            this.handleInfo('Record inserted successfully');
            return true;
        } catch (error) {
            this.handleError(`Error inserting record: ${error}`);
            return false;
        }
    }

    public async update(id: any, updates: Partial<DataObjectRecord>): Promise<boolean> {
        if (!this.options.canUpdate || !this.options.tableName) {
            this.handleWarning('Update operation is not allowed for this data object');
            return false;
        }
        
        const record = this.data.find(x => x.id === id);
        if (!record) { return false; }

        const updateToken: DataObjectCancelableEvent & DataObjectOptions = {
            ...this.options,
            cancel: () => { updateToken.cancelEvent = true; },
            cancelEvent: false,
        };
        this.lifeCycleEvents.emit('beforeUpdate', updateToken, record, updates);
        if (updateToken.cancelEvent) { return false; }

        try {
            const { error } = await this.supabase
                .from(this.options.tableName)
                .update(updates)
                .eq('id', id);

            if (error) {
                this.handleError(`Error updating record: ${error.message}`);
                return false;
            }

            
            // Refresh data to get the latest state
            await this.refresh();

            const updatedRecord = this.data.find(x => x.id === id);
            if (updatedRecord) {
                this.lifeCycleEvents.emit('afterUpdate', updatedRecord, updates);
            }
            this.handleInfo('Record updated successfully');
            return true;
        } catch (error) {
            this.handleError(`Error updating record: ${error}`);
            return false;
        }
    }

    public async delete(id: any): Promise<boolean> {
        if (!this.options.canDelete || !this.options.tableName) {
            this.handleWarning('Delete operation is not allowed for this data object');
            return false;
        }

        const record = this.data.find(x => x.id === id);
        if (!record) { return false; }

        const deleteToken: DataObjectCancelableEvent & DataObjectOptions = {
            ...this.options,
            cancel: () => { deleteToken.cancelEvent = true; },
            cancelEvent: false,
        };
        this.lifeCycleEvents.emit('beforeDelete', deleteToken, record);
        if (deleteToken.cancelEvent) { return false; }

        try {
            const { error } = await this.supabase
                .from(this.options.tableName)
                .delete()
                .eq('id', id);

            if (error) {
                this.handleError(`Error deleting record: ${error.message}`);
                return false;
            }

            // Refresh data to get the latest state
            await this.refresh();
            this.lifeCycleEvents.emit('afterDelete', id);
            this.handleInfo('Record deleted successfully');
            return true;
        } catch (error) {
            this.handleError(`Error deleting record: ${error}`);
            return false;
        }
    }

    public dispose(): void {
        this.eventEmitter.dispose();
        this.lifeCycleEvents.clearAll();
    }

    public getOptions(): DataObjectOptions {
        return { ...this.options };
    }

    private setDefaultOptions(options: DataObjectOptions): DataObjectOptions {
        return {
            ...options,
            recordLimit: options.recordLimit ?? 100,
            canInsert: options.tableName ? (options.canInsert ?? false) : false,
            canUpdate: options.tableName ? (options.canUpdate ?? false) : false,
            canDelete: options.tableName ? (options.canDelete ?? false) : false,
        };
    }

    public getSupabaseClient(): SupabaseClient {
        return this.supabase;
    }
}

export async function createDataObject(
    supabaseConfig: SupabaseConfig, 
    options: DataObjectOptions, 
    errorHandler?: DataObjectErrorHandler
): Promise<DataObject> {
    return new DataObject(supabaseConfig, options, errorHandler);
}
