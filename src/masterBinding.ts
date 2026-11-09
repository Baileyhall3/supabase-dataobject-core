import { DataObject, DataObjectErrorHandler } from "./dataObject";
import type { MasterDataObjectBinding, WhereClause, DataRecordKey } from "./types";

/** Child events that mean the child's rows changed on the server. */
const CHILD_CHANGE_EVENTS = [
    'afterInsert', 'afterUpdate', 'afterDelete',
    'afterBulkInsert', 'afterBulkUpdate', 'afterBulkDelete',
] as const;

export class MasterBinding<
    TMaster extends DataRecordKey,
    TChild extends DataRecordKey
> {
    private _masterDataObject!: DataObject<TMaster>;
    private _childDataObject: DataObject<TChild>;
    private _bindingDef: MasterDataObjectBinding<TChild>;
    private _bindingWhereClause?: WhereClause<TChild>;
    private _errorHandler?: DataObjectErrorHandler;

    /** Unsubscribe functions for every listener this binding registers (master + child). */
    private _unsubscribers: Array<() => void> = [];

    private _masterRefreshTimer?: ReturnType<typeof setTimeout>;
    private _masterRefreshPendingAfterSave = false;

    public get bindingDefinition(): MasterDataObjectBinding<TChild> {
        return this._bindingDef;
    }

    public get bindingWhereClause(): WhereClause<TChild> | undefined {
        return this._bindingWhereClause;
    }

    public get masterDataObject(): DataObject<TMaster> {
        return this._masterDataObject;
    }

    constructor(
        child: DataObject<TChild>,
        bindingDef: MasterDataObjectBinding<TChild>,
        errorHandler?: DataObjectErrorHandler
    ) {
        this._childDataObject = child;
        this._bindingDef = bindingDef;
        this._errorHandler = errorHandler;
    }

    async initialize() {
        try {
            const masterDataObject = await this.getMasterDataObjectFromManager(
                this._bindingDef.masterDataObjectId
            ) as DataObject<TMaster> | null;

            if (!masterDataObject) {
                if (this._errorHandler?.onWarning) {
                    this._errorHandler?.onWarning(`Data object ${this._bindingDef.masterDataObjectId} does not exist. Cannot complete master binding.`);
                }
                return;
            }

            this._masterDataObject = masterDataObject as DataObject<TMaster>;
            await this._masterDataObject.waitForReady();

            if (!this.validateBindingFields()) {
                if (this._errorHandler?.onWarning) {
                    this._errorHandler?.onWarning(`Binding fields could not be validated. Cannot complete master binding.`);
                }
                return;
            }

            this.addMasterBindingWhereClause();
            this.setupMasterDataChangeListener();
            this.setupChildChangeListener();

            this._masterDataObject.registerChildDataObject(this._childDataObject);

            if (this._errorHandler?.onInfo) {
                this._errorHandler?.onInfo(`Master data object binding established with '${this._bindingDef.masterDataObjectId}'`);
            }
        } catch (error) {
            // Silently fail as requested
            if (this._errorHandler?.onError) {
                this._errorHandler?.onError(`Failed to setup master data object binding: ${error}`)
            }
            return;
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

    /**
     * Check if child and master binding field exists in respective fields.
     * A side whose fields aren't known yet (no explicit `fields` and nothing loaded) is not
     * rejected: a wrong field name then surfaces as a clear PostgREST error on load.
     * @returns true if both fields were found (or can't be checked yet), false otherwise.
     */
    private validateBindingFields(): boolean {
        const childFields = this._childDataObject.fields;
        if (childFields.length > 0 && !childFields.some(field => field.name === this._bindingDef.childBindingField)) {
            return false;
        }

        const masterFields = this._masterDataObject.fields;
        if (masterFields.length > 0 && !masterFields.some(field => field.name === this._bindingDef.masterBindingField)) {
            return false;
        }

        return true;
    }

    /**
     * Remove existing binding where clause and replace it with new one.
     */
    private addMasterBindingWhereClause(): void {
        this.removeMasterBindingWhereClause();

        if (!this._masterDataObject || !this._bindingDef) {
            return;
        }

        const masterCurrentRecord = this._masterDataObject.currentRecord;
        if (!masterCurrentRecord) {
            return;
        }

        const masterFieldValue = masterCurrentRecord[this._bindingDef.masterBindingField];
        if (masterFieldValue === undefined || masterFieldValue === null) {
            return;
        }

        this._bindingWhereClause = {
            field: this._bindingDef.childBindingField,
            operator: 'equals',
            value: masterFieldValue as TChild[keyof TChild]
        };
    }

    /**
     * Set bindingWhereClause to undefined.
     */
    private removeMasterBindingWhereClause(): void {
        if (!this._bindingDef || !this._bindingWhereClause) {
            return;
        }

        this._bindingWhereClause = undefined;
    }

    private setupMasterDataChangeListener(): void {
        if (!this._masterDataObject) {
            return;
        }

        this._unsubscribers.push(
            this._masterDataObject.on('currentRecordChanged', () => this.onMasterDataChanged())
        );

        this._unsubscribers.push(
            this._masterDataObject.on('afterRefresh', () => {
                const child = this._childDataObject;
                if (!child.options.autoRefresh || child.state.isDestroyed) return;
                // If the master's current record changed during this refresh, the master has
                // already started a child refresh with the new binding value; don't start a
                // second, redundant one.
                if (child.state.isRefreshing) return;
                child.refresh();
            })
        );
    }

    /**
     * When `refreshMasterOnChange` is set, re-fetch the master's current record after the
     * child changes data, so values the master derives from its children stay in sync.
     */
    private setupChildChangeListener(): void {
        if (!this._bindingDef.refreshMasterOnChange) return;

        const child = this._childDataObject;
        for (const evt of CHILD_CHANGE_EVENTS) {
            this._unsubscribers.push(
                child.on(evt as any, () => {
                    // During saveChanges() wait for the single afterSaveChanges event instead
                    // of re-fetching the master once per saved record.
                    if (child.state.isSaving) {
                        this._masterRefreshPendingAfterSave = true;
                        return;
                    }
                    this.scheduleMasterRecordRefresh();
                })
            );
        }
        this._unsubscribers.push(
            child.on('afterSaveChanges', () => {
                if (this._masterRefreshPendingAfterSave) {
                    this._masterRefreshPendingAfterSave = false;
                    this.scheduleMasterRecordRefresh();
                }
            })
        );
    }

    /** Coalesces bursts of child changes (same task) into one master record fetch. */
    private scheduleMasterRecordRefresh(): void {
        if (this._masterRefreshTimer !== undefined) return;
        this._masterRefreshTimer = setTimeout(() => {
            this._masterRefreshTimer = undefined;
            const master = this._masterDataObject;
            const id = master?.currentRecord?.id;
            if (!master || master.state.isDestroyed || id === undefined) return;
            // DataRecord.refresh() coalesces overlapping calls itself.
            master.refreshRecordById(id);
        }, 0);
    }

    /**
     * Function which is called when the master data object's currentRecord is updated.
     * Updates binding where clause with new one based on master data object's currentRecord.
     */
    private async onMasterDataChanged(): Promise<void> {
        this.addMasterBindingWhereClause();
    }

    public dispose(): void {
        for (const unsubscribe of this._unsubscribers) unsubscribe();
        this._unsubscribers = [];

        if (this._masterRefreshTimer !== undefined) {
            clearTimeout(this._masterRefreshTimer);
            this._masterRefreshTimer = undefined;
        }

        this._bindingWhereClause = undefined;
    }
}
