const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RESOLVE_UNKNOWN_USAGE = `Usage:
  npm run email:resolve-unknown -- --org <organization uuid> --send <send uuid> \
      --operator "<your name or email>" --reason "<what you checked and found, 10-500 chars>" --confirm-not-sent

Records that an email whose outcome was UNKNOWN was NOT sent, after YOU checked with the mail provider. It marks it failed
(never sent, never resent) and writes an audit record with your identity and reason. There is no option to mark an email
as sent: that needs the provider's own evidence (the in-app re-check). Run it only on a server with production access.`;

export type ResolveUnknownArgs = {
  organizationId: string;
  sendId: string;
  operator: string;
  reason: string;
};

/** Parses the CLI arguments. Throws a readable error for anything missing, malformed or unknown. */
export function parseResolveArgs(argv: string[]): ResolveUnknownArgs {
  const values = new Map<string, string>();
  let confirmed = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--confirm-not-sent") {
      confirmed = true;
      continue;
    }
    if (!["--org", "--send", "--operator", "--reason"].includes(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    if (values.has(arg)) throw new Error(`${arg} given twice`);
    values.set(arg, value);
    i++;
  }
  const organizationId = values.get("--org") ?? "";
  const sendId = values.get("--send") ?? "";
  if (!UUID.test(organizationId)) throw new Error("--org must be an organization uuid");
  if (!UUID.test(sendId)) throw new Error("--send must be a send uuid");
  const operator = (values.get("--operator") ?? "").trim();
  if (!operator) throw new Error("--operator is required (who is attesting this)");
  const reason = (values.get("--reason") ?? "").trim();
  if (reason.length < 10) throw new Error("--reason is required (at least 10 characters)");
  if (!confirmed)
    throw new Error("--confirm-not-sent is required: this attests the email was NOT sent");
  return { organizationId, sendId, operator, reason };
}
