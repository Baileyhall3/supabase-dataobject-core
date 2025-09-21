// Main exports for the supabase-dataobject-core package

// Core classes
export { DataObject, createDataObject as createDataObjectDirect } from './dataObject';
export { DataObjectManager, DataObjectManagerConfig } from './dataObjectManager';
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
    MasterDataObjectBinding
} from './types';

export type { DataObjectErrorHandler } from './dataObject';

// Utility functions for initialization
import { DataObjectManager, DataObjectManagerConfig } from './dataObjectManager';

export function initializeDataObjectManager(config: DataObjectManagerConfig): DataObjectManager {
    return DataObjectManager.getInstance(config);
}

export function updateDataObjectManagerConfig(config: DataObjectManagerConfig): void {
    DataObjectManager.setConfig(config);
}
