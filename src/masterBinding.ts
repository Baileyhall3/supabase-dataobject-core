import { DataObject, DataObjectErrorHandler } from "./dataObject";
import type { MasterDataObjectBinding, WhereClause } from "./types";

export class MasterBinding {
    private _masterDataObject!: DataObject<any>;
    private _childDataObject: DataObject<any>;
    private _bindingDef: MasterDataObjectBinding;
    private _masterDataChangeListener!: (() => void);
    private _bindingWhereClause: WhereClause | undefined = undefined;
    private _errorHandler?: DataObjectErrorHandler;

    public get bindingDefinition(): MasterDataObjectBinding {
        return this._bindingDef;
    }

    public get bindingWhereClause(): WhereClause | undefined {
        return this._bindingWhereClause;
    }

    public get masterDataObject(): DataObject<any> {
        return this._masterDataObject;
    }

    constructor(
        child: DataObject<any>,
        bindingDef: MasterDataObjectBinding,
        errorHandler?: DataObjectErrorHandler
    ) {
        this._childDataObject = child;
        this._bindingDef = bindingDef;
        this._errorHandler = errorHandler;
    }

    async initialize() {
        try {
            const masterDataObject = await this.getMasterDataObjectFromManager(this._bindingDef.masterDataObjectId);
            
            if (!masterDataObject) {
                if (this._errorHandler?.onWarning) {
                    this._errorHandler?.onWarning(`Data object ${this._bindingDef.masterDataObjectId} does not exist. Cannot complete master binding.`);
                }
                return;
            }

            this._masterDataObject = masterDataObject;
            await this._masterDataObject.waitForReady();

            if (!this.validateBindingFields()) {
                if (this._errorHandler?.onWarning) {
                    this._errorHandler?.onWarning(`Binding fields could not be validated. Cannot complete master binding.`);
                }
                return;
            }

            this.addMasterBindingWhereClause();
            this.setupMasterDataChangeListener();

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
     * Check if child and master binding field exists in respective fields
     * @returns true if both fields were found, false otherwise.
     */
    private validateBindingFields(): boolean {
        const childFieldExists = this._childDataObject.fields.some(field => field.name === this._bindingDef.childBindingField);
        if (!childFieldExists) {
            return false;
        }

        const masterFieldExists = this._masterDataObject.fields.some(field => field.name === this._bindingDef.masterBindingField);
        if (!masterFieldExists) {
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
            value: masterFieldValue
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

        this._masterDataChangeListener = () => {
            this.onMasterDataChanged();
        };

        this._masterDataObject.on('currentRecordChanged', this._masterDataChangeListener);
        this._masterDataObject.on('afterRefresh', () => {
            if (this._childDataObject.options.autoRefresh) {
                this._childDataObject.refresh();
            }
        });
    }

    /**
     * Function which is called when the master data object's currentRecord is updated.
     * Updates binding where clause with new one based on master data object's currentRecord.
     */
    private async onMasterDataChanged(): Promise<void> {
        this.addMasterBindingWhereClause();
    }

    public dispose(): void {
        if (this._masterDataObject && this._masterDataChangeListener) {
            this._masterDataObject.off('currentRecordChanged', this._masterDataChangeListener);
        }

        this._bindingWhereClause = undefined;
        this._masterDataChangeListener = undefined!;
    }
}