import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { 
    DataObjectOptions, 
    DataObjectRecord, 
    SupportedOperator, 
    WhereClause, 
    DataObjectEvents, 
    DataObjectCancelableEvent,
    DataObjectField,
    MasterDataObjectBinding,
    SortConfig,
    GroupByConfig,
    DataRecordKey,
    RelationshipConfig
} from './types';
import { EventEmitter } from './eventEmitter';
import { NamedEventEmitter } from './namedEventEmitter';
import { DataObjectState } from './dataObjectState';
import { MasterBinding } from './masterBinding';
import { DataObjectStorage } from './dataObjectStorage';
import { DataRecord } from './dataRecord';

export interface DataObjectErrorHandler {
    onError?: (error: string) => void;
    onWarning?: (warning: string) => void;
    onInfo?: (info: string) => void;
}

export class DataObject<
  T extends DataRecordKey = DataRecordKey
> {
    private supabase: SupabaseClient;
    private _options: DataObjectOptions<T>;
    private errorHandler?: DataObjectErrorHandler;
    private _name: string;
    private _readyPromise: Promise<void>;
    
    public data: DataObjectRecord<T>[] = [];

    private eventEmitter = new EventEmitter<DataObjectRecord<T>[]>();
    public readonly onDataChanged = this.eventEmitter.event;

    private lifeCycleEvents = new NamedEventEmitter<DataObjectEvents<T>>();
    public readonly on = this.lifeCycleEvents.on.bind(this.lifeCycleEvents);
    public readonly off = this.lifeCycleEvents.off.bind(this.lifeCycleEvents);
    public readonly once = this.lifeCycleEvents.once.bind(this.lifeCycleEvents);

    private _currentRecord: DataObjectRecord<T> | undefined;
    private _fields: DataObjectField<T>[] = [];

    public state: DataObjectState;
    public masterBinding: MasterBinding<any, T> | undefined;
    public storage: DataObjectStorage;

    private _childDataObjects: DataObject<any>[] = [];

    private _groupedData: {
        groupValue: any;
        records: DataObjectRecord<T>[];
        aggregates: Record<string, number>;
        additionalFields: Record<string, any>;
    }[] = [];

    public get name(): string {
        return this._name;
    }

    public get recordCount(): number {
        return this.data.length;
    }

    public get currentRecord(): DataObjectRecord<T> | undefined {
        return this._currentRecord;
    }

    public set currentRecord(record: DataObjectRecord<T> | undefined) {
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

    public get fields(): DataObjectField<T>[] {
        return this._fields;
    }

    public get isReady(): boolean {
        return this.state.isReady;
    }

    public get changedRecords(): DataObjectRecord<T>[] {
        return this.data.filter(r => r.hasChanges);
    }

    public get hasChanges(): boolean {
        return this.data.some(r => r.hasChanges);
    }

    public get whereClauses(): WhereClause<T>[] {
        return this._options.whereClauses || [];
    }

    public set whereClauses(whereClauses: WhereClause<T>[]) {
        this.options.whereClauses = whereClauses;
        this.refresh();
    }

    public get masterDataObject(): DataObject | undefined {
        return this.masterBinding?.masterDataObject;
    }

    public get childDataObjects(): ReadonlyArray<DataObject> {
        return this._childDataObjects;
    }

    public get options(): DataObjectOptions<T> {
        return this._options;
    }

    public get relationships(): ReadonlyArray<RelationshipConfig> {
        return this._options.relationships || [];
    }

    public get groupedData() {
        return this._groupedData;
    }

    constructor(
        supabase: SupabaseClient, 
        options: DataObjectOptions<T>, 
        name: string,
        errorHandler?: DataObjectErrorHandler
    ) {
        this.supabase = supabase;
        this._options = this.setDefaultOptions(options);
        this.errorHandler = errorHandler;
        this._name = name;
        this.state = new DataObjectState();
        this.storage = new DataObjectStorage(
            name,
            this.supabase.storage,
            options.allowedBuckets,
            errorHandler
        )
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
        const cancelToken: DataObjectCancelableEvent & DataObjectOptions<T> = {
            ...this.options,
            cancel: () => { cancelToken.cancelEvent = true; },
            cancelEvent: false,
        };
        this.lifeCycleEvents.emit('beforeLoad', cancelToken);

        if (cancelToken.cancelEvent) { return; }
        try {
            this.state.isRefreshing = true;

            let query: any = this.buildQuery();
            const { data, error } = await query;

            if (error) {
                this.handleError(`Error loading data: ${error.message}`);
                this.state.isReady = true; // Mark as ready even if there's an error
                return;
            }

            // assign raw data first
            const rawData = data || [];

            // wrap each record in a reactive Proxy
            this.data = rawData.map((record: T) => this.createReactiveRecord(record));
            
            this.applyGrouping();

            this.currentRecord = rawData.length > 0 ? this.data[0] : undefined;
            
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
     * Refresh data to get the latest state. 
     */
    public async refresh(): Promise<void> {
        if (this.state.isRefreshing) { return; }
        this.state.isRefreshing = true;
        try {
            const refreshToken: DataObjectCancelableEvent & DataObjectOptions<T> = {
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

    /** Gets the newest version of a record from Supavase by its ID. */
    public async fetchRecordById(id: T["id"]): Promise<T | undefined> {
        const query = this.buildQuery()
            .eq("id", id)
            .limit(1);

        const { data, error } = await query;

        if (error) { throw error; }

        return data?.[0];
    }

    /** Refreshes a record by its ID. */
    public async refreshRecordById(id: T["id"]): Promise<void> {
        const record = this.data.find(r => r.id === id);

        if (!record) { return undefined; }

        record.refresh();
    }

    //** Apply groupBy to the data returned from loadData() and populate groupedData. */
    private applyGrouping(): void {
        const { groupBy } = this.options;
        if (!groupBy || !groupBy.field) {
            this._groupedData = [];
            return;
        }
        // TODO: Add handling for field not existing
        const groups: Record<string, DataObjectRecord<T>[]> = {};

        for (const record of this.data) {
            const rawKey = record[groupBy.field];
            const key = String(rawKey);
            if (!groups[key]) groups[key] = [];
            groups[key].push(record);
        }

        const results = Object.entries(groups).map(([groupValue, records]) => {
            const aggregates: Record<string, number> = {};

            if (groupBy.aggregates) {
                for (const [alias, { op, field }] of Object.entries(groupBy.aggregates)) {
                    const values = field
                        ? records.map(r => Number(r[field] as unknown))
                        : [];

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

            const additional: Partial<T> = {};
            if (groupBy.additionalFields && groupBy.additionalFields.length > 0) {
                const first = records[0];
                for (const f of groupBy.additionalFields) {
                    additional[f] = first?.[f];
                }
            }

            return { groupValue, records, aggregates, additionalFields: additional };
        });

        this._groupedData = results;
    }

    // #region CRUD

    /**
     * Creates a new record in Supabase.
     * @param record - Partial record to insert.
     * @returns The newly created DataObjectRecord, or null if insert fails.
     */
    public async insert(record: Partial<T>, setAsCurrent = true): Promise<DataObjectRecord<T> | null> {
        if (!this.options.canInsert || !this.options.tableName) {
            this.handleWarning('Insert operation is not allowed for this data object');
            return null;
        }

        const insertToken: DataObjectCancelableEvent & DataObjectOptions<T> = {
            ...this.options,
            cancel: () => { insertToken.cancelEvent = true; },
            cancelEvent: false,
        };

        this.lifeCycleEvents.emit('beforeInsert', insertToken, record);
        if (insertToken.cancelEvent) return null;

        try {
            const { data, error } = await this.supabase
                .from(this.options.tableName)
                .insert(record)
                .select();

            if (error || !data?.length) {
                this.handleError(`Error inserting record: ${error?.message ?? 'No data returned'}`);
                return null;
            }

            const newRecord = data[0];

            if (setAsCurrent) {
                this._currentRecord = newRecord;
            }

            this.lifeCycleEvents.emit('afterInsert', newRecord);

            await this.refresh();

            this.handleInfo('Record inserted successfully');

            return newRecord;
        } catch (err) {
            this.handleError(`Error inserting record: ${err}`);
            return null;
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
        id: T["id"], 
        updates: Partial<T>, 
        skipRefresh: boolean = false
    ): Promise<boolean> {
        if (this.state.isUpdating) { return false; }
        if (!this.options.canUpdate || !this.options.tableName) {
            this.handleWarning('Update operation is not allowed for this data object.');
            return false;
        }
        
        const record = this.data.find(x => x.id === id);
        if (!record) { return false; }

        const updateToken: DataObjectCancelableEvent & DataObjectOptions<T> = {
            ...this.options,
            cancel: () => { updateToken.cancelEvent = true; },
            cancelEvent: false,
        };
        this.lifeCycleEvents.emit('beforeUpdate', updateToken, record, updates);
        if (updateToken.cancelEvent) { return false; }

        try {
            this.state.isUpdating = true;
            // const { error } = await this.supabase
            //     .from(this.options.tableName)
            //     .update(updates)
            //     .eq('id', id);

            const { data, error } = await this.supabase
                .from(this.options.tableName)
                .update(updates)
                .eq('id', id)
                .select()
                .single();

            if (error) {
                this.handleError(`Error updating record: ${error.message}`);
                return false;
            }

            if (skipRefresh) {
                record.applyServerUpdates(data);
            } else {
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
    public async delete(id: T["id"]): Promise<boolean> {
        if (this.state.isDeleting) { return false; }
        if (!this.options.canDelete || !this.options.tableName) {
            this.handleWarning('Delete operation is not allowed for this data object');
            return false;
        }

        const record = this.data.find(x => x.id === id);
        if (!record) { return false; }

        const deleteToken: DataObjectCancelableEvent & DataObjectOptions<T> = {
            ...this.options,
            cancel: () => { deleteToken.cancelEvent = true; },
            cancelEvent: false,
        };

        this.lifeCycleEvents.emit('beforeDelete', deleteToken, record);
        if (deleteToken.cancelEvent) { return false; }

        try {
            this.state.isDeleting = true;
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
        } finally {
            this.state.isDeleting = false;
        }
    }

    // #region Bulk Operations

    /**
     * Creates new records in Supabase.
     * @param records - Partial records to insert.
     * @returns The newly created DataObjectRecords, or null if insert fails.
     */
    public async bulkInsert(records: Partial<T>[], setAsCurrent = true): Promise<DataObjectRecord<T> | null[] | null> {
        if (!this.options.canInsert || !this.options.tableName) {
            this.handleWarning('Bulk insert operation is not allowed for this data object');
            return null;
        }

        const insertToken: DataObjectCancelableEvent & DataObjectOptions<T> = {
            ...this.options,
            cancel: () => { insertToken.cancelEvent = true; },
            cancelEvent: false,
        };

        this.lifeCycleEvents.emit('beforeBulkInsert', insertToken, records);
        if (insertToken.cancelEvent) return null;

        try {
            const { data, error } = await this.supabase
                .from(this.options.tableName)
                .insert(records)
                .select();

            if (error || !data?.length) {
                this.handleError(`Error inserting records: ${error?.message ?? 'No data returned'}`);
                return null;
            }
            
            const newRecord = data[0];

            if (setAsCurrent) {
                this._currentRecord = newRecord;
            }

            this.lifeCycleEvents.emit('afterBulkInsert', data);

            await this.refresh();

            this.handleInfo(`${records.length} records inserted successfully`);

            return newRecord;
        } catch (err) {
            this.handleError(`Error inserting records: ${err}`);
            return null;
        }
    }

    /**
     * Updates multiple records in Supabase with the updates supplied.
     * @param ids - The ids of the records to update.
     * @param values - The values to update the records with.
     * @param optimistic - Whether to optimistically update the records in the data object without refreshing after the update. Default is true.
     * @returns True if update was successful, false otherwise.
     */
    async bulkUpdate(
        ids: T["id"][],
        values: Partial<T>,
        optimistic = true
    ): Promise<boolean> {
        if (this.state.isUpdating) return false;
        if (!this.options.canUpdate || !this.options.tableName) {
            this.handleWarning('Update operation is not allowed for this data object');
            return false;
        }

        if (!ids.length) return false;

        const idSet = new Set(ids);
        const records = this.data.filter(x => idSet.has(x.id));

        if (records.length !== ids.length) {
            this.handleWarning('Some records not found');
            return false;
        }

        const updateToken: DataObjectCancelableEvent & DataObjectOptions<T> = {
            ...this.options,
            cancel: () => { updateToken.cancelEvent = true; },
            cancelEvent: false,
        };

        this.lifeCycleEvents.emit('beforeBulkUpdate', updateToken, records, values);
        if (updateToken.cancelEvent) return false;

        try {
            this.state.isUpdating = true;

            const { error } = await this.supabase
                .from(this.options.tableName)
                .update(values)
                .in('id', ids);

            if (error) {
                this.handleError(`Error updating records: ${error.message}`);
                return false;
            }

            if (optimistic) {
                this.data = this.data.map(record =>
                    idSet.has(record.id)
                        ? { ...record, ...values }
                        : record
                    );
            } else {
                await this.refresh();
            }

            this.lifeCycleEvents.emit('afterBulkUpdate', ids, values);
            this.handleInfo(`${ids.length} records updated successfully`);

            return true;
        } catch (error) {
            this.handleError(`Error updating records: ${error}`);
            return false;
        } finally {
            this.state.isUpdating = false;
        }
    }

    /**
     * Deletes multiple records from Supabase.
     * @param ids - The ids of the records to delete.
     * @returns true if delete was successful, false otherwise.
     */
    async bulkDelete(ids: (T["id"])[]): Promise<boolean> {
        if (this.state.isDeleting) { return false; }
        if (!this.options.canDelete || !this.options.tableName) {
            this.handleWarning('Delete operation is not allowed for this data object');
            return false;
        }

        if (!ids.length) return false;

        const idSet = new Set(ids);
        const records = this.data.filter(x => idSet.has(x.id));

        const deleteToken: DataObjectCancelableEvent & DataObjectOptions<T> = {
            ...this.options,
            cancel: () => { deleteToken.cancelEvent = true; }, 
            cancelEvent: false,
        };

        this.lifeCycleEvents.emit('beforeBulkDelete', deleteToken, records);
        if (deleteToken.cancelEvent) { return false; }

        try {
            this.state.isDeleting = true;
            const { error } = await this.supabase
                .from(this.options.tableName)
                .delete()
                .in('id', ids)

            if (error) {
                this.handleError(`Error deleting record: ${error.message}`);
                return false;
            }

            // Refresh data to get the latest state
            await this.refresh();
            this.lifeCycleEvents.emit('afterBulkDelete', ids);
            this.handleInfo(`${ids.length} records deleted successfully`);
            return true;
        } catch (error) {
            this.handleError(`Error deleting records: ${error}`);
            return false;
        } finally {
            this.state.isDeleting = false;
        }
    }

    // #end region

    /**
     * Saves all pending changes in parallel to Supabase using the update() method, then refreshes data object.
     * Can only be done if a tableName is specified and canUpdate is true.
     */
    public async saveChanges(): Promise<void> {
        if (this.changedRecords.length == 0) {
            this.handleInfo("No changes to save.");
            return;
        }

        if (!this.options.canUpdate || !this.options.tableName) {
            this.handleWarning('Update operation is not allowed for this data object.');
            return;
        }

        const changed = this.changedRecords;

        try {
            this.state.isSaving = true;
            await Promise.all(changed.map(r => r.save()));

            await this.refresh();

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
        if (this.changedRecords.length === 0) {
            this.handleInfo("No changes to revert.");
            return;
        }
        for (const record of this.data) {
            if (record.hasChanges) {
                record.revert();
            }
        }
        this.eventEmitter.fire(this.data);
        this.handleInfo("All changes reverted.");
    }

    // #end region

    // #region Helpers

    /**
     * Helper function to wrap data object records in a reactive proxy and listen for changes.
     * @param record - DataObjectRecord to create proxy for
     * @returns Proxy of DataObjectRecord passed through
     */
    private createReactiveRecord(raw: T): DataObjectRecord<T> {
        const record = new DataRecord<T>(
            this.data.length,
            this._fields,
            raw,
            this,
            (rec, field) => {
                this.lifeCycleEvents.emit('fieldChanged', record, rec.changes);
                this.currentRecord = record;
                this.eventEmitter.fire(this.data);
            }
        ) as DataObjectRecord<T>;

        return record;
    }

    /** Builds the select query for fetching data from Supabase. */
    private buildQuery(): any {
        // Start with base query
        let query: any = this.supabase.from(this.options.viewName);

        // Apply select fields and relationships
        const selections: string[] = [];

        if (this.options.fields && this.options.fields.length > 0) {
            this._fields = this.options.fields;

            selections.push(
                this.options.fields
                    .map(f => String(f.name))
                    .join(",")
            );
        } else {
            selections.push("*");
        }

        if (this.options.relationships?.length) {
            selections.push(
                this.buildRelationshipSelect(
                    this.options.relationships
                )
            );
        }

        query = query.select(selections.join(","));

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
                    case 'like':
                        query = query.like(whereClause.field, `%${whereClause.value}%`);
                        break;
                    case 'ilike':
                        query = query.ilike(whereClause.field, `%${whereClause.value}%`);
                        break;
                    case 'in':
                        query = query.in(whereClause.field, whereClause.value as any[]);
                        break;
                    case 'notin':
                        query = query.not(whereClause.field, 'in', whereClause.value as any[]);
                        break;
                }
            }
        }
        
        // Apply master binding where clause if it exists
        if (this.masterBinding) {
            const bindingWhereClause = this.masterBinding.bindingWhereClause;
            if (!bindingWhereClause || bindingWhereClause.value === undefined || bindingWhereClause.value === null) {
                this.data = [];
                this.currentRecord = undefined;
                this.state.isReady = true;
                this.lifeCycleEvents.emit('afterLoad', this.data);

                throw new Error('Master binding value is undefined or null, cannot build select query.');
            }

            query = query.eq(bindingWhereClause.field, bindingWhereClause.value);
        }

        // Apply sorting
        if (this.options.sort) {
            const sortArray = this.normalizeSort(this.options.sort);
            for (const sort of sortArray) {
                query = query.order(sort.field as string, { ascending: sort.direction === 'asc' });
            }
        }

        // Apply record limit
        if (this.options.recordLimit) {
            query = query.limit(this.options.recordLimit);
        }

        return query;
    }

    /**
     * Gets the options defined for the created data object.
     */
    public getOptions(): DataObjectOptions<T> {
        return { ...this.options };
    }

    /**
     * Adds a new data object to this data object's childDataObjects array.
     * @param child - The data object to add as a child to this one.
     */
    public registerChildDataObject(child: DataObject<any>): void {
        if (!this._childDataObjects.includes(child)) {
            this._childDataObjects.push(child);
        }
    }

    /**
     * Removes a data object from this data object's childDataObjects array.
     * @param child - The data object to remove.
     */
    public unregisterChildDataObject(child: DataObject<any>): void {
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
    private setDefaultOptions(options: DataObjectOptions<T>): DataObjectOptions<T> {
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
     * Builds the select string for the relationships defined in the data object options.
     * @param relationships - Array of RelationshipConfig objects to build the select string for.
     * @returns The built select string.
     */
    private buildRelationshipSelect(relationships: RelationshipConfig[]): string {
        return relationships
            .map((relationship) => {
                let relationshipName = relationship.name;

                if (relationship.alias) {
                    relationshipName = `${relationship.alias}:${relationshipName}`;
                }

                if (relationship.foreignKey) {
                    relationshipName += `!${relationship.foreignKey}`;
                }

                const fields = relationship.fields?.length
                    ? relationship.fields.map(String)
                    : ["*"];

                const nestedRelationships = relationship.relationships?.length
                    ? this.buildRelationshipSelect(
                        relationship.relationships
                    )
                    : "";

                const selections = [
                    ...fields,
                    nestedRelationships
                ]
                    .filter(Boolean)
                    .join(",");

                return `${relationshipName}(${selections})`;
            })
            .join(",");
    }

    /**
     * Update the sort applied to the data. When set, will trigger a refresh.
     * @param sort - The new sort to be applied to the data object.
     */
    public updateSort(sort: SortConfig<T> | SortConfig<T>[]) {
        this.options.sort = sort;
        this.refresh();
    }

    public clearSort() {
        this.options.sort = undefined;
        this.refresh();
    }

    /** Set a new groupBy config on the dataObject to update groupedData. */
    public setGroupBy(config: GroupByConfig<T>) {
        this.options.groupBy = config;
        this.applyGrouping();
    }

    /**
     * Gets a record from DataObject's data array.
     * @param id - The id of the record to fetch.
     * @returns A DataObjectRecord if found, undefined if not.
     */
    public getRecordById(id: T["id"]): DataObjectRecord<T> | undefined {
        return this.data.find(x => x.id === id);
    }

    /**
     * Fetches data created in loadData() method.
     * @returns an array of DataObjectRecords
     */
    public getData(): DataObjectRecord<T>[] {
        return [...this.data];
    }

    private normalizeSort(
        sort?: SortConfig<T> | SortConfig<T>[]
    ): Required<SortConfig<T>>[] {
        if (!sort) return [];

        const arr = Array.isArray(sort) ? sort : [sort];

        return arr
            .map((s, index) => ({
            field: s.field, 
            direction: s.direction ?? 'asc',
            order: s.order ?? index,
            }))
            .sort((a, b) => a.order - b.order);
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

export async function createDataObject<
  T extends DataRecordKey = DataRecordKey
>(
    supabase: SupabaseClient,
    options: DataObjectOptions<T>,
    name: string,
    errorHandler?: DataObjectErrorHandler
): Promise<DataObject<T>> {
    return new DataObject<T>(supabase, options, name, errorHandler);
}