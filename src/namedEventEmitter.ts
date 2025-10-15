/**
 * Class for named events ('afterSave, currentRecordChanged, etc.)
 */
export class NamedEventEmitter<Events extends { [key: string]: any[] }> {
    private listeners: {
        [K in keyof Events]?: Array<(...args: Events[K]) => void>;
    } = {};

    public on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event]!.push(listener);
        return () => {
            const index = this.listeners[event]!.indexOf(listener);
            if (index !== -1) {
                this.listeners[event]!.splice(index, 1);
            }
        };
    }

    public once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void {
        const wrapper = (...args: Events[K]) => {
            this.off(event, wrapper);
            listener(...args);
        };
        this.on(event, wrapper);
    }

    public off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void {
        const list = this.listeners[event];
        if (!list) return;
        const index = list.indexOf(listener);
        if (index !== -1) list.splice(index, 1);
    }

    public emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
        this.listeners[event]?.forEach(listener => {
            try {
                listener(...args);
            } catch (error) {
                console.error(`Error in listener for event '${String(event)}':`, error);
            }
        });
    }

    public clearAll() {
        this.listeners = {};
    }
}
