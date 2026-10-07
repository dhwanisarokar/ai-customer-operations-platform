import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";
import { getServerEnv } from "@/lib/env";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getServerEnv().DATABASE_URL });
  return new PrismaClient({ adapter });
}

/** Shared Prisma client (reused across hot reloads in development). */
export function getDb(): PrismaClient {
  globalForPrisma.prisma ??= createClient();
  return globalForPrisma.prisma;
}

/** Either the shared client or an interactive-transaction client; repositories accept both. */
export type Db = PrismaClient | Prisma.TransactionClient;

/** Runs `work` in a single database transaction; any thrown error rolls everything back. */
export function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return getDb().$transaction(work);
}
