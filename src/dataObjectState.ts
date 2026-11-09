import { ReactiveSignal, type MakeReactive } from './reactivity';

export class DataObjectState {
    private _isReady: boolean = false;
    private _isRefreshing: boolean = false;
    private _isUpdating: boolean = false;
    private _isSaving: boolean = false;
    private _isDestroyed: boolean = false;
    private _isInserting: boolean = false;
    private _isDeleting: boolean = false;

    /** Lets UI frameworks observe the flags below (see `makeReactive`). */
    private readonly _signal: ReactiveSignal;

    constructor(makeReactive?: MakeReactive | false) {
        this._signal = new ReactiveSignal(makeReactive);
    }

    private read<V>(value: V): V {
        this._signal.track();
        return value;
    }

    private changed(previous: boolean, next: boolean): void {
        if (previous !== next) this._signal.trigger();
    }

    get isReady() { return this.read(this._isReady); }
    set isReady(value: boolean) { const p = this._isReady; this._isReady = value; this.changed(p, value); }

    get isRefreshing() { return this.read(this._isRefreshing); }
    set isRefreshing(value: boolean) { const p = this._isRefreshing; this._isRefreshing = value; this.changed(p, value); }

    get isUpdating() { return this.read(this._isUpdating); }
    set isUpdating(value: boolean) { const p = this._isUpdating; this._isUpdating = value; this.changed(p, value); }

    get isSaving() { return this.read(this._isSaving); }
    set isSaving(value: boolean) { const p = this._isSaving; this._isSaving = value; this.changed(p, value); }

    get isDestroyed() { return this.read(this._isDestroyed); }
    set isDestroyed(value: boolean) { const p = this._isDestroyed; this._isDestroyed = value; this.changed(p, value); }

    get isInserting() { return this.read(this._isInserting); }
    set isInserting(value: boolean) { const p = this._isInserting; this._isInserting = value; this.changed(p, value); }

    get isDeleting() { return this.read(this._isDeleting); }
    set isDeleting(value: boolean) { const p = this._isDeleting; this._isDeleting = value; this.changed(p, value); }

    // public get isBusy(): boolean {
    //     return this.isRefreshing || this.isUpdating;
    // }

    public reset() {
        this.isReady = false;
        this.isRefreshing = false;
        this.isUpdating = false;
        this.isSaving = false
        this.isDestroyed = false;
        this.isInserting = false;
        this.isDeleting = false;
    }
}
