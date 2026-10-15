/**
 * Operator tool: attest that an outbound email whose outcome was UNKNOWN was NOT sent.
 *
 *   npm run email:resolve-unknown -- --org <uuid> --send <uuid> --operator "<who>" --reason "<what you checked>" --confirm-not-sent
 *
 * Not reachable over HTTP, by design: there is no platform-operator role in the application, so this runs only where
 * someone already has production access (DATABASE_URL). It can only produce FAILED (never SENT, never a resend), requires
 * an identity and a reason, and writes an audit record. See docs/email-outbound.md.
 */
import "dotenv/config";
import { resolveUnknownAsOperator } from "@/server/email/outbound-ops";
import { parseResolveArgs, RESOLVE_UNKNOWN_USAGE } from "@/server/email/resolve-unknown-cli";

async function main() {
  let args;
  try {
    args = parseResolveArgs(process.argv.slice(2));
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}\n\n${RESOLVE_UNKNOWN_USAGE}`,
    );
    process.exit(2);
  }
  try {
    await resolveUnknownAsOperator(args);
    console.log(
      "Recorded: the email is marked as NOT sent (failed), with an audit record. Nothing was resent.",
    );
    process.exit(0);
  } catch (error) {
    console.error(`Not changed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
