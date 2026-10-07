/**
 * DEVELOPMENT-ONLY seed data. Never run against production.
 *
 *   npm run db:seed -- --org <organization-slug> [--count 40]
 *
 * Adds clearly fake customers (@seed.example.com), tags and timeline entries to an EXISTING
 * organization so the customer UI has something to show. Re-running is safe: customers are keyed
 * by their seed email and skipped when they already exist. Nothing here is used by the app itself.
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const FIRST = [
  "Ada",
  "Grace",
  "Alan",
  "Linus",
  "Margaret",
  "Dennis",
  "Barbara",
  "Ken",
  "Radia",
  "Tim",
];
const LAST = [
  "Lovelace",
  "Hopper",
  "Turing",
  "Torvalds",
  "Hamilton",
  "Ritchie",
  "Liskov",
  "Thompson",
  "Perlman",
  "Berners-Lee",
];
const COMPANIES = [
  "Analytical Engines",
  "Navy Labs",
  "Bletchley Works",
  "Kernel Co",
  "Apollo Systems",
  "Bell Labs",
];
const SOURCES = ["website", "referral", "event", "import"];
const TAGS = ["VIP", "Trial", "High Value", "Churn Risk"];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed demo data when NODE_ENV=production");
  }
  const slug = arg("org");
  if (!slug) throw new Error("Usage: npm run db:seed -- --org <organization-slug> [--count 40]");
  const count = Math.min(Number(arg("count") ?? 40) || 40, 500);

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const organization = await db.organization.findUnique({ where: { slug } });
    if (!organization) throw new Error(`No organization with slug "${slug}"`);
    const organizationId = organization.id;

    const tags: { id: string; name: string }[] = [];
    for (const name of TAGS) {
      tags.push(
        await db.tag.upsert({
          where: {
            organizationId_normalizedName: { organizationId, normalizedName: name.toLowerCase() },
          },
          create: { organizationId, name, normalizedName: name.toLowerCase() },
          update: {},
        }),
      );
    }

    let created = 0;
    for (let i = 0; i < count; i++) {
      const firstName = FIRST[i % FIRST.length];
      const lastName = LAST[(i * 3) % LAST.length];
      const email = `${firstName}.${lastName}.${i}@seed.example.com`.toLowerCase();
      if (
        await db.customer.findUnique({ where: { organizationId_email: { organizationId, email } } })
      ) {
        continue;
      }

      const createdAt = new Date(Date.now() - (count - i) * 36 * 3_600_000);
      const status = i % 11 === 0 ? "INACTIVE" : "ACTIVE";
      await db.$transaction(async (tx) => {
        const customer = await tx.customer.create({
          data: {
            organizationId,
            firstName,
            lastName,
            email,
            phone: `+1555010${String(1000 + i).slice(-4)}`,
            company: COMPANIES[i % COMPANIES.length],
            jobTitle: i % 3 === 0 ? "Engineer" : "Manager",
            source: SOURCES[i % SOURCES.length],
            status,
            createdAt,
            updatedAt: createdAt,
            lastActivityAt: createdAt,
          },
        });
        await tx.customerActivity.create({
          data: {
            organizationId,
            customerId: customer.id,
            type: "CUSTOMER_CREATED",
            title: "Customer created",
            metadata: { seed: true },
            actorType: "SYSTEM",
            createdAt,
          },
        });
        if (i % 3 === 0) {
          const tag = tags[i % tags.length];
          const taggedAt = new Date(createdAt.getTime() + 3_600_000);
          await tx.customerTag.create({
            data: { organizationId, customerId: customer.id, tagId: tag.id },
          });
          await tx.customerActivity.create({
            data: {
              organizationId,
              customerId: customer.id,
              type: "TAG_ADDED",
              title: `Tag "${tag.name}" added`,
              metadata: { tagId: tag.id, tagName: tag.name, seed: true },
              actorType: "SYSTEM",
              createdAt: taggedAt,
            },
          });
          await tx.customer.update({
            where: { id: customer.id },
            data: { lastActivityAt: taggedAt },
          });
        }
      });
      created++;
    }

    console.log(`Seeded ${created} customers (${count - created} already existed) in "${slug}".`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
