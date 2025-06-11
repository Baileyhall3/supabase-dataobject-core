import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { DataObjectOptions, DataObjectRecord, SupportedOperator, WhereClause, SupabaseConfig } from './types';
import { EventEmitter } from './eventEmitter';

export interface DataObjectErrorHandler {
    onError?: (error: string) => void;
    onWarning?: (warning: string) => void;
    onInfo?: (info: string) => void;
}

export class DataObject {
    private supabase: SupabaseClient;
    private options: DataObjectOptions;
    private data: DataObjectRecord[] = [];
    private eventEmitter = new EventEmitter<DataObjectRecord[]>();
    private errorHandler?: DataObjectErrorHandler;
    
    public readonly onDataChanged = this.eventEmitter.event;

    constructor(supabaseConfig: SupabaseConfig, options: DataObjectOptions, errorHandler?: DataObjectErrorHandler) {
        this.supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
        this.options = options;
        this.errorHandler = errorHandler;
        this.loadData();
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
                return;
            }

            this.data = data || [];
            this.eventEmitter.fire(this.data);
        } catch (error) {
            this.handleError(`Error loading data: ${error}`);
        }
    }

    public getData(): DataObjectRecord[] {
        return [...this.data];
    }

    public async refresh(): Promise<void> {
        await this.loadData();
    }

    public async insert(record: Partial<DataObjectRecord>): Promise<boolean> {
        if (!this.options.canInsert) {
            this.handleWarning('Insert operation is not allowed for this data object');
            return false;
        }

        try {
            const { data, error } = await this.supabase
                .from(this.options.viewName)
                .insert(record)
                .select();

            if (error) {
                this.handleError(`Error inserting record: ${error.message}`);
                return false;
            }

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
        if (!this.options.canUpdate) {
            this.handleWarning('Update operation is not allowed for this data object');
            return false;
        }

        try {
            const { error } = await this.supabase
                .from(this.options.viewName)
                .update(updates)
                .eq('id', id);

            if (error) {
                this.handleError(`Error updating record: ${error.message}`);
                return false;
            }

            // Refresh data to get the latest state
            await this.refresh();
            this.handleInfo('Record updated successfully');
            return true;
        } catch (error) {
            this.handleError(`Error updating record: ${error}`);
            return false;
        }
    }

    public async delete(id: any): Promise<boolean> {
        if (!this.options.canDelete) {
            this.handleWarning('Delete operation is not allowed for this data object');
            return false;
        }

        try {
            const { error } = await this.supabase
                .from(this.options.viewName)
                .delete()
                .eq('id', id);

            if (error) {
                this.handleError(`Error deleting record: ${error.message}`);
                return false;
            }

            // Refresh data to get the latest state
            await this.refresh();
            this.handleInfo('Record deleted successfully');
            return true;
        } catch (error) {
            this.handleError(`Error deleting record: ${error}`);
            return false;
        }
    }

    public dispose(): void {
        this.eventEmitter.dispose();
    }

    public getOptions(): DataObjectOptions {
        return { ...this.options };
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
