import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { 
    DataObjectOptions, 
    DataObjectRecord, 
    SupportedOperator, 
    WhereClause, 
    SupabaseConfig, 
    DataObjectEvents, 
    DataObjectCancelableEvent,
    DataObjectField,
    MasterDataObjectBinding
} from './types';
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
    private errorHandler?: DataObjectErrorHandler;
    private _isReady: boolean = false;
    private _readyPromise: Promise<void>;
    
    public data: DataObjectRecord[] = [];
    private _originalData: DataObjectRecord[] = [];
    private _pendingChanges: Map<any, Partial<DataObjectRecord>> = new Map();
    
    private eventEmitter = new EventEmitter<DataObjectRecord[]>();
    public readonly onDataChanged = this.eventEmitter.event;

    private lifeCycleEvents = new NamedEventEmitter<DataObjectEvents>();
    public readonly on = this.lifeCycleEvents.on.bind(this.lifeCycleEvents);

    private _currentRecord: DataObjectRecord | undefined;
    private _fields: DataObjectField[] = [];
    
    // Master data object binding properties
    private masterDataObject: DataObject | null = null;
    private masterDataObjectBinding: MasterDataObjectBinding | null = null;
    private masterDataChangeListener: (() => void) | null = null;

    public get recordCount(): number {
        return this.data.length;
    }

    public get currentRecord(): DataObjectRecord | undefined {
        return this._currentRecord;
    }

    public get fields(): DataObjectField[] {
        return this._fields;
    }

    public get isReady(): boolean {
        return this._isReady;
    }

    public get hasChanges(): boolean {
        return this._pendingChanges.size > 0;
    }

    constructor(
        supabaseConfig: SupabaseConfig, 
        options: DataObjectOptions, 
        errorHandler?: DataObjectErrorHandler
    ) {
        this.supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
        this.options = this.setDefaultOptions(options);
        this.errorHandler = errorHandler;
        this._readyPromise = this.initializeDataObject();
    }

    private async initializeDataObject(): Promise<void> {
        if (this.options.masterDataObjectBinding) {
            await this.setupMasterDataObjectBinding(this.options.masterDataObjectBinding);
        }
        
        await this.loadData();
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

    // #region Load Operations
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
                this._fields = this.options.fields;
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

            // assign raw data first
            const rawData = data || [];

            // create a deep clone of data
            this._originalData = JSON.parse(JSON.stringify(rawData));

            // clear any previous change tracking
            this._pendingChanges.clear();

            // wrap each record in a reactive Proxy
            this.data = rawData.map((record: DataObjectRecord) => this.createReactiveRecord(record));

            if (data.length > 0) {
                // Set currentRecord to first record
                this._currentRecord = this.data[0];
                
                // Infer and set fields
                if (!this.options.fields || this.options.fields.length === 0) {
                    this._fields = Object.keys(this._currentRecord).map(key => ({
                        name: key,
                        type: undefined
                    }));
                }
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

    // #region CRUD
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

    public async saveChanges(): Promise<void> {
        if (this._pendingChanges.size === 0) {
            this.handleInfo("No changes to save.");
            return;
        }

        if (!this.options.tableName) {
            this.handleWarning("No tableName specified — cannot save changes.");
            return;
        }

        for (const [id, updates] of this._pendingChanges.entries()) {
            await this.update(id, updates);
        }

        this._pendingChanges.clear();
        this._originalData = JSON.parse(JSON.stringify(this.data));
        this.handleInfo("All changes saved successfully.");
    }

    public cancelChanges(): void {
        this.data = JSON.parse(JSON.stringify(this._originalData))
            .map((record: DataObjectRecord) => this.createReactiveRecord(record));

        this._pendingChanges.clear();
        this.eventEmitter.fire(this.data);
        this.handleInfo("All changes reverted.");
    }

    // #region Master Binding
    // TODO: Move this to different file
    private async setupMasterDataObjectBinding(binding: MasterDataObjectBinding): Promise<void> {
        try {
            // Get the master data object from the manager
            const masterDataObject = await this.getMasterDataObjectFromManager(binding.masterDataObjectId);
            
            if (!masterDataObject) {
                // Silently fail as requested
                return;
            }

            // Wait for master data object to be ready
            await masterDataObject.waitForReady();

            // Validate binding fields
            if (!this.validateBindingFields(binding, masterDataObject)) {
                // Silently fail as requested
                return;
            }

            // Set up the binding
            this.masterDataObject = masterDataObject;
            this.masterDataObjectBinding = binding;

            // Add the initial where clause based on master's current record
            this.addMasterBindingWhereClause();

            // Set up listener for master data object changes
            this.setupMasterDataChangeListener();

            this.handleInfo(`Master data object binding established with '${binding.masterDataObjectId}'`);
        } catch (error) {
            // Silently fail as requested
            this.handleWarning(`Failed to setup master data object binding: ${error}`);
        }
    }

    private async getMasterDataObjectFromManager(masterDataObjectId: string): Promise<DataObject | null> {
        try {
            // Import DataObjectManager dynamically to avoid circular dependency
            const { DataObjectManager } = await import('./dataObjectManager');
            const manager = DataObjectManager.getInstance();
            return manager.getDataObjectById(masterDataObjectId);
        } catch (error) {
            return null;
        }
    }

    private validateBindingFields(binding: MasterDataObjectBinding, masterDataObject: DataObject): boolean {
        // Check if child binding field exists in this data object's fields
        const childFieldExists = this._fields.some(field => field.name === binding.childBindingField);
        if (!childFieldExists) {
            return false;
        }

        // Check if master binding field exists in master data object's fields
        const masterFields = masterDataObject.fields;
        const masterFieldExists = masterFields.some(field => field.name === binding.masterBindingField);
        if (!masterFieldExists) {
            return false;
        }

        return true;
    }

    private addMasterBindingWhereClause(): void {
        if (!this.masterDataObject || !this.masterDataObjectBinding) {
            return;
        }

        const masterCurrentRecord = this.masterDataObject.currentRecord;
        if (!masterCurrentRecord) {
            return;
        }

        const masterFieldValue = masterCurrentRecord[this.masterDataObjectBinding.masterBindingField];
        if (masterFieldValue === undefined || masterFieldValue === null) {
            return;
        }

        // Remove any existing binding where clause
        this.removeMasterBindingWhereClause();

        // Add new where clause
        const bindingWhereClause: WhereClause = {
            field: this.masterDataObjectBinding.childBindingField,
            operator: 'equals',
            value: masterFieldValue
        };

        if (!this.options.whereClauses) {
            this.options.whereClauses = [];
        }

        this.options.whereClauses.push(bindingWhereClause);
    }

    private removeMasterBindingWhereClause(): void {
        if (!this.masterDataObjectBinding || !this.options.whereClauses) {
            return;
        }

        // Remove where clauses that match the child binding field
        this.options.whereClauses = this.options.whereClauses.filter(
            clause => clause.field !== this.masterDataObjectBinding!.childBindingField
        );
    }

    private setupMasterDataChangeListener(): void {
        if (!this.masterDataObject) {
            return;
        }

        this.masterDataChangeListener = () => {
            this.onMasterDataChanged();
        };

        this.masterDataObject.onDataChanged(this.masterDataChangeListener);
    }

    private async onMasterDataChanged(): Promise<void> {
        if (!this.masterDataObject || !this.masterDataObjectBinding) {
            return;
        }

        // Update the where clause with new master field value
        this.addMasterBindingWhereClause();

        // Refresh this data object with the new where clause
        await this.refresh();
    }

    // #region Helpers
    private createReactiveRecord(record: DataObjectRecord): DataObjectRecord {
        const handler: ProxyHandler<DataObjectRecord> = {
            set: (target, prop, value) => {
                const key = prop as keyof DataObjectRecord;

                // Only track if value actually changed
                if (target[key] !== value) {
                    target[key] = value;
                    if (!this._pendingChanges.has(target.id)) {
                        this._pendingChanges.set(target.id, {});
                    }
                    const pending = this._pendingChanges.get(target.id)!;
                    pending[key] = value;
                    
                    this.lifeCycleEvents.emit('fieldChanged', record, pending);
                    this.eventEmitter.fire(this.data);
                }
                return true;
            }
        };

        return new Proxy(record, handler);
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

    public dispose(): void {
        // Clean up master data object binding
        if (this.masterDataChangeListener && this.masterDataObject) {
            this.masterDataObject.onDataChanged(this.masterDataChangeListener);
        }
        
        this.eventEmitter.dispose();
        this.lifeCycleEvents.clearAll();
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
