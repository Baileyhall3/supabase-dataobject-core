import { DataObject, DataObjectErrorHandler } from './dataObject';
import { DataObjectOptions, SupabaseConfig, StoredDataObject } from './types';
import { EventEmitter } from './eventEmitter';

export interface DataObjectManagerConfig {
    supabaseConfig: SupabaseConfig;
    errorHandler?: DataObjectErrorHandler;
}

export class DataObjectManager {
    private static instance: DataObjectManager;
    private dataObjects: Map<string, StoredDataObject> = new Map();
    private config: DataObjectManagerConfig;
    private eventEmitter = new EventEmitter<StoredDataObject[]>();
    
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

    public async createDataObject(name: string, options: DataObjectOptions): Promise<DataObject | null> {
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
            const dataObject = new DataObject(this.config.supabaseConfig, options, this.config.errorHandler);
            
            // Wait for the data object to be ready (data loaded)
            await dataObject.waitForReady();
            
            const storedDataObject: StoredDataObject = {
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

    public getDataObjectById(id: string): DataObject | null {
        const storedDataObject = this.dataObjects.get(id);
        return storedDataObject ? storedDataObject.dataObject : null;
    }

    public getAllDataObjects(): StoredDataObject[] {
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
export function getDataObjectById(id: string): DataObject | null {
    try {
        const manager = DataObjectManager.getInstance();
        return manager.getDataObjectById(id);
    } catch (error) {
        console.error('DataObjectManager not initialized:', error);
        return null;
    }
}

export async function createDataObject(name: string, options: DataObjectOptions): Promise<DataObject | null> {
    try {
        const manager = DataObjectManager.getInstance();
        return await manager.createDataObject(name, options);
    } catch (error) {
        console.error('DataObjectManager not initialized:', error);
        return null;
    }
}

export function getAllDataObjects(): StoredDataObject[] {
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
