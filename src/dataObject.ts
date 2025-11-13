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
    MasterDataObjectBinding,
    SortConfig,
    GroupByConfig
} from './types';
import { EventEmitter } from './eventEmitter';
import { NamedEventEmitter } from './namedEventEmitter';
import { DataObjectState } from './dataObjectState';
import { MasterBinding } from './masterBinding';

export interface DataObjectErrorHandler {
    onError?: (error: string) => void;
    onWarning?: (warning: string) => void;
    onInfo?: (info: string) => void;
}

export class DataObject {
    private supabase: SupabaseClient;
    private _options: DataObjectOptions;
    private errorHandler?: DataObjectErrorHandler;
    private _name: string;
    private _readyPromise: Promise<void>;
    
    public data: DataObjectRecord[] = [];
    private _originalData: DataObjectRecord[] = [];
    private _pendingChanges: Map<any, Partial<DataObjectRecord>> = new Map();
    
    private eventEmitter = new EventEmitter<DataObjectRecord[]>();
    public readonly onDataChanged = this.eventEmitter.event;

    private lifeCycleEvents = new NamedEventEmitter<DataObjectEvents>();
    public readonly on = this.lifeCycleEvents.on.bind(this.lifeCycleEvents);
    public readonly off = this.lifeCycleEvents.off.bind(this.lifeCycleEvents);
    public readonly once = this.lifeCycleEvents.once.bind(this.lifeCycleEvents);

    private _currentRecord: DataObjectRecord | undefined;
    private _fields: DataObjectField[] = [];

    public state: DataObjectState;
    public masterBinding: MasterBinding | undefined;

    private _childDataObjects: DataObject[] = [];

    private _groupedData: {
        groupValue: any;
        records: DataObjectRecord[];
        aggregates: Record<string, number>;
    }[] = [];

    public get name(): string {
        return this._name;
    }

    public get recordCount(): number {
        return this.data.length;
    }

    public get currentRecord(): DataObjectRecord | undefined {
        return this._currentRecord;
    }

    public set currentRecord(record: DataObjectRecord | undefined) {
        if (this._currentRecord?.id === record?.id) return;

        const previousRecord = this._currentRecord;
        this._currentRecord = record;

        this.lifeCycleEvents.emit('currentRecordChanged', previousRecord, record);
        this.eventEmitter.fire(this.data);

        for (const child of this._childDataObjects) {
            if (!child.state.isDestroyed && child.state.isReady) {
                child.refresh().catch(err =>
                    console.warn(`Child refresh failed for ${child.name}:`, err)
                );
            }
        }
    }

    public get fields(): DataObjectField[] {
        return this._fields;
    }

    public get isReady(): boolean {
        return this.state.isReady;
    }

    public get hasChanges(): boolean {
        return this._pendingChanges.size > 0;
    }

    public get whereClauses(): WhereClause[] {
        return this._options.whereClauses || [];
    }

    public set whereClauses(whereClauses: WhereClause[]) {
        this.options.whereClauses = whereClauses;
        this.refresh();
    }

    public get masterDataObject(): DataObject | undefined {
        return this.masterBinding?.masterDataObject;
    }

    public get childDataObjects(): ReadonlyArray<DataObject> {
        return this._childDataObjects;
    }

    public get options(): DataObjectOptions {
        return this._options;
    }

    public get groupedData() {
        return this._groupedData;
    }

    constructor(
        supabaseConfig: SupabaseConfig, 
        options: DataObjectOptions, 
        name: string,
        errorHandler?: DataObjectErrorHandler
    ) {
        this.supabase = createClient(supabaseConfig.url, supabaseConfig.anonKey);
        this._options = this.setDefaultOptions(options);
        this.errorHandler = errorHandler;
        this._name = name;
        this.state = new DataObjectState();
        this._readyPromise = this.initializeDataObject();
    }

    private async initializeDataObject(): Promise<void> {
        await this.inferFields();
        if (this.options.masterDataObjectBinding) {
            this.masterBinding = new MasterBinding(
                this,
                this.options.masterDataObjectBinding,
                this.errorHandler
            )
            await this.masterBinding.initialize();
        }
        
        if (this.options.autoRefresh) {
            await this.loadData();
        }
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

    /**
     * Loads data from Supabase with the given parameters defined when creating data object.
     */
    private async loadData(): Promise<void> {
        const cancelToken: DataObjectCancelableEvent & DataObjectOptions = {
            ...this.options,
            cancel: () => { cancelToken.cancelEvent = true; },
            cancelEvent: false,
        };
        this.lifeCycleEvents.emit('beforeLoad', cancelToken);

        if (cancelToken.cancelEvent) { return; }
        try {
            this.state.isRefreshing = true;
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
                         case 'isnull':
                            query = query.is(whereClause.field, null);
                            break;
                        case 'isnotnull':
                            query = query.not(whereClause.field, 'is', null);
                            break;
                    }
                }
            }
            
            // Apply master binding where clause if it exists
            if (this.masterBinding) {
                const bindingWhereClause = this.masterBinding.bindingWhereClause;
                if (!bindingWhereClause || bindingWhereClause.value === undefined || bindingWhereClause.value === null) {
                    this.data = [];
                    this._originalData = [];
                    this._pendingChanges.clear();
                    this.currentRecord = undefined;
                    this.state.isReady = true;
                    this.lifeCycleEvents.emit('afterLoad', this.data);
                    return;
                }

                query = query.eq(bindingWhereClause.field, bindingWhereClause.value);
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
                this.state.isReady = true; // Mark as ready even if there's an error
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
            
            this.applyGrouping();

            this.currentRecord = data.length > 0 ? this.data[0] : undefined;
            
            this.eventEmitter.fire(this.data);
            this.lifeCycleEvents.emit('afterLoad', this.data);
        } catch (error) {
            this.handleError(`Error loading data: ${error}`);
        } finally {
            this.state.isReady = true;
            this.state.isRefreshing = false;
        }
    }

    /**
     * Fetches data created in loadData() method.
     * @returns an array of DataObjectRecords
     */
    public getData(): DataObjectRecord[] {
        return [...this.data];
    }
    
    /**
     * Refresh data to get the latest state. 
     */
    public async refresh(): Promise<void> {
        if (this.state.isRefreshing) { return; }
        this.state.isRefreshing = true;
        try {
            const refreshToken: DataObjectCancelableEvent & DataObjectOptions = {
                ...this.options,
                cancel: () => { refreshToken.cancelEvent = true; },
                cancelEvent: false,
            };
            this.lifeCycleEvents.emit('beforeRefresh', refreshToken);
            if (refreshToken.cancelEvent) { return; }
    
            await this.loadData();
    
            this.lifeCycleEvents.emit('afterRefresh', this.data);
        } catch (err) {
            this.handleError(`Error refreshing data object ${this.name}: ${err}`);
        } finally {
            this.state.isRefreshing = false;
        }
    }

    private applyGrouping(): void {
        const { groupBy } = this.options;
        if (!groupBy || !groupBy.field) {
            this._groupedData = [];
            // this.handleWarning('No groupByConfig found for dataObject.')
            return;
        }

        const groups: Record<string, DataObjectRecord[]> = {};
        for (const record of this.data) {
            const key = record[groupBy.field];
            if (!groups[key]) groups[key] = [];
            groups[key].push(record);
        }

        const results = Object.entries(groups).map(([groupValue, records]) => {
            const aggregates: Record<string, number> = {};

            if (groupBy.aggregates) {
                for (const [alias, { op, field }] of Object.entries(groupBy.aggregates)) {
                    const values = field ? records.map(r => Number(r[field])) : [];

                    switch (op) {
                        case 'sum':
                            aggregates[alias] = values.reduce((a, b) => a + (b || 0), 0);
                            break;
                        case 'avg':
                            aggregates[alias] = values.length
                            ? values.reduce((a, b) => a + (b || 0), 0) / values.length
                            : 0;
                            break;
                        case 'count':
                            aggregates[alias] = records.length;
                            break;
                        case 'min':
                            aggregates[alias] = Math.min(...values.filter(v => !isNaN(v)));
                            break;
                        case 'max':
                            aggregates[alias] = Math.max(...values.filter(v => !isNaN(v)));
                            break;
                        default:
                            this.handleWarning?.(`Unknown aggregate operation: ${op}`);
                    }
                }
            }

            return { groupValue, records, aggregates };
        });

        this._groupedData = results;
    }

    // #region CRUD

    /**
     * Creates a new record in Supabase from the record informaton specified.
     * Can only be called if a tableName is specified and canInsert is set to true.
     * @param record - An object of fields and values for the new record.
     * @returns true if insert is successful, false otherwise.
     */
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
            
            // TODO: option to set newly created record as currentRecord
            this.lifeCycleEvents.emit('afterInsert', data[0]);

            await this.refresh();
            this.handleInfo('Record inserted successfully');
            return true;
        } catch (error) {
            this.handleError(`Error inserting record: ${error}`);
            return false;
        }
    }

    /**
     * Updates a record in Supabase with the updates supplied.
     * Can only be called if a tableName is provided and canUpdate is set to true.
     * @param id - The id of the record to update
     * @param updates - An object of fields and subsequent values to update
     * @param skipRefresh - When set to true, the data object will not refresh after updating. Default is false
     * @returns true if update was successful, false otherwise.
     */
    public async update(
        id: any, 
        updates: Partial<DataObjectRecord>, 
        skipRefresh: boolean = false
    ): Promise<boolean> {
        if (!this.options.canUpdate || !this.options.tableName) {
            this.handleWarning('Update operation is not allowed for this data object.');
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
            this.state.isUpdating = true;
            const { error } = await this.supabase
                .from(this.options.tableName)
                .update(updates)
                .eq('id', id);

            if (error) {
                this.handleError(`Error updating record: ${error.message}`);
                return false;
            }
            
            if (!skipRefresh) {
                await this.refresh();
            }

            const updatedRecord = this.data.find(x => x.id === id);
            if (updatedRecord) {
                this.lifeCycleEvents.emit('afterUpdate', updatedRecord, updates);
            }
            this.handleInfo('Record updated successfully');
            return true;
        } catch (error) {
            this.handleError(`Error updating record: ${error}`);
            return false;
        } finally {
            this.state.isUpdating = false;
        }
    }

    /**
     * Method for deleting a record from Supabase. 
     * Can only be called if a tableName is provided and canDelete is set to true.
     * @param id - The id of the record to delete
     * @returns true if delete was successful, false otherwise.
     */
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

    /**
     * Saves all pending changes in parallel to Supabase using the update() method, then refreshes data object.
     * Can only be done if a tableName is specified and canUpdate is true.
     */
    public async saveChanges(): Promise<void> {
        if (this._pendingChanges.size === 0) {
            this.handleInfo("No changes to save.");
            return;
        }

        if (!this.options.canUpdate || !this.options.tableName) {
            this.handleWarning('Update operation is not allowed for this data object.');
            return;
        }

        const pendingEntries = Array.from(this._pendingChanges.entries());

        try {
            this.state.isSaving = true;
            await Promise.all(
                pendingEntries.map(([id, updates]) => this.update(id, updates, true))
            );

            await this.refresh();

            this._pendingChanges.clear();
            this._originalData = JSON.parse(JSON.stringify(this.data));

            this.handleInfo("All changes saved successfully.");
        } catch (error) {
            this.handleError(`Error saving changes: ${error}`);
        } finally {
            this.state.isSaving = false;
        }
    }

    /**
     * Clears all pending changes and returns the data object to its original state.
     */
    public cancelChanges(): void {
        if (this._pendingChanges.size === 0) {
            this.handleInfo("No changes to revert.");
            return;
        }
        this.data = JSON.parse(JSON.stringify(this._originalData))
            .map((record: DataObjectRecord) => this.createReactiveRecord(record));

        this._pendingChanges.clear();
        this.eventEmitter.fire(this.data);
        this.handleInfo("All changes reverted.");
    }

    // #region Helpers

    /**
     * Helper function to wrap data object records in a reactive proxy and listen for changes.
     * @param record - DataObjectRecord to create proxy for
     * @returns Proxy of DataObjectRecord passed through
     */
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
                    this.currentRecord = record;
                    this.eventEmitter.fire(this.data);
                }
                return true;
            }
        };

        return new Proxy(record, handler);
    }

    /**
     * Gets the options defined for the created data object.
     */
    public getOptions(): DataObjectOptions {
        return { ...this.options };
    }

    /**
     * Adds a new data object to this data object's childDataObjects array.
     * @param child - The data object to add as a child to this one.
     */
    public registerChildDataObject(child: DataObject): void {
        if (!this._childDataObjects.includes(child)) {
            this._childDataObjects.push(child);
        }
    }

    /**
     * Removes a data object from this data object's childDataObjects array.
     * @param child - The data object to remove.
     */
    public unregisterChildDataObject(child: DataObject): void {
        this._childDataObjects = this._childDataObjects.filter(c => c !== child);
    }

    /**
     * Infers data objects fields to be added to fields array.
     * If no fields have been provided in DataObjectOptions then all fields from the provided table will be used. 
     */
    private async inferFields(): Promise<void> {
        if (this.options.fields && this.options.fields.length > 0) {
            this._fields = this.options.fields;
        } else {
            const { data } = await this.supabase.from(this.options.viewName).select('*').limit(1);
            if (data && data.length > 0) {
                this._fields = Object.keys(data[0]).map(key => ({ name: key, type: undefined }));
            }
        }
    }

    /**
     * Sets defaults for DataObjectOptions based on other options defined.
     * @param options - The DataObjectOptions for which to perform the operation on
     * @returns DataObjectOptions with potential changes based on other option values
     */
    private setDefaultOptions(options: DataObjectOptions): DataObjectOptions {
        return {
            ...options,
            whereClauses: options.whereClauses ? options.whereClauses : [],
            recordLimit: options.recordLimit ?? 100,
            canInsert: options.tableName ? (options.canInsert ?? false) : false,
            canUpdate: options.tableName ? (options.canUpdate ?? false) : false,
            canDelete: options.tableName ? (options.canDelete ?? false) : false,
            autoRefresh: options.autoRefresh ?? true
        };
    }

    /**
     * Update the sort applied to the data. When set, will trigger a refresh.
     * @param sort - The new sort to be applied to the data object.
     */
    public updateSort(sort: SortConfig) {
        this.options.sort = sort;
        this.refresh();
    }

    /** Set a new groupBy config on the dataObject to update groupedData. */
    public setGroupBy(config: GroupByConfig) {
        this.options.groupBy = config;
        this.applyGrouping();
    }

    /**
     * Helper method to dispose of a data object in order to prevent memory leaks.
     * Disposes of all child data objects and resets state to default.
     */
    public dispose(): void {
        if (this.state.isDestroyed) return;
        this.state.isDestroyed = true;

        if (this.masterBinding) {
            this.masterBinding?.dispose();
            this.masterBinding = undefined;
        }

        if (this.masterDataObject) {
            this.masterDataObject.unregisterChildDataObject(this);
        }

        this.masterDataObject?.unregisterChildDataObject(this);
        for (const child of this._childDataObjects) child.dispose();
        this._childDataObjects = [];

        this.eventEmitter.dispose();
        this.lifeCycleEvents.clearAll();

        this.data = [];
        this._originalData = [];
        this._pendingChanges.clear();
        this._currentRecord = undefined;

        this.state.reset();
    }

    /**
     * Fetches the SupabaseClient defined for the data object.
     */
    public getSupabaseClient(): SupabaseClient {
        return this.supabase;
    }
}

export async function createDataObject(
    supabaseConfig: SupabaseConfig, 
    options: DataObjectOptions, 
    name: string,
    errorHandler?: DataObjectErrorHandler
): Promise<DataObject> {
    return new DataObject(supabaseConfig, options, name, errorHandler);
}
