import type { DataObjectRecord, DataRecordKey, GroupByConfig } from './types';

export interface DataObjectGroup<T extends DataRecordKey> {
    groupValue: any;
    records: DataObjectRecord<T>[];
    aggregates: Record<string, number>;
    additionalFields: Record<string, any>;
}

/**
 * Groups records by `groupBy.field` and computes aggregates in a single pass per group.
 * Pure function extracted from DataObject. Results are identical to the previous
 * implementation, but min/max no longer spread values into Math.min/Math.max
 * (which overflows the call stack on very large groups).
 */
export function groupRecords<T extends DataRecordKey>(
    data: DataObjectRecord<T>[],
    groupBy: GroupByConfig<T> | undefined,
    onWarning?: (message: string) => void
): DataObjectGroup<T>[] {
    if (!groupBy || !groupBy.field) {
        return [];
    }

    const groups = new Map<unknown, DataObjectRecord<T>[]>();
    for (const record of data) {
        const key = record[groupBy.field];
        let bucket = groups.get(key);
        if (!bucket) {
            bucket = [];
            groups.set(key, bucket);
        }
        bucket.push(record);
    }

    const aggregateEntries = groupBy.aggregates ? Object.entries(groupBy.aggregates) : [];
    const additionalFields = groupBy.additionalFields ?? [];
    const results: DataObjectGroup<T>[] = [];

    for (const [groupValue, records] of groups) {
        const aggregates: Record<string, number> = {};

        for (const [alias, { op, field }] of aggregateEntries) {
            if (op === 'count') {
                aggregates[alias] = records.length;
                continue;
            }

            let sum = 0;
            let min = Infinity;
            let max = -Infinity;
            const n = field ? records.length : 0;

            for (let i = 0; i < n; i++) {
                const v = Number(records[i][field!] as unknown);
                sum += v || 0;
                if (!isNaN(v)) {
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
            }

            switch (op) {
                case 'sum':
                    aggregates[alias] = sum;
                    break;
                case 'avg':
                    aggregates[alias] = n ? sum / n : 0;
                    break;
                case 'min':
                    aggregates[alias] = min;
                    break;
                case 'max':
                    aggregates[alias] = max;
                    break;
                default:
                    onWarning?.(`Unknown aggregate operation: ${op}`);
            }
        }

        const additional: Record<string, any> = {};
        if (additionalFields.length > 0) {
            const first = records[0];
            for (const f of additionalFields) {
                additional[f as string] = first?.[f];
            }
        }

        results.push({ groupValue, records, aggregates, additionalFields: additional });
    }

    return results;
}
