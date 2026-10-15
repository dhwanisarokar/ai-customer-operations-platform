import { z } from "zod";
import { isValidEmailDomain } from "@/lib/email-domain";

/**
 * THE SENDER-AUTHENTICATION CONTRACT between a provider adapter and the platform.
 *
 * Why it exists: the `From:` address of an email is chosen by the sender. The only evidence that a message
 * really comes from that address is SPF and/or DKIM, and that evidence only counts when the domain that was
 * AUTHENTICATED is the domain in the From address ("alignment", as in DMARC). A spoofer can pass SPF and DKIM
 * for a domain it owns while writing somebody else's address in From; such a result proves nothing about the
 * From address. So an adapter reports WHICH domain passed, and the PLATFORM decides alignment. An adapter's
 * bare "pass" is never trusted.
 *
 * What an adapter must deliver (and the schema enforces; anything else rejects the whole message as
 * malformed, it is never guessed at):
 *
 *   spf  : exactly one result for the SMTP envelope (MAIL FROM, or HELO when the sender is empty).
 *          { result: "pass", domain }   the check passed, `domain` is the domain it passed FOR (the MAIL FROM
 *                                       or HELO domain). A pass without a domain is ambiguous: rejected.
 *          { result: "fail", domain|null }  any non-pass outcome that is definite or an error: fail, softfail,
 *                                       permerror, temperror. (Mapped to "fail": they never authenticate.)
 *          { result: "none", domain: null } no SPF record or no check was made. A domain here is ambiguous: rejected.
 *   dkim : one entry per DKIM-Signature header that was evaluated (0 to 10). A message may carry several
 *          signatures, including ones a spoofer added for its own domain; each is judged on its own.
 *          { result: "pass", domain }   the signature verified; `domain` is its d= value. Required.
 *          { result: "fail", domain|null }, { result: "none", domain: null } as above.
 *
 * Domains are lower-case DNS names (validated). Unknown fields are rejected (an adapter that drifts from the
 * contract fails loudly instead of being half-understood). No "dmarc" field exists on purpose: the platform
 * computes alignment itself so it never depends on a provider's interpretation of the policy.
 *
 * NOT VERIFIED: no real provider has been connected. How SES / Mailgun / Resend expose these values, and how
 * they map onto this contract, must be confirmed per provider before an adapter is written (see
 * docs/email.md, "Adapter obligations").
 */

const domain = z
  .string()
  .max(253)
  .transform((value) => value.toLowerCase())
  .refine(isValidEmailDomain, "not a valid domain");

const result = z.discriminatedUnion("result", [
  z.object({ result: z.literal("pass"), domain }).strict(),
  z.object({ result: z.literal("fail"), domain: domain.nullable() }).strict(),
  z.object({ result: z.literal("none"), domain: z.null() }).strict(),
]);

export const senderAuthSchema = z
  .object({
    spf: result,
    dkim: z.array(result).max(10),
  })
  .strict();
export type SenderAuth = z.infer<typeof senderAuthSchema>;

/** The verdict the platform stores and judges by: aligned pass, any other outcome, or nothing. */
export type Verdict = "pass" | "fail" | "none";

export type AuthDetail = {
  fromDomain: string;
  /** SPF as reported, and whether a passing result is aligned with the From domain. */
  spf: { result: Verdict; domain: string | null; aligned: boolean };
  /** One entry per evaluated DKIM signature. */
  dkim: { result: Verdict; domain: string | null; aligned: boolean }[];
  /** Which mechanism authenticated the sender, if any. */
  via: "spf" | "dkim" | null;
};

export type SenderAuthEvaluation = {
  /** True only when SPF or at least one DKIM signature PASSED for a domain aligned with the From domain. */
  authenticated: boolean;
  /** The stored verdicts: "pass" means aligned pass; a pass for another domain is stored as "fail". */
  spf: Verdict;
  dkim: Verdict;
  detail: AuthDetail;
};

/**
 * Is `authDomain` aligned with `fromDomain`? Exactly the same domain, or the authenticated domain is a PARENT
 * of the From domain (a message from news.example.com authenticated for example.com). The reverse (From is
 * the parent of the authenticated domain) is deliberately NOT aligned: stricter than DMARC's relaxed mode, so
 * the platform needs no public-suffix list. The cost is that such mail is held for review instead of accepted.
 * A parent must have at least two labels, so a bare TLD ("com") never aligns anything; the dot boundary stops
 * "evilexample.com" from matching "example.com".
 */
export function isAligned(authDomain: string, fromDomain: string): boolean {
  if (authDomain === fromDomain) return true;
  return authDomain.includes(".") && fromDomain.endsWith(`.${authDomain}`);
}

function judge(
  entry: SenderAuth["spf"],
  fromDomain: string,
): { result: Verdict; domain: string | null; aligned: boolean } {
  const aligned = entry.result === "pass" && isAligned(entry.domain, fromDomain);
  return { result: entry.result, domain: entry.domain, aligned };
}

/**
 * The platform's own judgement of the sender, from validated adapter output and the From address. Pure.
 * `fromAddress` must already be normalized (lower-case `local@domain`).
 */
export function evaluateSenderAuth(fromAddress: string, auth: SenderAuth): SenderAuthEvaluation {
  const fromDomain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1);
  const spf = judge(auth.spf, fromDomain);
  const dkim = auth.dkim.map((entry) => judge(entry, fromDomain));

  const spfAligned = spf.aligned;
  const dkimAligned = dkim.some((entry) => entry.aligned);

  const storedSpf: Verdict = spfAligned ? "pass" : spf.result === "none" ? "none" : "fail";
  const anyDkim = dkim.some((entry) => entry.result !== "none");
  const storedDkim: Verdict = dkimAligned ? "pass" : anyDkim ? "fail" : "none";

  return {
    authenticated: spfAligned || dkimAligned,
    spf: storedSpf,
    dkim: storedDkim,
    detail: { fromDomain, spf, dkim, via: dkimAligned ? "dkim" : spfAligned ? "spf" : null },
  };
}
