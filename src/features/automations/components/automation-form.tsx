"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { NativeSelect } from "@/components/shared/native-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api-client";
import {
  ACTION_CATALOG,
  ACTION_NAMES,
  OPERATORS_BY_TYPE,
  OPERATOR_LABELS,
  TRIGGER_CATALOG,
  TRIGGER_NAMES,
  type ActionName,
  type FieldDef,
  type TriggerName,
} from "@/server/automation/catalog";
import type {
  ActionValue,
  AutomationFormValues,
  AutomationJson,
  ConditionValue,
} from "../api/types";
import { useCreateAutomation, useDeleteAutomation, useUpdateAutomation } from "../hooks/mutations";

export type MemberOption = { id: string; label: string };

const CONVERSATION_STATUS_OPTIONS = ["OPEN", "PENDING", "RESOLVED"] as const;
const PRIORITY_OPTIONS = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

const defaultInput = (type: ActionName, members: MemberOption[]): Record<string, unknown> => {
  switch (type) {
    case "add_customer_tag":
    case "remove_customer_tag":
      return { tag: "" };
    case "assign_conversation":
      return { assigneeId: members[0]?.id ?? "" };
    case "change_conversation_status":
      return { status: "RESOLVED" };
    case "change_conversation_priority":
      return { priority: "URGENT" };
    case "create_customer_note":
      return { content: "" };
  }
};

function firstCompatibleAction(trigger: TriggerName): ActionName {
  const targets = TRIGGER_CATALOG[trigger].targets;
  return (
    ACTION_NAMES.find((name) =>
      ACTION_CATALOG[name].target === "conversation" ? targets.conversation : targets.customer,
    ) ?? ACTION_NAMES[0]
  );
}

type Props = {
  mode: "create" | "edit";
  automation?: AutomationJson;
  members: MemberOption[];
  /** UI hint only: the API enforces permissions regardless. */
  canEdit: boolean;
  canDelete?: boolean;
};

/**
 * WHEN trigger / AND conditions / THEN actions. The builder only offers what the registries support
 * (the same catalog the server validates against); the server re-validates everything.
 */
export function AutomationForm({ mode, automation, members, canEdit, canDelete = false }: Props) {
  const router = useRouter();
  const uid = useId();
  const create = useCreateAutomation();
  const update = useUpdateAutomation(automation?.id ?? "");
  const remove = useDeleteAutomation();
  const mutation = mode === "create" ? create : update;

  const [name, setName] = useState(automation?.name ?? "");
  const [description, setDescription] = useState(automation?.description ?? "");
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const [trigger, setTrigger] = useState<TriggerName>(
    (automation?.trigger as TriggerName | undefined) ?? "conversation.priority_changed",
  );
  const [conditions, setConditions] = useState<ConditionValue[]>(
    (automation?.conditions as ConditionValue[] | undefined) ?? [],
  );
  const [actions, setActions] = useState<ActionValue[]>(
    (automation?.actions as ActionValue[] | undefined) ?? [
      { type: firstCompatibleAction("conversation.priority_changed"), input: { tag: "" } },
    ],
  );
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const triggerDef = TRIGGER_CATALOG[trigger];
  const fieldEntries = Object.entries(triggerDef.fields);
  const compatibleActions = ACTION_NAMES.filter((actionName) =>
    ACTION_CATALOG[actionName].target === "conversation"
      ? triggerDef.targets.conversation
      : triggerDef.targets.customer,
  );

  function changeTrigger(next: TriggerName) {
    const nextDef = TRIGGER_CATALOG[next];
    setTrigger(next);
    // Keep only what still makes sense for the new trigger.
    setConditions((current) => current.filter((condition) => condition.field in nextDef.fields));
    setActions((current) =>
      current.filter((action) => {
        const def = ACTION_CATALOG[action.type as ActionName];
        return (
          def &&
          (def.target === "conversation" ? nextDef.targets.conversation : nextDef.targets.customer)
        );
      }),
    );
  }

  function addCondition() {
    const [field, def] = fieldEntries[0];
    setConditions((current) => [
      ...current,
      { field, operator: OPERATORS_BY_TYPE[def.type][0], value: "" },
    ]);
  }

  function changeConditionField(index: number, field: string) {
    const def = triggerDef.fields[field];
    setConditions((current) =>
      current.map((condition, i) =>
        i === index ? { field, operator: OPERATORS_BY_TYPE[def.type][0], value: "" } : condition,
      ),
    );
  }

  function patchCondition(index: number, patch: Partial<ConditionValue>) {
    setConditions((current) => current.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function addAction() {
    const type = compatibleActions[0] ?? firstCompatibleAction(trigger);
    setActions((current) => [...current, { type, input: defaultInput(type, members) }]);
  }

  function patchAction(index: number, patch: Partial<ActionValue>) {
    setActions((current) => current.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }

  function toValues(): AutomationFormValues {
    return {
      name,
      description: description.trim() || null,
      enabled,
      trigger,
      conditions: conditions.map((condition) => {
        const def = triggerDef.fields[condition.field];
        if (condition.operator === "exists") return { field: condition.field, operator: "exists" };
        return {
          field: condition.field,
          operator: condition.operator,
          value: def?.type === "number" ? Number(condition.value) : String(condition.value ?? ""),
        };
      }),
      actions,
    };
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    if (mode === "create") {
      create.mutate(toValues(), {
        onSuccess: (data) => router.push(`/dashboard/automations/${data.automation.id}`),
      });
    } else {
      update.mutate(toValues(), { onSuccess: () => setSaved(true) });
    }
  }

  const error = mutation.error ?? remove.error;
  const problems = error instanceof ApiError ? error.problems : [];

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {error.message}
            {problems.length > 0 ? (
              <ul className="mt-1 list-disc pl-5">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {saved ? (
        <Alert role="status">
          <AlertDescription>Saved.</AlertDescription>
        </Alert>
      ) : null}

      <fieldset disabled={!canEdit} className="flex flex-col gap-6 disabled:opacity-80">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-name`}>Name</Label>
            <Input
              id={`${uid}-name`}
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="Urgent conversation routing"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-description`}>Description (optional)</Label>
            <Input
              id={`${uid}-description`}
              value={description}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>

        <section aria-label="When" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold tracking-wide uppercase">When</h2>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-trigger`} className="sr-only">
              Trigger
            </Label>
            <NativeSelect
              id={`${uid}-trigger`}
              value={trigger}
              onChange={(event) => changeTrigger(event.target.value as TriggerName)}
            >
              {TRIGGER_NAMES.map((triggerName) => (
                <option key={triggerName} value={triggerName}>
                  {TRIGGER_CATALOG[triggerName].label}
                </option>
              ))}
            </NativeSelect>
            <p className="text-muted-foreground text-xs">{triggerDef.description}</p>
          </div>
        </section>

        <section aria-label="And" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold tracking-wide uppercase">And (all must match)</h2>
          {conditions.length === 0 ? (
            <p className="text-muted-foreground text-sm">No conditions: it runs on every event.</p>
          ) : null}
          {conditions.map((condition, index) => {
            const def = triggerDef.fields[condition.field] as FieldDef | undefined;
            return (
              <div
                key={index}
                className="flex flex-wrap items-center gap-2"
                role="group"
                aria-label={`Condition ${index + 1}`}
              >
                <NativeSelect
                  aria-label={`Condition ${index + 1} field`}
                  className="w-48"
                  value={condition.field}
                  onChange={(event) => changeConditionField(index, event.target.value)}
                >
                  {fieldEntries.map(([key, field]) => (
                    <option key={key} value={key}>
                      {field.label}
                    </option>
                  ))}
                </NativeSelect>
                <NativeSelect
                  aria-label={`Condition ${index + 1} operator`}
                  className="w-44"
                  value={condition.operator}
                  onChange={(event) => patchCondition(index, { operator: event.target.value })}
                >
                  {(def ? OPERATORS_BY_TYPE[def.type] : []).map((operator) => (
                    <option key={operator} value={operator}>
                      {OPERATOR_LABELS[operator]}
                    </option>
                  ))}
                </NativeSelect>
                {condition.operator === "exists" ? null : def?.type === "enum" ? (
                  <NativeSelect
                    aria-label={`Condition ${index + 1} value`}
                    className="w-44"
                    value={String(condition.value ?? "")}
                    onChange={(event) => patchCondition(index, { value: event.target.value })}
                  >
                    <option value="">Choose...</option>
                    {def.values?.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input
                    aria-label={`Condition ${index + 1} value`}
                    className="w-56"
                    type={def?.type === "number" ? "number" : "text"}
                    value={String(condition.value ?? "")}
                    onChange={(event) => patchCondition(index, { value: event.target.value })}
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove condition ${index + 1}`}
                  onClick={() => setConditions((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={addCondition}
          >
            <PlusIcon aria-hidden="true" /> Add condition
          </Button>
        </section>

        <section aria-label="Then" className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold tracking-wide uppercase">Then (in order)</h2>
          {actions.map((action, index) => {
            const def = ACTION_CATALOG[action.type as ActionName];
            return (
              <div
                key={index}
                className="border-border flex flex-wrap items-start gap-2 rounded-lg border p-3"
                role="group"
                aria-label={`Action ${index + 1}`}
              >
                <NativeSelect
                  aria-label={`Action ${index + 1} type`}
                  className="w-60"
                  value={action.type}
                  onChange={(event) => {
                    const type = event.target.value as ActionName;
                    patchAction(index, { type, input: defaultInput(type, members) });
                  }}
                >
                  {compatibleActions.map((actionName) => (
                    <option key={actionName} value={actionName}>
                      {ACTION_CATALOG[actionName].label}
                    </option>
                  ))}
                </NativeSelect>
                <ActionInput
                  index={index}
                  action={action}
                  members={members}
                  onChange={(input) => patchAction(index, { input })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove action ${index + 1}`}
                  onClick={() => setActions((current) => current.filter((_, i) => i !== index))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
                {def ? (
                  <p className="text-muted-foreground w-full text-xs">{def.description}</p>
                ) : null}
              </div>
            );
          })}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            onClick={addAction}
          >
            <PlusIcon aria-hidden="true" /> Add action
          </Button>
        </section>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="size-4"
          />
          Enabled
        </label>
      </fieldset>

      {canEdit || canDelete ? (
        <div className="flex flex-wrap items-center gap-2">
          {canEdit ? (
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending
                ? "Saving..."
                : mode === "create"
                  ? "Create automation"
                  : "Save changes"}
            </Button>
          ) : null}
          {mode === "edit" && canDelete ? (
            confirmDelete ? (
              <>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate(automation!.id, {
                      onSuccess: () => router.push("/dashboard/automations"),
                    })
                  }
                >
                  {remove.isPending ? "Deleting..." : "Confirm delete"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button type="button" variant="outline" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function ActionInput({
  index,
  action,
  members,
  onChange,
}: {
  index: number;
  action: ActionValue;
  members: MemberOption[];
  onChange: (input: Record<string, unknown>) => void;
}) {
  const label = `Action ${index + 1}`;
  switch (action.type) {
    case "add_customer_tag":
    case "remove_customer_tag":
      return (
        <Input
          aria-label={`${label} tag name`}
          className="w-56"
          placeholder="Tag name"
          maxLength={40}
          value={String(action.input.tag ?? "")}
          onChange={(event) => onChange({ tag: event.target.value })}
        />
      );
    case "assign_conversation":
      return (
        <NativeSelect
          aria-label={`${label} assignee`}
          className="w-56"
          value={String(action.input.assigneeId ?? "")}
          onChange={(event) => onChange({ assigneeId: event.target.value })}
        >
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.label}
            </option>
          ))}
        </NativeSelect>
      );
    case "change_conversation_status":
      return (
        <NativeSelect
          aria-label={`${label} status`}
          className="w-44"
          value={String(action.input.status ?? "")}
          onChange={(event) => onChange({ status: event.target.value })}
        >
          {CONVERSATION_STATUS_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </NativeSelect>
      );
    case "change_conversation_priority":
      return (
        <NativeSelect
          aria-label={`${label} priority`}
          className="w-44"
          value={String(action.input.priority ?? "")}
          onChange={(event) => onChange({ priority: event.target.value })}
        >
          {PRIORITY_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </NativeSelect>
      );
    case "create_customer_note":
      return (
        <Textarea
          aria-label={`${label} note`}
          className="min-w-64 flex-1"
          rows={2}
          maxLength={2000}
          placeholder="Note text"
          value={String(action.input.content ?? "")}
          onChange={(event) => onChange({ content: event.target.value })}
        />
      );
    default:
      return null;
  }
}
