import type { SupabaseClient } from '@supabase/supabase-js';
import type {
    DataObjectField,
    DataRecordKey,
    RelationshipConfig,
    SortConfig,
    WhereClause,
} from './types';

/**
 * Pure, side-effect-free helpers for building PostgREST select queries.
 * Extracted from DataObject so query construction can be reused (full loads,
 * single-record fetches) and reasoned about independently of DataObject state.
 */

export interface SelectQueryParams<T extends DataRecordKey> {
    viewName: string;
    fields?: DataObjectField<T>[];
    relationships?: RelationshipConfig[];
    whereClauses?: WhereClause<T>[];
    /** Extra equality filter, e.g. from a master binding. */
    bindingClause?: WhereClause<T>;
    sort?: SortConfig<T> | SortConfig<T>[];
    recordLimit?: number;
    /** Optional AbortSignal so superseded loads can be cancelled. */
    abortSignal?: AbortSignal;
}

/** Builds the `select` column list, including relationship embeds. */
export function buildSelectString<T extends DataRecordKey>(
    fields?: DataObjectField<T>[],
    relationships?: RelationshipConfig[]
): string {
    const selections: string[] = [];
    selections.push(fields && fields.length > 0 ? fields.map(f => String(f.name)).join(',') : '*');
    if (relationships?.length) {
        selections.push(buildRelationshipSelect(relationships));
    }
    return selections.join(',');
}

/**
 * Builds the select string for relationship embeds, e.g.
 * `owner:users!checklists_owner_id_fkey(id,username)`.
 */
export function buildRelationshipSelect(relationships: RelationshipConfig[]): string {
    return relationships
        .map((relationship) => {
            let relationshipName = relationship.name;

            if (relationship.alias) {
                relationshipName = `${relationship.alias}:${relationshipName}`;
            }

            if (relationship.foreignKey) {
                relationshipName += `!${relationship.foreignKey}`;
            }

            const fields = relationship.fields?.length
                ? relationship.fields.map(String)
                : ['*'];

            const nested = relationship.relationships?.length
                ? buildRelationshipSelect(relationship.relationships)
                : '';

            const selections = [...fields, nested].filter(Boolean).join(',');

            return `${relationshipName}(${selections})`;
        })
        .join(',');
}

/** Top-level keys that relationship embeds add to each returned row. */
export function relationshipKeys(relationships?: RelationshipConfig[]): Set<string> {
    return new Set((relationships ?? []).map(r => r.alias ?? r.name));
}

/** Applies a single where clause to a PostgREST filter builder. */
export function applyWhereClause<T extends DataRecordKey>(query: any, whereClause: WhereClause<T>): any {
    const field = whereClause.field as string;
    switch (whereClause.operator) {
        case 'equals':
            return query.eq(field, whereClause.value);
        case 'notequals':
            return query.neq(field, whereClause.value);
        case 'greaterthan':
            return query.gt(field, whereClause.value);
        case 'lessthan':
            return query.lt(field, whereClause.value);
        case 'isnull':
            return query.is(field, null);
        case 'isnotnull':
            return query.not(field, 'is', null);
        case 'like':
            return query.like(field, `%${whereClause.value}%`);
        case 'ilike':
            return query.ilike(field, `%${whereClause.value}%`);
        case 'in':
            return query.in(field, whereClause.value as any[]);
        case 'notin': {
            const values = whereClause.value as (string | number)[];
            const formattedValues = values
                .map(value => typeof value === 'string' ? `"${value.replace(/"/g, '\\"')}"` : value)
                .join(',');
            return query.not(field, 'in', `(${formattedValues})`);
        }
        default:
            return query;
    }
}

/** Normalises a single sort or sort array into priority order. */
export function normalizeSort<T extends DataRecordKey>(
    sort?: SortConfig<T> | SortConfig<T>[]
): Required<SortConfig<T>>[] {
    if (!sort) return [];

    const arr = Array.isArray(sort) ? sort : [sort];

    return arr
        .map((s, index) => ({
            field: s.field,
            direction: s.direction ?? 'asc',
            order: s.order ?? index,
        }))
        .sort((a, b) => a.order - b.order);
}

/** Builds a complete select query. Has no side effects. */
export function buildSelectQuery<T extends DataRecordKey>(
    supabase: SupabaseClient,
    params: SelectQueryParams<T>
): any {
    let query: any = supabase
        .from(params.viewName)
        .select(buildSelectString(params.fields, params.relationships));

    if (params.whereClauses) {
        for (const whereClause of params.whereClauses) {
            query = applyWhereClause(query, whereClause);
        }
    }

    if (params.bindingClause) {
        query = applyWhereClause(query, params.bindingClause);
    }

    for (const sort of normalizeSort(params.sort)) {
        query = query.order(sort.field as string, { ascending: sort.direction === 'asc' });
    }

    if (params.recordLimit) {
        query = query.limit(params.recordLimit);
    }

    // Guarded so custom/mocked clients without abortSignal() keep working.
    if (params.abortSignal && typeof query.abortSignal === 'function') {
        query = query.abortSignal(params.abortSignal);
    }

    return query;
}
