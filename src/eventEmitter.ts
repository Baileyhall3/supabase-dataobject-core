/**
 * Simple event emitter implementation to replace VSCode's EventEmitter
 */
export class EventEmitter<T> {
    private listeners: Array<(data: T) => void> = [];

    /**
     * Add a listener for the event
     */
    public on(listener: (data: T) => void): () => void {
        this.listeners.push(listener);
        
        // Return a dispose function
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index !== -1) {
                this.listeners.splice(index, 1);
            }
        };
    }

    /**
     * Fire the event to all listeners
     */
    public fire(data: T): void {
        this.listeners.forEach(listener => {
            try {
                listener(data);
            } catch (error) {
                console.error('Error in event listener:', error);
            }
        });
    }

    /**
     * Remove all listeners
     */
    public dispose(): void {
        this.listeners = [];
    }

    /**
     * Get the event interface for external use
     */
    public get event(): (listener: (data: T) => void) => () => void {
        return this.on.bind(this);
    }
}
