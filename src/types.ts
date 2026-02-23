export type DataObjectFieldType = 'string' | 'bit' | 'Date' | 'number';

export type SupportedOperator = 'equals' | 'notequals' | 'greaterthan' | 'lessthan' | 'isnull' | 'isnotnull' | 'like' | 'ilike';

export interface DataObjectField {
    name: string;
    type?: DataObjectFieldType;
}

export interface SortConfig {
    field: string;
    direction: 'asc' | 'desc';
}

export interface WhereClause {
    field: string;
    operator: SupportedOperator;
    value?: any;
}

export interface MasterDataObjectBinding {
    masterDataObjectId: string;
    childBindingField: string;
    masterBindingField: string;
}

export interface GroupByConfig {
    field: string;
    aggregates?: {
        [alias: string]: {
            op: 'sum' | 'avg' | 'count' | 'min' | 'max';
            field?: string;
        };
    };
    /** Fields which will also be taken from the first record found when grouping. */
    additionalFields?: string[];
}

export interface DataObjectOptions {
    /** The name of the view to select data from. */
    viewName: string;
    /** The table for which to perform CRUD operations on. */
    tableName?: string;
    /** An array of fields from the view to get values from. Data will be returned for the specified fields only.
     * Leave blank to include all fields.
     */
    fields?: DataObjectField[];
    /** Array of where clauses to be applied when retrieving data from the view. */
    whereClauses?: WhereClause[];
    /** Sorting to be applied to the returned data based on specified field and direction. */
    sort?: SortConfig;
    /** When specified, will only return the first x amount of records.
     * Leave blank to return all records.
     */
    recordLimit?: number;
    /** Controls whether or not the data object can be inserted into.
     * Will be overridden to false if no tableName defined as cannnot insert into a view.
     * Default is false.
     */
    canInsert?: boolean;
    /** Controls whether a data object can be updated.
     * Will be overriden to false if no tableName defined, as cannot update records from a view.
     * Default is false.
     */
    canUpdate?: boolean;
    /** Controls whether a data object can be updated.
     * Will be overriden to false if no tableName defined, as cannot delete from a view.
     * Default is false.
     */
    canDelete?: boolean;
    /** The binding to this data object's master data object. 
     * Use this when the currentRecord of one data object directly informs the returned data of the other.
     * The master data object must be defined and initialized first, before adding a child data object.
     * When defining thebinding fields, note that their values must match identically for this to work.
     */
    masterDataObjectBinding?: MasterDataObjectBinding;
    /** Controls whether the data object should refresh without prompt.
     * If false, the data object will not refresh unless explicitly called.
     * If true, the data object will refresh on initialization, and when its master data object refreshes.
     * Default is true.
     */
    autoRefresh?: boolean;
    /** Configuration for grouping to be applied to the data object. */
    groupBy?: GroupByConfig;
    /** Array of bucket names which are allowed to be uploaded to. Leave empty to allow upload to all buckets. */
    allowedBuckets?: string[]
}

export interface SupabaseConfig {
    url: string;
    anonKey: string;
    projectName?: string;
}

export interface DataObjectRecord {
    [key: string]: any;
}

export interface NamedDataObjectOptions extends DataObjectOptions {
    name: string; // This will be the ID for accessing the data object
}

export interface StoredDataObject {
    id: string;
    name: string;
    options: DataObjectOptions;
    dataObject: any; // Will be properly typed when DataObject is imported
    createdAt: Date;
}

export type DataObjectEvents = {
    beforeLoad: [options: DataObjectCancelableEvent & DataObjectOptions];
    afterLoad: [data: DataObjectRecord[]];

    beforeRefresh: [options: DataObjectCancelableEvent & DataObjectOptions];
    afterRefresh: [data: DataObjectRecord[]];

    beforeInsert: [options: DataObjectCancelableEvent & DataObjectOptions, record: Partial<DataObjectRecord>];
    afterInsert: [record: DataObjectRecord];

    beforeUpdate: [options: DataObjectCancelableEvent & DataObjectOptions, record: DataObjectRecord, updates: Partial<DataObjectRecord>];
    afterUpdate: [record: DataObjectRecord, updates: Partial<DataObjectRecord>];

    beforeDelete: [options: DataObjectCancelableEvent & DataObjectOptions, record: DataObjectRecord];
    afterDelete: [id: string | number];

    fieldChanged: [record: DataObjectRecord, updates: Partial<DataObjectRecord>];

    currentRecordChanged: [previousRecord: DataObjectRecord | undefined, newRecord: DataObjectRecord | undefined]
}

export interface DataObjectCancelableEvent {
    cancelEvent?: boolean;
    cancel?: () => void;
}