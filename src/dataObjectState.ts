export class DataObjectState {
    private _isReady: boolean = false;
    private _isRefreshing: boolean = false;
    private _isUpdating: boolean = false;
    private _isSaving: boolean = false;
    private _isDestroyed: boolean = false;
    private _isInserting: boolean = false;
    private _isDeleting: boolean = false;

    get isReady() { return this._isReady; }
    set isReady(value: boolean) { this._isReady = value; }

    get isRefreshing() { return this._isRefreshing; }
    set isRefreshing(value: boolean) { this._isRefreshing = value; }
    
    get isUpdating() { return this._isUpdating; }
    set isUpdating(value: boolean) { this._isUpdating = value; }

    get isSaving() { return this._isSaving; }
    set isSaving(value: boolean) { this._isSaving = value; }

    get isDestroyed() { return this._isDestroyed; }
    set isDestroyed(value: boolean) { this._isDestroyed = value; }

    get isInserting() { return this._isInserting; }
    set isInserting(value: boolean) { this._isInserting = value; }

    get isDeleting() { return this._isDeleting; }
    set isDeleting(value: boolean) { this._isDeleting = value; }

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
    }
}
