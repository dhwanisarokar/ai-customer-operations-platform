/**
 * Measures where time goes between "a conversation changes" and "the automation run is COMPLETED".
 * Development tool; never run by the test suite.
 *
 *   DATABASE_URL=... REDIS_URL=... BENCH_DB_RTT_MS=40 npx tsx scripts/automation-latency.ts
 *
 * It uses a scratch database (it only INSERTS fresh, uniquely named rows). Every database round trip
 * (including BEGIN/COMMIT) is counted and timed; BENCH_DB_RTT_MS adds an artificial network delay to
 * each one, to approximate a remote database such as Supabase. A real BullMQ worker consumes the
 * queue exactly as `npm run worker` does.
 */
import "dotenv/config";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { automationInputSchema } from "@/server/automation/definition";
import { getAutomationQueue } from "@/server/automation/queue";
import { processAutomationJob } from "@/server/automation/runner";
import { actionRegistry } from "@/server/automation/actions";
import { resolveOrganizationContext } from "@/server/auth/context";
import { getDb } from "@/db/client";
import { automationExecutionsRepository } from "@/server/repositories/automation-executions";
import { automationsRepository } from "@/server/repositories/automations";
import { customersRepository } from "@/server/repositories/customers";
import { membershipsRepository } from "@/server/repositories/memberships";
import { usersRepository } from "@/server/repositories/users";
import { createAutomation } from "@/server/services/automations";
import { createConversation, updateConversation } from "@/server/services/conversations";
import { createOrganization } from "@/server/services/organizations";

const RTT = Number(process.env.BENCH_DB_RTT_MS ?? 0);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- instrumentation ---------------------------------------------------------------------------
type Mark = { t: number; label: string };
let marks: Mark[] = [];
let queries: { start: number; ms: number; sql: string }[] = [];
const mark = (label: string) => marks.push({ t: performance.now(), label });

const originalQuery = pg.Client.prototype.query as (...args: unknown[]) => unknown;
(pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown }).query = function (
  this: unknown,
  ...args: unknown[]
) {
  const text = typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
  if ((this as { __bench?: boolean }).__bench) return originalQuery.apply(this, args);
  const start = performance.now();
  const record = { start, ms: 0, sql: text.replace(/\s+/g, " ").slice(0, 70) };
  queries.push(record);
  const done = () => {
    record.ms = performance.now() - start;
  };
  const last = args[args.length - 1];
  if (typeof last === "function") {
    // Callback style: time until the callback fires.
    args[args.length - 1] = (...cbArgs: unknown[]) => {
      done();
      return (last as (...a: unknown[]) => unknown)(...cbArgs);
    };
  }
  const run = () => originalQuery.apply(this, args);
  if (RTT > 0 && typeof last !== "function") {
    return sleep(RTT)
      .then(() => run() as Promise<unknown>)
      .finally(done);
  }
  if (RTT > 0) {
    setTimeout(run, RTT);
    return undefined;
  }
  const result = run();
  if (result && typeof (result as Promise<unknown>).finally === "function") {
    return (result as Promise<unknown>).finally(done);
  }
  return result;
};

function wrap<T extends object, K extends keyof T>(target: T, key: K, label: string) {
  const original = target[key] as unknown as (...args: unknown[]) => Promise<unknown>;
  (target as Record<string, unknown>)[key as string] = async (...args: unknown[]) => {
    mark(`${label} start`);
    try {
      return await original.apply(target, args);
    } finally {
      mark(`${label} end`);
    }
  };
}

async function main() {
  console.log(`DB round-trip delay: ${RTT} ms (added to every query) | runs: ${RUNS}`);
  const stamp = Date.now();

  // ---- fixtures (not measured) -----------------------------------------------------------------
  const owner = await usersRepository.create({
    authProviderId: `bench_${stamp}_o`,
    email: `bench-owner-${stamp}@example.test`,
    name: "Bench Owner",
  });
  const org = await createOrganization(owner, { name: `Bench ${stamp}` });
  const ownerCtx = await resolveOrganizationContext(owner, org.id);
  const member = await usersRepository.create({
    authProviderId: `bench_${stamp}_m`,
    email: `bench-member-${stamp}@example.test`,
    name: "Bench Member",
  });
  await membershipsRepository.create(org.id, member.id, "MEMBER");
  await createAutomation(
    ownerCtx,
    automationInputSchema.parse({
      name: "Urgent routing",
      trigger: "conversation.priority_changed",
      conditions: [{ field: "priority", operator: "equals", value: "URGENT" }],
      actions: [
        { type: "add_customer_tag", input: { tag: "urgent" } },
        { type: "assign_conversation", input: { assigneeId: member.id } },
      ],
    }),
  );

  // ---- worker (BullMQ, same code path as `npm run worker`) -------------------------------------
  const queue = getAutomationQueue();
  if (queue.driver !== "bullmq") throw new Error("Set REDIS_URL to measure the real queue");
  const handle = await queue.startWorker(async (job, attempt) => {
    mark("worker: job picked up");
    await processAutomationJob(job, attempt);
    mark("worker: handler returned");
  });

  wrap(automationsRepository, "listEnabledForTrigger", "dispatch: match query");
  wrap(automationExecutionsRepository, "createIfAbsent", "dispatch: insert execution");
  wrap(automationExecutionsRepository, "claim", "worker: claim");
  wrap(automationExecutionsRepository, "settle", "worker: final update");
  const originalEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = async (job) => {
    mark("dispatch: enqueue start");
    await originalEnqueue(job);
    mark("dispatch: enqueue end");
  };
  for (const [name, action] of actionRegistry) {
    const original = action.execute;
    action.execute = async (...args) => {
      mark(`action ${name} start`);
      try {
        return await original(...args);
      } finally {
        mark(`action ${name} end`);
      }
    };
  }

  const poller = new pg.Client({ connectionString: process.env.DATABASE_URL });
  (poller as unknown as { __bench: boolean }).__bench = true;
  await poller.connect();
  const totals: Record<string, number[]> = {};
  const add = (label: string, ms: number) => (totals[label] ??= []).push(ms);
  let lastTimeline: Mark[] = [];
  let lastQueries: typeof queries = [];

  for (let run = 0; run < RUNS; run++) {
    // A fresh customer per run, so the "add tag" action really adds the tag every time.
    const runCustomer = await customersRepository.create(org.id, {
      externalId: null,
      firstName: `Bench${run}`,
      lastName: null,
      email: null,
      phone: null,
      company: null,
      jobTitle: null,
      source: null,
      status: "ACTIVE",
    });
    const conversation = await createConversation(ownerCtx, {
      customerId: runCustomer.id,
      subject: `Bench ${run}`,
      priority: "NORMAL",
      channel: "IN_APP",
    });
    marks = [];
    queries = [];

    mark("request: updateConversation start");
    await updateConversation(ownerCtx, conversation.id, { priority: "URGENT" });
    mark("request: updateConversation returned (user sees success)");

    // Wait for the run to finish, polling on a separate, uninstrumented connection.
    const deadline = performance.now() + 60_000;
    for (;;) {
      const done = await poller.query(
        `SELECT count(*)::int AS n FROM automation_executions WHERE "organizationId" = $1 AND status = 'COMPLETED'`,
        [org.id],
      );
      if (done.rows[0].n === run + 1) break;
      if (performance.now() > deadline) throw new Error("timed out waiting for completion");
      await sleep(1);
    }
    mark("execution COMPLETED (visible in database)");

    const t0 = marks[0].t;
    const at = (label: string) => marks.find((m) => m.label === label)?.t;
    const span = (from: string, to: string) => {
      const a = at(from);
      const b = at(to);
      return a !== undefined && b !== undefined ? b - a : NaN;
    };
    const queriesIn = (from: string, to: string) => {
      const a = at(from) ?? 0;
      const b = at(to) ?? Infinity;
      return queries.filter((q) => q.start >= a && q.start <= b).length;
    };

    add(
      "A. request total (until success returns)",
      span(
        "request: updateConversation start",
        "request: updateConversation returned (user sees success)",
      ),
    );
    add(
      "   of which: match query",
      span("dispatch: match query start", "dispatch: match query end"),
    );
    add(
      "   of which: insert execution",
      span("dispatch: insert execution start", "dispatch: insert execution end"),
    );
    add("   of which: enqueue (Redis)", span("dispatch: enqueue start", "dispatch: enqueue end"));
    add(
      "F+G. enqueue end -> worker picks job up",
      span("dispatch: enqueue end", "worker: job picked up"),
    );
    add(
      "H. worker: setup before first action (load, claim, context)",
      span("worker: job picked up", "action add_customer_tag start"),
    );
    add("   of which: claim", span("worker: claim start", "worker: claim end"));
    add(
      "I1. action add_customer_tag",
      span("action add_customer_tag start", "action add_customer_tag end"),
    );
    add(
      "I2. action assign_conversation",
      span("action assign_conversation start", "action assign_conversation end"),
    );
    add("J. final update", span("worker: final update start", "worker: final update end"));
    add(
      "TOTAL change -> COMPLETED",
      span("request: updateConversation start", "execution COMPLETED (visible in database)"),
    );
    add(
      "   queries on the request path",
      queriesIn(
        "request: updateConversation start",
        "request: updateConversation returned (user sees success)",
      ),
    );
    add(
      "   queries in the worker (pickup -> handler returned)",
      queriesIn("worker: job picked up", "worker: handler returned"),
    );
    lastTimeline = marks.map((m) => ({ ...m, t: m.t - t0 }));
    lastQueries = queries.map((q) => ({ ...q, start: q.start - t0 }));
  }

  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  console.log("\nMedian over runs (ms; query rows are counts):");
  for (const [label, values] of Object.entries(totals)) {
    const isCount = label.includes("queries");
    console.log(`${label.padEnd(62)} ${isCount ? median(values) : median(values).toFixed(1)}`);
  }
  console.log("\nLast run, every database round trip (start ms, duration ms, statement):");
  for (const q of lastQueries) {
    console.log(`${q.start.toFixed(0).padStart(6)} ${q.ms.toFixed(0).padStart(5)}  ${q.sql}`);
  }
  console.log("\nLast run timeline:");
  for (const m of lastTimeline) console.log(`${m.t.toFixed(0).padStart(6)}  ${m.label}`);

  await poller.end();
  await handle.close();
  await queue.close();
  await getDb().$disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exit(1);
});
