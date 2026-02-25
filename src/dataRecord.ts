import { DataObject } from "./dataObject";
import { DataObjectField } from "./types";

export class DataRecord<T extends { id: unknown }> {
    public readonly index: number;
    public readonly fields: DataObjectField[];

    private _dataObject: DataObject<T>;
    private _state = new DataRecordState();
    private _onFieldChanged?: (record: DataRecord<T>, field: keyof T) => void;

    private _original: Readonly<T>;
    private _pendingChanges: Partial<T> = {};

    private _record: T;

    get id(): T["id"] {
        return this._record.id;
    }

    get hasChanges(): boolean {
        return Object.keys(this._pendingChanges).length > 0;
    }

    get changes(): Readonly<Partial<T>> {
        return this._pendingChanges;
    }

    get isCurrent(): boolean {
        return this._record.id === this._dataObject.currentRecord?.id;
    }

    constructor(
        index: number,
        fields: DataObjectField[],
        rawRecord: T,
        dataObject: DataObject<T>,
        onFieldChanged?: (record: DataRecord<T>, field: keyof T) => void
    ) {
        this._record = rawRecord;
        this.index = index;
        this.fields = fields;
        this._onFieldChanged = onFieldChanged;
        this._dataObject = dataObject;

        this._original = structuredClone(rawRecord);

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
            }
        };

        return new Proxy(this, handler) as unknown as DataRecord<T> & T;
    }

    /** Saves all current changes and commits them to Supabase. */
    public async save(): Promise<void> {
        if (!this.hasChanges) return;
        
        if (this._state.isSaving) { return; }
        this._state.isSaving = true;

        try {
            await this._dataObject.update(this.id, this._pendingChanges, true);
            // this._original = structuredClone(this._record);
            // this.clearChanges();
        } finally {
            this._state.isSaving = false;
        }
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
        const original = structuredClone(this._original);

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
    public applyServerUpdates(updates: Partial<T>) {
        for (const key of Object.keys(updates) as (keyof T)[]) {
            this._record[key] = updates[key] as T[keyof T];
        }

        this._original = structuredClone(this._record);
        this.clearChanges();
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