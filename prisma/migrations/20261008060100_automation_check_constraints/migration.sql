-- Hand-written: Prisma schema language cannot express CHECK constraints.
-- Defense-in-depth for rules enforced in src/server/services/automations.ts and the worker.
ALTER TABLE "automations"
  ADD CONSTRAINT "automations_name_not_blank" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "automations_conditions_is_array" CHECK (jsonb_typeof("conditions") = 'array'),
  ADD CONSTRAINT "automations_actions_is_nonempty_array" CHECK (
    jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") > 0
  );

ALTER TABLE "automation_executions"
  ADD CONSTRAINT "automation_executions_attempts_nonnegative" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "automation_executions_finished_has_timestamp" CHECK (
    "status" NOT IN ('COMPLETED', 'FAILED', 'CANCELLED') OR "completedAt" IS NOT NULL
  ),
  ADD CONSTRAINT "automation_executions_failed_has_error" CHECK (
    "status" <> 'FAILED' OR "errorCode" IS NOT NULL
  );
