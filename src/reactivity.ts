/**
 * Framework-agnostic reactivity bridge.
 *
 * The library never imports a UI framework. Instead the consumer may pass their framework's
 * "make this object observable" function (Vue `reactive`, MobX `observable`, Solid `createMutable`, ...).
 * Each DataObject / DataRecord / state object keeps one tiny box created with it:
 *   - every public read calls `track()`   -> the framework records a dependency
 *   - every internal change calls `trigger()` -> the framework re-runs dependents
 * Without a `makeReactive` function both calls are no-ops, so there is no cost for other consumers.
 */

/**
 * A function that returns an observable version of the object passed in, e.g. Vue's `reactive`,
 * MobX's `observable` or Solid's `createMutable`. Typed loosely so those can be passed as-is.
 */
export type MakeReactive = (target: object) => object;

export class ReactiveSignal {
    private readonly _box: { v: number } | undefined;

    constructor(makeReactive?: MakeReactive | false | null) {
        this._box = makeReactive ? (makeReactive({ v: 0 }) as { v: number }) : undefined;
    }

    /** True when a reactivity function was supplied. */
    public get enabled(): boolean {
        return this._box !== undefined;
    }

    /** Register a dependency on this signal with the host framework. */
    public track(): void {
        if (this._box) void this._box.v;
    }

    /** Notify the host framework that whatever this signal guards has changed. */
    public trigger(): void {
        if (this._box) this._box.v++;
    }
}
