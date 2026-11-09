// Main exports for the supabase-dataobject-core package

// Core classes
export { DataObject, createDataObject as createDataObjectDirect } from './dataObject';
export { DataObjectManager } from './dataObjectManager';
export type { DataObjectManagerConfig } from './dataObjectManager';
export { EventEmitter } from './eventEmitter';

// Global convenience functions
export {
    getDataObjectById,
    createDataObject,
    getAllDataObjects,
    removeDataObject,
    refreshDataObject
} from './dataObjectManager';

// Types and interfaces
export type {
    DataObjectFieldType,
    SupportedOperator,
    DataObjectField,
    SortConfig,
    WhereClause,
    DataObjectOptions,
    SupabaseConfig,
    DataObjectRecord,
    NamedDataObjectOptions,
    StoredDataObject,
    MasterDataObjectBinding,
    DataRecordKey,
    GroupByConfig,
    RelationshipConfig,
    DataObjectEvents,
    DataObjectCancelableEvent
} from './types';

export type { DataObjectErrorHandler } from './dataObject';
export type { DataRecord } from './dataRecord';
export type { DataObjectState } from './dataObjectState';
export type { DataObjectGroup } from './grouping';

// Utility functions for initialization
import { DataObjectManager, type DataObjectManagerConfig } from './dataObjectManager';

export function initializeDataObjectManager(config: DataObjectManagerConfig): DataObjectManager {
    return DataObjectManager.getInstance(config);
}

export function updateDataObjectManagerConfig(config: DataObjectManagerConfig): void {
    DataObjectManager.setConfig(config);
}
