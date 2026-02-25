export class DataRecordState {
    private _isRefreshing: boolean = false;
    private _isUpdating: boolean = false;
    private _isSaving: boolean = false;
    private _isDeleting: boolean = false;

    get isRefreshing() { return this._isRefreshing; }
    set isRefreshing(value: boolean) { this._isRefreshing = value; }
    
    get isUpdating() { return this._isUpdating; }
    set isUpdating(value: boolean) { this._isUpdating = value; }

    get isSaving() { return this._isSaving; }
    set isSaving(value: boolean) { this._isSaving = value; }

    get isDeleting() { return this._isDeleting; }
    set isDeleting(value: boolean) { this._isDeleting = value; }

    public reset() {
        this.isRefreshing = false;
        this.isUpdating = false;
        this.isSaving = false;
        this.isDeleting = false;
    }
}
