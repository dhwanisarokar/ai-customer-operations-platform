import { z } from "zod";
import { NotFoundError } from "@/server/errors";

/** Malformed ids are reported as 404 so probing cannot distinguish them from foreign tenants. */
export function parseUuidParam(value: string, what: string): string {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new NotFoundError(`${what} not found`);
  return parsed.data;
}
