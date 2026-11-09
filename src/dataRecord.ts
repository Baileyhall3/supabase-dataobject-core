import { DataObject } from "./dataObject";
import { DataObjectField } from "./types";

/**
 * Copies a row so `_original` is independent of `_record`.
 * Primitive columns (the common case) are copied by value; only object-valued columns
 * (JSON, arrays, relationship embeds) are deep-cloned, which is far cheaper than
 * JSON.parse(JSON.stringify(row)) for every record on every load.
 */
function cloneRow<T>(row: T): T {
    const out: any = {};
    for (const key in row) {
        const v: any = (row as any)[key];
        out[key] = v !== null && typeof v === 'object' ? deepClone(v) : v;
    }
    return out;
}

function deepClone<V>(value: V): V {
    if (typeof structuredClone === 'function') {
        try { return structuredClone(value); } catch { /* fall through (e.g. functions) */ }
    }
    return JSON.parse(JSON.stringify(value));
}

export class DataRecord<T extends { id: unknown }> {
    public readonly index: number;
    public readonly fields: DataObjectField<T>[];

    private _dataObject: DataObject<T>;
    private _state = new DataRecordState();
    private _onFieldChanged?: (record: DataRecord<T>, field: keyof T) => void;
    private _onServerSync?: (record: DataRecord<T>, changed: Partial<T>) => void;

    private _original: Readonly<T>;
    private _pendingChanges: Partial<T> = {};

    private _record: T;

    // NB: every internal field MUST be initialised (even to undefined). Uninitialised fields
    // aren't emitted, so assigning them later through the Proxy would be treated as a column edit.
    private _savePromise: Promise<boolean> | undefined = undefined;
    private _saveAgain = false;
    private _refreshPromise: Promise<void> | undefined = undefined;
    private _refreshAgain = false;

    get id(): T["id"] {
        return this._record.id;
    }

    get hasChanges(): boolean {
        for (const _ in this._pendingChanges) return true;
        return false;
    }

    get changes(): Readonly<Partial<T>> {
        return this._pendingChanges;
    }

    get isCurrent(): boolean {
        return this._record.id === this._dataObject.currentRecord?.id;
    }

    constructor(
        index: number,
        fields: DataObjectField<T>[],
        rawRecord: T,
        dataObject: DataObject<T>,
        onFieldChanged?: (record: DataRecord<T>, field: keyof T) => void,
        onServerSync?: (record: DataRecord<T>, changed: Partial<T>) => void
    ) {
        this._record = rawRecord;
        this.index = index;
        this.fields = fields;
        this._onFieldChanged = onFieldChanged;
        this._onServerSync = onServerSync;
        this._dataObject = dataObject;

        this._original = cloneRow(rawRecord);

        const handler: ProxyHandler<this> = {
            get: (target, prop, receiver) => {
                if (Reflect.has(target, prop)) {
                    return Reflect.get(target, prop, receiver);
                }

                if (typeof prop === "string") {
                    return target._record[prop as keyof T];
                }

                return undefined;
            },

            set: (target, prop, value, receiver) => {
                if (Reflect.has(target, prop)) {
                    return Reflect.set(target, prop, value, receiver);
                }

                if (typeof prop === "string") {
                    const key = prop as keyof T;

                    if (target._record[key] !== value) {
                        target._record[key] = value;

                        if (value === target._original[key]) {
                            delete target._pendingChanges[key];
                        } else {
                            target._pendingChanges[key] = value;
                        }

                        target._onFieldChanged?.(target as DataRecord<T>, key);
                    }

                    return true;
                }

                return false;
            },

            // The traps below make a record behave like a plain row object:
            // Object.keys(), {...record}, `'col' in record`, for..in, Vue devtools, etc.
            // All expose the row's columns rather than DataRecord internals.
            has: (target, prop) => {
                if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target._record, prop)) {
                    return true;
                }
                return Reflect.has(target, prop);
            },

            ownKeys: (target) => Reflect.ownKeys(target._record as object),

            getOwnPropertyDescriptor: (target, prop) => {
                if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(target._record, prop)) {
                    return {
                        value: target._record[prop as keyof T],
                        writable: true,
                        enumerable: true,
                        configurable: true,
                    };
                }
                return undefined;
            },
        };

        return new Proxy(this, handler) as unknown as DataRecord<T> & T;
    }

    /** Plain copy of the row's current values. Used automatically by JSON.stringify(record). */
    public toJSON(): T {
        return { ...this._record };
    }

    /**
     * Saves all current changes and commits them to Supabase.
     * If called while a save is already in flight, changes made in the meantime are saved
     * straight after (they are no longer dropped).
     * @returns true if the record has no unsaved changes afterwards.
     */
    public save(): Promise<boolean> {
        if (this._savePromise) {
            this._saveAgain = true;
            return this._savePromise;
        }
        if (!this.hasChanges) return Promise.resolve(true);

        this._state.isSaving = true;
        this._savePromise = (async () => {
            let ok = true;
            try {
                do {
                    this._saveAgain = false;
                    if (!this.hasChanges) break;
                    ok = await this._dataObject.update(this.id, { ...this._pendingChanges }, true);
                } while (ok && this._saveAgain);
                return ok;
            } finally {
                this._state.isSaving = false;
                this._savePromise = undefined;
            }
        })();
        return this._savePromise;
    }

    /** Attempts to delete the specified record. */
    public async delete(): Promise<void> {
        if (this._state.isDeleting) { return; }
        this._state.isDeleting = true;

        try {
            await this._dataObject.delete(this.id);
        } finally {
            this._state.isDeleting = false;
        }
    }

    /** Cancels all current changes and reverts the record back to its original state. */
    public revert(): void {
        const original = cloneRow(this._original);

        for (const key of Object.keys(original) as (keyof T)[]) {
            if (this._record[key] !== original[key]) {
                this._record[key] = original[key];
                this._onFieldChanged?.(this, key);
            }
        }

        this.clearChanges();
    }

    private clearChanges() {
        this._pendingChanges = {};
    }

    /**
     * Called by DataObject after saving, or when DataObject.update() is called and refresh is skipped, to ensure
     * server updates to records are synced.
     */
    public applyServerUpdates(updates: Partial<T> | null | undefined) {
        if (updates) {
            for (const key of Object.keys(updates) as (keyof T)[]) {
                this._record[key] = updates[key] as T[keyof T];
            }
        }

        this._original = cloneRow(this._record);
        this.clearChanges();
    }

    /**
     * Applies the server row returned after saving `saved`. Pending edits that were made
     * *while the save was in flight* (or that weren't part of `saved`) are kept as pending
     * instead of being overwritten or silently marked as original.
     * @internal Used by DataObject.update().
     */
    public commitSaved(saved: Partial<T>, serverRow: Partial<T> | null | undefined): void {
        const original = this._original as T;
        const row = (serverRow ?? saved) as Partial<T>;
        for (const key of Object.keys(row) as (keyof T)[]) {
            const serverValue = row[key] as T[keyof T];
            const pending = Object.prototype.hasOwnProperty.call(this._pendingChanges, key);
            const editedSince = pending && (!(key in saved) || this._pendingChanges[key] !== saved[key]);
            original[key] = serverValue;
            if (editedSince) continue;
            this._record[key] = serverValue;
            delete this._pendingChanges[key];
        }
        // Keys that were saved but not echoed back (e.g. RLS hides the row on select).
        for (const key of Object.keys(saved) as (keyof T)[]) {
            if (key in row) continue;
            if (this._pendingChanges[key] === saved[key]) {
                original[key] = saved[key] as T[keyof T];
                delete this._pendingChanges[key];
            }
        }
    }

    /**
     * Merges server-confirmed values into this record without touching unrelated pending changes.
     * - Keys not already on the record are ignored unless listed in `sentKeys`.
     * - Pending (unsaved) edits on keys that were NOT sent are kept; only their original is updated.
     * @internal Used by DataObject (optimistic bulk updates).
     */
    public mergeServerValues(values: Partial<T>, sentKeys: Set<string>): Partial<T> {
        const changed: Partial<T> = {};
        const original = this._original as T;
        for (const key of Object.keys(values) as (keyof T)[]) {
            const sent = sentKeys.has(key as string);
            if (!sent && !(key in (this._record as object))) continue;
            const v = values[key] as T[keyof T];
            original[key] = v;
            if (!sent && Object.prototype.hasOwnProperty.call(this._pendingChanges, key)) continue;
            if (this._record[key] !== v) changed[key] = v;
            this._record[key] = v;
            delete this._pendingChanges[key];
        }
        return changed;
    }

    /**
     * Refreshes the record with the latest data from the server. Any pending changes will be lost.
     * Calls made while a refresh is in flight are coalesced into one follow-up refresh.
     */
    public refresh(): Promise<void> {
        if (this._refreshPromise) {
            this._refreshAgain = true;
            return this._refreshPromise;
        }

        this._state.isRefreshing = true;
        this._refreshPromise = (async () => {
            try {
                do {
                    this._refreshAgain = false;
                    this.clearChanges();

                    const freshRecord = await this._dataObject.fetchRecordById(this.id);

                    if (!freshRecord) {
                        throw new Error(`Record with id ${this.id} could not be found`);
                    }

                    this.applyRefresh(freshRecord);
                } while (this._refreshAgain);
            } finally {
                this._state.isRefreshing = false;
                this._refreshPromise = undefined;
            }
        })();
        return this._refreshPromise;
    }

    private applyRefresh(record: T) {
        const oldRecord = this._record;
        const changed: Partial<T> = {};

        for (const key of Object.keys(record) as (keyof T)[]) {
            if (oldRecord[key] !== record[key]) {
                oldRecord[key] = record[key];
                changed[key] = record[key];
            }
        }

        this._original = cloneRow(oldRecord);
        this.clearChanges();

        if (Object.keys(changed).length > 0) {
            if (this._onServerSync) {
                this._onServerSync(this, changed);
            } else {
                for (const key of Object.keys(changed) as (keyof T)[]) this._onFieldChanged?.(this, key);
            }
        }
    }
}

export class DataRecordState {
    private _isRefreshing: boolean = false;
    private _isUpdating: boolean = false;
    private _isSaving: boolean = false;
    private _isDeleting: boolean = false;

    get isRefreshing() { return this._isRefreshing; }
    set isRefreshing(value: boolean) { this._isRefreshing = value; }

    get isUpdating() { return this._isUpdating; }
    set isUpdating(value: boolean) { this._isUpdating = value; }

    get isSaving() { return this._isSaving; }
    set isSaving(value: boolean) { this._isSaving = value; }

    get isDeleting() { return this._isDeleting; }
    set isDeleting(value: boolean) { this._isDeleting = value; }

    public reset() {
        this.isRefreshing = false;
        this.isUpdating = false;
        this.isSaving = false;
        this.isDeleting = false;
    }
}
