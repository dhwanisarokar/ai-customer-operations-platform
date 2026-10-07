/**
 * Returns a function yielding strictly increasing timestamps (1 ms apart) starting now. Rows
 * written by one operation (a message and its events) get distinct, correctly ordered times, so
 * timelines never depend on arbitrary tie-breaking between rows created in the same millisecond.
 */
export function timestampSequence(start: Date = new Date()): () => Date {
  let offset = 0;
  return () => new Date(start.getTime() + offset++);
}
