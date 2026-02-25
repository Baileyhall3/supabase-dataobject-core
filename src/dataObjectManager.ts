import { DataObject, DataObjectErrorHandler } from './dataObject';
import type { DataObjectOptions, SupabaseConfig, StoredDataObject, DataRecordKey } from './types';
import { EventEmitter } from './eventEmitter';

export interface DataObjectManagerConfig {
    supabaseConfig: SupabaseConfig;
    errorHandler?: DataObjectErrorHandler;
}

export class DataObjectManager {
    private static instance: DataObjectManager;
    private dataObjects: Map<string, StoredDataObject<any>> = new Map();
    private config: DataObjectManagerConfig;
    private eventEmitter = new EventEmitter<StoredDataObject<any>[]>();
    
    public readonly onDataObjectsChanged = this.eventEmitter.event;

    private constructor(config: DataObjectManagerConfig) {
        this.config = config;
    }

    public static getInstance(config?: DataObjectManagerConfig): DataObjectManager {
        if (!DataObjectManager.instance) {
            if (!config) {
                throw new Error('DataObjectManager must be initialized with config first');
            }
            DataObjectManager.instance = new DataObjectManager(config);
        }
        return DataObjectManager.instance;
    }

    public static setConfig(config: DataObjectManagerConfig): void {
        if (DataObjectManager.instance) {
            DataObjectManager.instance.config = config;
        }
    }

    public async createDataObject<T extends DataRecordKey>(
        name: string,
        options: DataObjectOptions<T>
    ): Promise<DataObject<T> | null> {
        // Check if name already exists
        if (this.dataObjects.has(name)) {
            const errorMsg = `Data object with name '${name}' already exists. Please choose a different name.`;
            if (this.config.errorHandler?.onError) {
                this.config.errorHandler.onError(errorMsg);
            } else {
                console.error(errorMsg);
            }
            return null;
        }

        try {
            // If there's a master data object binding, check if the master exists
            if (options.masterDataObjectBinding) {
                const masterExists = this.dataObjects.has(options.masterDataObjectBinding.masterDataObjectId);
                if (!masterExists) {
                    const warningMsg = `Master data object '${options.masterDataObjectBinding.masterDataObjectId}' not found. Creating data object '${name}' without binding.`;
                    if (this.config.errorHandler?.onWarning) {
                        this.config.errorHandler.onWarning(warningMsg);
                    } else {
                        console.warn(warningMsg);
                    }
                    // Remove the binding from options to prevent errors
                    options = { ...options, masterDataObjectBinding: undefined };
                }
            }

            const dataObject = new DataObject<T>(
                this.config.supabaseConfig, 
                options, 
                name,
                this.config.errorHandler,
            );
            
            // Wait for the data object to be ready (data loaded)
            await dataObject.waitForReady();
            
            const storedDataObject: StoredDataObject<T> = {
                id: name,
                name,
                options,
                dataObject,
                createdAt: new Date()
            };

            this.dataObjects.set(name, storedDataObject);
            this.eventEmitter.fire(Array.from(this.dataObjects.values()));

            const successMsg = `Data object '${name}' created successfully!`;
            if (this.config.errorHandler?.onInfo) {
                this.config.errorHandler.onInfo(successMsg);
            } else {
                console.info(successMsg);
            }
            
            return dataObject;
        } catch (error) {
            const errorMsg = `Error creating data object '${name}': ${error}`;
            if (this.config.errorHandler?.onError) {
                this.config.errorHandler.onError(errorMsg);
            } else {
                console.error(errorMsg);
            }
            return null;
        }
    }

    public getDataObjectById<T extends DataRecordKey>(
        id: string
    ): DataObject<T> | null {
        return this.dataObjects.get(id)?.dataObject as DataObject<T> | null;
    }

    public getAllDataObjects(): StoredDataObject<DataRecordKey>[] {
        return Array.from(this.dataObjects.values());
    }

    public removeDataObject(id: string): boolean {
        const storedDataObject = this.dataObjects.get(id);
        if (storedDataObject) {
            storedDataObject.dataObject.dispose();
            this.dataObjects.delete(id);
            this.eventEmitter.fire(Array.from(this.dataObjects.values()));
            
            const successMsg = `Data object '${id}' removed successfully!`;
            if (this.config.errorHandler?.onInfo) {
                this.config.errorHandler.onInfo(successMsg);
            } else {
                console.info(successMsg);
            }
            return true;
        }
        return false;
    }

    public async refreshDataObject(id: string): Promise<boolean> {
        const storedDataObject = this.dataObjects.get(id);
        if (storedDataObject) {
            try {
                await storedDataObject.dataObject.refresh();
                return true;
            } catch (error) {
                const errorMsg = `Error refreshing data object '${id}': ${error}`;
                if (this.config.errorHandler?.onError) {
                    this.config.errorHandler.onError(errorMsg);
                } else {
                    console.error(errorMsg);
                }
                return false;
            }
        }
        return false;
    }

    public clearAllDataObjects(): void {
        this.dataObjects.forEach(storedDataObject => {
            storedDataObject.dataObject.dispose();
        });
        this.dataObjects.clear();
        this.eventEmitter.fire([]);
    }

    public dispose(): void {
        this.clearAllDataObjects();
        this.eventEmitter.dispose();
    }

    public updateConfig(config: DataObjectManagerConfig): void {
        this.config = config;
    }

    public getConfig(): DataObjectManagerConfig {
        return { ...this.config };
    }
}

// Global functions that can be used anywhere
export function getDataObjectById<T extends DataRecordKey>(
    id: string
): DataObject<T> | null {
    try {
        const manager = DataObjectManager.getInstance();
        return manager.getDataObjectById<T>(id);
    } catch (error) {
        console.error('DataObjectManager not initialized:', error);
        return null;
    }
}

export async function createDataObject<T extends DataRecordKey>(
    name: string,
    options: DataObjectOptions<T>
): Promise<DataObject<T> | null> {
    try {
        const manager = DataObjectManager.getInstance();
        return await manager.createDataObject<T>(name, options);
    } catch (error) {
        console.error('DataObjectManager not initialized:', error);
        return null;
    }
}

export function getAllDataObjects(): StoredDataObject<DataRecordKey>[] {
    try {
        const manager = DataObjectManager.getInstance();
        return manager.getAllDataObjects();
    } catch (error) {
        console.error('DataObjectManager not initialized:', error);
        return [];
    }
}

export function removeDataObject(id: string): boolean {
    try {
        const manager = DataObjectManager.getInstance();
        return manager.removeDataObject(id);
    } catch (error) {
        console.error('DataObjectManager not initialized:', error);
        return false;
    }
}

export async function refreshDataObject(id: string): Promise<boolean> {
    try {
        const manager = DataObjectManager.getInstance();
        return await manager.refreshDataObject(id);
    } catch (error) {
        console.error('DataObjectManager not initialized:', error);
        return false;
    }
}
