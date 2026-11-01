import { type TSchema, type TUnsafe, Type } from "typebox";

/** Preserve the literal union inferred from a readonly value vocabulary. */
export function vocabularySchema<const T extends readonly string[]>(values: T): TUnsafe<T[number]> {
    const literals = values.map((value) => Type.Literal(value)) as unknown as [
        TSchema,
        ...TSchema[],
    ];
    return Type.Unsafe<T[number]>(Type.Union(literals));
}
