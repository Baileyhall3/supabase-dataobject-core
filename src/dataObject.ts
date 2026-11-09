import { SupabaseClient } from '@supabase/supabase-js';
import {
    DataObjectOptions,
    DataObjectRecord,
    WhereClause,
    DataObjectEvents,
    DataObjectCancelableEvent,
    DataObjectField,
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
import { buildSelectQuery, relationshipKeys } from './queryBuilder';
import { groupRecords, DataObjectGroup } from './grouping';
import { ReactiveSignal } from './reactivity';

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

    private _data: DataObjectRecord<T>[] = [];

    /**
     * Observability hook for UI frameworks (see `makeReactive`). Tracked by `data`, `currentRecord`,
     * `fields` and `groupedData`; triggered when any of those are replaced. Column-level changes are
     * tracked per record by DataRecord.
     */
    private _signal: ReactiveSignal;

    public get data(): DataObjectRecord<T>[] {
        this._signal.track();
        return this._data;
    }

    public set data(records: DataObjectRecord<T>[]) {
        this._data = records;
        this._signal.trigger();
    }

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

    private _groupedData: DataObjectGroup<T>[] = [];

    /** id -> record index for O(1) getRecordById(). Validated on read, so it can't go stale. */
    private _recordsById = new Map<unknown, DataObjectRecord<T>>();
    /** The `data` array the index was built from. */
    private _indexedData: DataObjectRecord<T>[] | null = null;

    /** Monotonic load counter: only the latest load may apply its results ("latest wins"). */
    private _loadSeq = 0;
    private _loadAbort?: AbortController;
    private _currentLoad?: Promise<boolean>;
    private _currentLoadSeq = 0;

    /** Record ids with an update/delete in flight (per-record guard instead of a global one). */
    private _updatingIds = new Set<unknown>();
    private _deletingIds = new Set<unknown>();

    /** When set, the next load makes the record with this id current (used by insert). */
    private _preferredCurrentId: T["id"] | undefined;

    public get name(): string {
        return this._name;
    }

    public get recordCount(): number {
        return this.data.length;
    }

    public get currentRecord(): DataObjectRecord<T> | undefined {
        this._signal.track();
        return this._currentRecord;
    }

    public set currentRecord(record: DataObjectRecord<T> | undefined) {
        this.setCurrentRecord(record, true);
    }

    public get fields(): DataObjectField<T>[] {
        this._signal.track();
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
        this._signal.track();
        return this._groupedData;
    }

    public get hasGroupBy(): boolean {
        return !!this.options.groupBy;
    }

    constructor(
        supabase: SupabaseClient,
        options: DataObjectOptions<T>,
        name: string,
        errorHandler?: DataObjectErrorHandler
    ) {
        this.supabase = supabase;
        this._signal = new ReactiveSignal(options.makeReactive);
        this._options = this.setDefaultOptions(options);
        this.errorHandler = errorHandler;
        this._name = name;
        this.state = new DataObjectState(options.makeReactive);
        this.storage = new DataObjectStorage(
            name,
            this.supabase.storage,
            options.allowedBuckets,
            errorHandler
        )
        this._readyPromise = this.initializeDataObject();
    }

    private async initializeDataObject(): Promise<void> {
        if (this.options.fields && this.options.fields.length > 0) {
            this._fields = this.options.fields;
        } else if (!this.options.autoRefresh) {
            // No load will follow, so fields must be inferred up front (previous behaviour).
            await this.inferFields();
        }
        // Otherwise fields are inferred from the first load's result, saving a round trip.

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

        // Fallback (edge cases only: empty result, load error, unbound child):
        // infer fields the old way so `fields` is populated as before.
        if (this._fields.length === 0 && !this.state.isDestroyed) {
            await this.inferFields();
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

    private createCancelToken(): DataObjectCancelableEvent & DataObjectOptions<T> {
        const token: DataObjectCancelableEvent & DataObjectOptions<T> = {
            ...this.options,
            cancel: () => { token.cancelEvent = true; },
            cancelEvent: false,
        };
        return token;
    }

    // #region Load Operations

    /**
     * Loads data from Supabase with the given parameters defined when creating data object.
     * If a newer load starts while this one is in flight, this one is aborted and its result
     * discarded; callers awaiting it resolve once the newest load has been applied.
     * @returns true if this load's result was applied, false if cancelled or superseded.
     */
    private loadData(): Promise<boolean> {
        const cancelToken = this.createCancelToken();
        this.lifeCycleEvents.emit('beforeLoad', cancelToken);
        if (cancelToken.cancelEvent) { return Promise.resolve(false); }

        const seq = ++this._loadSeq;
        this._loadAbort?.abort();
        const abort = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
        this._loadAbort = abort;
        this.state.isRefreshing = true;

        const load = this.runLoad(seq, abort);
        this._currentLoad = load;
        this._currentLoadSeq = seq;
        return load;
    }

    private async runLoad(seq: number, abort: AbortController | undefined): Promise<boolean> {
        // Superseded = a newer load started (this one was aborted) or the object was disposed.
        // Aborted requests come back as errors; they are never reported.
        const superseded = () => seq !== this._loadSeq || this.state.isDestroyed;
        const awaitNewest = async () => {
            const newest = this._currentLoad;
            if (newest && this._currentLoadSeq !== seq && !this.state.isDestroyed) {
                await newest;
            }
            return false;
        };
        try {
            // Bound child with no master value (e.g. master has no rows): nothing to load.
            if (this.masterBinding && !this.hasBindingValue()) {
                this.setData([]);
                this.eventEmitter.fire(this._data);
                this.lifeCycleEvents.emit('afterLoad', this._data);
                return true;
            }

            const query = buildSelectQuery<T>(this.supabase, {
                viewName: this.options.viewName,
                fields: this.options.fields,
                relationships: this.options.relationships,
                whereClauses: this.options.whereClauses,
                bindingClause: this.masterBinding?.bindingWhereClause,
                sort: this.options.sort,
                recordLimit: this.options.recordLimit,
                abortSignal: abort?.signal,
            });
            const { data, error } = await query;

            if (superseded()) {
                return awaitNewest();
            }

            if (error) {
                this.handleError(`Error loading data: ${error.message}`);
                return true;
            }

            const rawData: T[] = data || [];
            this.inferFieldsFromRow(rawData[0]);
            this.setData(rawData);

            this.eventEmitter.fire(this._data);
            this.lifeCycleEvents.emit('afterLoad', this._data);
            return true;
        } catch (error) {
            if (superseded()) {
                return awaitNewest();
            }
            this.handleError(`Error loading data: ${error}`);
            return true;
        } finally {
            if (seq === this._loadSeq) {
                this.state.isReady = true;
                this.state.isRefreshing = false;
                this._loadAbort = undefined;
            }
        }
    }

    private hasBindingValue(): boolean {
        const value = this.masterBinding?.bindingWhereClause?.value;
        return value !== undefined && value !== null;
    }

    /**
     * Replaces `data` with freshly wrapped records, rebuilds the id index and grouping,
     * and resolves the current record (keeping the same id across refreshes when possible).
     */
    private setData(rawData: T[]): void {
        const records = new Array<DataObjectRecord<T>>(rawData.length);
        for (let i = 0; i < rawData.length; i++) {
            records[i] = this.createReactiveRecord(rawData[i], i);
        }
        this._data = records;
        this._signal.trigger();
        this.rebuildIndex();
        this.applyGrouping();

        const preferredId = this._preferredCurrentId !== undefined
            ? this._preferredCurrentId
            : this._currentRecord?.id;
        this._preferredCurrentId = undefined;

        const next = (preferredId !== undefined ? this._recordsById.get(preferredId) : undefined) ?? records[0];
        this.setCurrentRecord(next, false);
    }

    private rebuildIndex(): void {
        this._recordsById.clear();
        for (const record of this._data) {
            this._recordsById.set(record.id, record);
        }
        this._indexedData = this._data;
    }

    /**
     * Sets the current record.
     * - Same id, different instance (e.g. after a refresh): swaps the reference silently so
     *   currentRecord is always the live object in `data`.
     * - Different id: emits currentRecordChanged and refreshes child data objects.
     */
    private setCurrentRecord(record: DataObjectRecord<T> | undefined, fireDataChanged: boolean): void {
        if (this._currentRecord?.id === record?.id) {
            if (this._currentRecord !== record) {
                this._currentRecord = record;
                this._signal.trigger();
            }
            return;
        }

        const previousRecord = this._currentRecord;
        this._currentRecord = record;
        this._signal.trigger();

        this.lifeCycleEvents.emit('currentRecordChanged', previousRecord, record);
        if (fireDataChanged) {
            this.eventEmitter.fire(this._data);
        }

        for (const child of this._childDataObjects) {
            if (!child.state.isDestroyed && child.state.isReady) {
                child.refresh().catch(err =>
                    console.warn(`Child refresh failed for ${child.name}:`, err)
                );
            }
        }
    }

    /**
     * Refresh data to get the latest state.
     * Calling refresh() while a refresh is in flight aborts the older request and loads again
     * with the current options, so the final data always reflects the latest filters/sort.
     */
    public async refresh(): Promise<void> {
        try {
            const refreshToken = this.createCancelToken();
            this.lifeCycleEvents.emit('beforeRefresh', refreshToken);
            if (refreshToken.cancelEvent) { return; }

            const applied = await this.loadData();

            if (applied) {
                this.lifeCycleEvents.emit('afterRefresh', this._data);
            }
        } catch (err) {
            this.handleError(`Error refreshing data object ${this.name}: ${err}`);
        }
    }

    /** Gets the newest version of a record from Supabase by its ID. */
    public async fetchRecordById(id: T["id"]): Promise<T | undefined> {
        const query = buildSelectQuery<T>(this.supabase, {
            viewName: this.options.viewName,
            fields: this.options.fields,
            relationships: this.options.relationships,
            whereClauses: this.options.whereClauses,
        })
            .eq("id", id)
            .limit(1);

        const { data, error } = await query;

        if (error) { throw error; }

        return data?.[0];
    }

    /** Refreshes a record by its ID. Errors are reported through the error handler. */
    public async refreshRecordById(id: T["id"]): Promise<void> {
        const record = this.getRecordById(id);

        if (!record) { return undefined; }

        try {
            await record.refresh();
        } catch (error) {
            this.handleError(`Error refreshing record ${String(id)}: ${(error as any)?.message ?? error}`);
        }
    }

    //** Apply groupBy to the data returned from loadData() and populate groupedData. */
    private applyGrouping(): void {
        this._groupedData = groupRecords(this._data, this.options.groupBy, (m) => this.handleWarning(m));
        this._signal.trigger();
    }

    // #region CRUD

    /**
     * Creates a new record in Supabase.
     * @param record - Partial record to insert.
     * @param setAsCurrent - Make the inserted record the current record. Default is true.
     * @returns The newly created DataObjectRecord (as found in `data` after refreshing),
     * or the raw inserted row if it isn't part of this data object's result set, or null if insert fails.
     */
    public async insert(record: Partial<T>, setAsCurrent = true): Promise<DataObjectRecord<T> | null> {
        if (!this.options.canInsert || !this.options.tableName) {
            this.handleWarning('Insert operation is not allowed for this data object');
            return null;
        }

        const insertToken = this.createCancelToken();

        this.lifeCycleEvents.emit('beforeInsert', insertToken, record);
        if (insertToken.cancelEvent) return null;

        try {
            this.state.isInserting = true;
            const { data, error } = await this.supabase
                .from(this.options.tableName)
                .insert(record)
                .select();

            if (error || !data?.length) {
                this.handleError(`Error inserting record: ${error?.message ?? 'No data returned'}`);
                return null;
            }

            const newRow = data[0] as T;

            if (setAsCurrent) {
                this._preferredCurrentId = newRow.id;
            }

            await this.refresh();

            const newRecord = this.getRecordById(newRow.id) ?? (newRow as DataObjectRecord<T>);

            this.lifeCycleEvents.emit('afterInsert', newRecord);

            this.handleInfo('Record inserted successfully');

            return newRecord;
        } catch (err) {
            this.handleError(`Error inserting record: ${err}`);
            return null;
        } finally {
            this.state.isInserting = false;
        }
    }

    /**
     * Updates a record in Supabase with the updates supplied.
     * Can only be called if a tableName is provided and canUpdate is set to true.
     * Updates to *different* records may run concurrently; a second update to a record that
     * is already being updated returns false.
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
        if (this._updatingIds.has(id)) { return false; }
        if (!this.options.canUpdate || !this.options.tableName) {
            this.handleWarning('Update operation is not allowed for this data object.');
            return false;
        }

        const record = this.getRecordById(id);
        if (!record) { return false; }

        const updateToken = this.createCancelToken();
        this.lifeCycleEvents.emit('beforeUpdate', updateToken, record, updates);
        if (updateToken.cancelEvent) { return false; }

        this.markBusy(this._updatingIds, [id]);
        try {
            const { data, error } = await this.supabase
                .from(this.options.tableName)
                .update(updates)
                .eq('id', id)
                .select()
                .maybeSingle();

            if (error) {
                this.handleError(`Error updating record: ${error.message}`);
                return false;
            }

            if (skipRefresh) {
                record.commitSaved(updates, data as Partial<T> | null);
                this.eventEmitter.fire(this._data);
            } else {
                await this.refresh();
            }

            const updatedRecord = this.getRecordById(id);
            if (updatedRecord) {
                this.lifeCycleEvents.emit('afterUpdate', updatedRecord, updates);
            }
            this.handleInfo('Record updated successfully');
            return true;
        } catch (error) {
            this.handleError(`Error updating record: ${error}`);
            return false;
        } finally {
            this.markIdle(this._updatingIds, [id]);
        }
    }

    /**
     * Method for deleting a record from Supabase.
     * Can only be called if a tableName is provided and canDelete is set to true.
     * @param id - The id of the record to delete
     * @returns true if delete was successful, false otherwise.
     */
    public async delete(id: T["id"]): Promise<boolean> {
        if (this._deletingIds.has(id)) { return false; }
        if (!this.options.canDelete || !this.options.tableName) {
            this.handleWarning('Delete operation is not allowed for this data object');
            return false;
        }

        const record = this.getRecordById(id);
        if (!record) { return false; }

        const deleteToken = this.createCancelToken();

        this.lifeCycleEvents.emit('beforeDelete', deleteToken, record);
        if (deleteToken.cancelEvent) { return false; }

        this.markBusy(this._deletingIds, [id]);
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
        } finally {
            this.markIdle(this._deletingIds, [id]);
        }
    }

    private markBusy(set: Set<unknown>, ids: unknown[]): void {
        for (const id of ids) set.add(id);
        this.syncBusyState();
    }

    private markIdle(set: Set<unknown>, ids: unknown[]): void {
        for (const id of ids) set.delete(id);
        this.syncBusyState();
    }

    private syncBusyState(): void {
        this.state.isUpdating = this._updatingIds.size > 0;
        this.state.isDeleting = this._deletingIds.size > 0;
    }

    // #region Bulk Operations

    /**
     * Creates new records in Supabase.
     * @param records - Partial records to insert.
     * @returns The first newly created DataObjectRecord, or null if insert fails.
     */
    public async bulkInsert(records: Partial<T>[], setAsCurrent = true): Promise<DataObjectRecord<T> | null[] | null> {
        if (!this.options.canInsert || !this.options.tableName) {
            this.handleWarning('Bulk insert operation is not allowed for this data object');
            return null;
        }

        const insertToken = this.createCancelToken();

        this.lifeCycleEvents.emit('beforeBulkInsert', insertToken, records);
        if (insertToken.cancelEvent) return null;

        try {
            this.state.isInserting = true;
            const { data, error } = await this.supabase
                .from(this.options.tableName)
                .insert(records)
                .select();

            if (error || !data?.length) {
                this.handleError(`Error inserting records: ${error?.message ?? 'No data returned'}`);
                return null;
            }

            const rows = data as T[];

            if (setAsCurrent) {
                this._preferredCurrentId = rows[0].id;
            }

            await this.refresh();

            const inserted = rows.map(r => this.getRecordById(r.id) ?? (r as DataObjectRecord<T>));

            this.lifeCycleEvents.emit('afterBulkInsert', inserted);

            this.handleInfo(`${records.length} records inserted successfully`);

            return inserted[0];
        } catch (err) {
            this.handleError(`Error inserting records: ${err}`);
            return null;
        } finally {
            this.state.isInserting = false;
        }
    }

    /**
     * Updates multiple records in Supabase with the updates supplied.
     * @param ids - The ids of the records to update.
     * @param values - The values to update the records with.
     * @param optimistic - Whether to update the records in place from the server response
     * without refreshing the whole data object. Default is true.
     * @returns True if update was successful, false otherwise.
     */
    async bulkUpdate(
        ids: T["id"][],
        values: Partial<T>,
        optimistic = true
    ): Promise<boolean> {
        if (ids.some(id => this._updatingIds.has(id))) return false;
        if (!this.options.canUpdate || !this.options.tableName) {
            this.handleWarning('Update operation is not allowed for this data object');
            return false;
        }

        if (!ids.length) return false;

        const records: DataObjectRecord<T>[] = [];
        for (const id of ids) {
            const record = this.getRecordById(id);
            if (record) records.push(record);
        }

        if (records.length !== ids.length) {
            this.handleWarning('Some records not found');
            return false;
        }

        const updateToken = this.createCancelToken();

        this.lifeCycleEvents.emit('beforeBulkUpdate', updateToken, records, values);
        if (updateToken.cancelEvent) return false;

        this.markBusy(this._updatingIds, ids);
        try {
            const { data, error } = await this.supabase
                .from(this.options.tableName)
                .update(values)
                .in('id', ids)
                .select();

            if (error) {
                this.handleError(`Error updating records: ${error.message}`);
                return false;
            }

            if (optimistic) {
                // Merge server-confirmed rows (or the sent values if RLS hides them) into the
                // existing DataRecords so they keep their methods, other columns and pending edits.
                const serverRows = new Map<unknown, Partial<T>>();
                for (const row of (data ?? []) as T[]) serverRows.set(row.id, row);
                const valueKeys = new Set(Object.keys(values));
                for (const record of records) {
                    record.mergeServerValues(serverRows.get(record.id) ?? values, valueKeys);
                }
                this.applyGrouping();
                this.eventEmitter.fire(this._data);
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
            this.markIdle(this._updatingIds, ids);
        }
    }

    /**
     * Deletes multiple records from Supabase.
     * @param ids - The ids of the records to delete.
     * @returns true if delete was successful, false otherwise.
     */
    async bulkDelete(ids: (T["id"])[]): Promise<boolean> {
        if (ids.some(id => this._deletingIds.has(id))) { return false; }
        if (!this.options.canDelete || !this.options.tableName) {
            this.handleWarning('Delete operation is not allowed for this data object');
            return false;
        }

        if (!ids.length) return false;

        const records: DataObjectRecord<T>[] = [];
        for (const id of ids) {
            const record = this.getRecordById(id);
            if (record) records.push(record);
        }

        const deleteToken = this.createCancelToken();

        this.lifeCycleEvents.emit('beforeBulkDelete', deleteToken, records);
        if (deleteToken.cancelEvent) { return false; }

        this.markBusy(this._deletingIds, ids);
        try {
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
            this.markIdle(this._deletingIds, ids);
        }
    }

    // #end region

    /**
     * Saves all pending changes in parallel to Supabase, then refreshes the data object.
     * Can only be done if a tableName is specified and canUpdate is true.
     * If any record fails to save, the data object is NOT refreshed, so the failed records
     * keep their pending changes and can be retried.
     * @returns true if every changed record was saved.
     */
    public async saveChanges(): Promise<boolean> {
        const changed = this.changedRecords;
        if (changed.length == 0) {
            this.handleInfo("No changes to save.");
            return true;
        }

        if (!this.options.canUpdate || !this.options.tableName) {
            this.handleWarning('Update operation is not allowed for this data object.');
            return false;
        }

        const saved: DataObjectRecord<T>[] = [];
        const failed: DataObjectRecord<T>[] = [];

        try {
            this.state.isSaving = true;
            const results = await Promise.all(changed.map(r => r.save().catch(() => false)));
            results.forEach((ok, i) => (ok ? saved : failed).push(changed[i]));

            if (failed.length === 0) {
                await this.refresh();
                this.handleInfo("All changes saved successfully.");
            } else {
                this.handleError(`Saved ${saved.length} of ${changed.length} records. Failed ids: ${failed.map(r => String(r.id)).join(', ')}`);
            }
        } catch (error) {
            this.handleError(`Error saving changes: ${error}`);
        } finally {
            this.state.isSaving = false;
        }

        this.lifeCycleEvents.emit('afterSaveChanges', saved, failed);
        return failed.length === 0;
    }

    /**
     * Clears all pending changes and returns the data object to its original state.
     */
    public cancelChanges(): void {
        if (this.changedRecords.length === 0) {
            this.handleInfo("No changes to revert.");
            return;
        }
        for (const record of this._data) {
            if (record.hasChanges) {
                record.revert();
            }
        }
        this.eventEmitter.fire(this._data);
        this.handleInfo("All changes reverted.");
    }

    // #end region

    // #region Helpers

    /**
     * Helper function to wrap data object records in a reactive proxy and listen for changes.
     * @param raw - Raw row to wrap
     * @param index - Position of the record in `data`
     * @returns Proxy of DataObjectRecord passed through
     */
    private createReactiveRecord(raw: T, index: number): DataObjectRecord<T> {
        const record = new DataRecord<T>(
            index,
            this._fields,
            raw,
            this,
            // User edit (or revert): track change, make it current, notify.
            (rec) => {
                this.lifeCycleEvents.emit('fieldChanged', record, rec.changes);
                this.currentRecord = record;
                this.eventEmitter.fire(this._data);
            },
            // Server sync (record.refresh()): notify without changing the current record.
            (_rec, changed) => {
                this.lifeCycleEvents.emit('fieldChanged', record, changed);
                if (this.hasGroupBy) this.applyGrouping();
                this.eventEmitter.fire(this._data);
            }
        ) as DataObjectRecord<T>;

        return record;
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
     * Infers data objects fields with a separate `select * limit 1` request.
     * Only used when fields can't be taken from a normal load (autoRefresh: false, empty result).
     */
    private async inferFields(): Promise<void> {
        if (this.options.fields && this.options.fields.length > 0) {
            this._fields = this.options.fields;
            return;
        }
        try {
            const { data } = await this.supabase.from(this.options.viewName).select('*').limit(1);
            this.inferFieldsFromRow(data?.[0]);
        } catch {
            // ignore: fields stay empty, as before
        }
    }

    /** Infers fields from a loaded row (excluding relationship embeds), if not already known. */
    private inferFieldsFromRow(row: T | undefined): void {
        if (this._fields.length > 0 || !row) return;
        const embeds = relationshipKeys(this.options.relationships);
        this._fields = Object.keys(row)
            .filter(key => !embeds.has(key))
            .map(key => ({ name: key as keyof T, type: undefined }));
        this._signal.trigger();
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
    public setGroupBy(config: GroupByConfig<T> | undefined) {
        this.options.groupBy = config;
        this.applyGrouping();
    }

    /**
     * Gets a record from DataObject's data array in O(1).
     * @param id - The id of the record to fetch.
     * @returns A DataObjectRecord if found, undefined if not.
     */
    public getRecordById(id: T["id"]): DataObjectRecord<T> | undefined {
        // `data` is public and may have been replaced externally: rebuild the index if so.
        if (this._indexedData !== this._data) {
            this.rebuildIndex();
        }
        const record = this._recordsById.get(id);
        if (record && this._data[record.index] === record) {
            return record;
        }
        // Index miss or array mutated in place: fall back to a scan, then re-index.
        const found = this._data.find(x => x.id === id);
        if (found) this.rebuildIndex();
        return found;
    }

    /**
     * Fetches data created in loadData() method.
     * @returns an array of DataObjectRecords
     */
    public getData(): DataObjectRecord<T>[] {
        return [...this._data];
    }

    /**
     * Helper method to dispose of a data object in order to prevent memory leaks.
     * Disposes of all child data objects and resets state to default.
     */
    public dispose(): void {
        if (this.state.isDestroyed) return;
        this.state.isDestroyed = true;

        // Cancel any in-flight load and make sure a late response can't repopulate data.
        this._loadSeq++;
        this._loadAbort?.abort();
        this._loadAbort = undefined;
        this._currentLoad = undefined;

        // Capture the master before the binding (which provides it) is torn down.
        const master = this.masterDataObject;
        if (this.masterBinding) {
            this.masterBinding.dispose();
            this.masterBinding = undefined;
        }
        master?.unregisterChildDataObject(this);

        for (const child of this._childDataObjects) child.dispose();
        this._childDataObjects = [];

        this.eventEmitter.dispose();
        this.lifeCycleEvents.clearAll();

        this._data = [];
        this._currentRecord = undefined;
        this._recordsById.clear();
        this._indexedData = null;
        this._groupedData = [];
        this._signal.trigger();

        this.state.reset();
        this.state.isDestroyed = true;
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
