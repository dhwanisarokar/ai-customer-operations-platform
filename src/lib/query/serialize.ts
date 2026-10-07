/** What a value looks like after crossing the network as JSON: Dates become ISO strings. */
export type Serialized<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Serialized<U>[]
    : T extends object
      ? { [K in keyof T]: Serialized<T[K]> }
      : T;

/**
 * Converts server-side data (Dates, Prisma types) into exactly the shape the JSON API returns, so
 * server-rendered `initialData` and client-fetched data are interchangeable in the query cache.
 */
export function serialize<T>(value: T): Serialized<T> {
  return JSON.parse(JSON.stringify(value)) as Serialized<T>;
}
