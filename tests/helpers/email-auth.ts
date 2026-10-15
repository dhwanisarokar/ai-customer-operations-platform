import type { SenderAuth } from "@/server/email/sender-auth";

/**
 * Sender-authentication builders and REALISTIC scenarios in the platform's contract (see
 * src/server/email/sender-auth.ts). The scenarios mirror how real mail looks on the wire (an ESP sending on a
 * customer's behalf, forwarding, a spoofer who authenticates their own domain, look-alike domains); they are
 * written from SPF/DKIM/DMARC semantics, NOT captured from a real provider, so they do not prove how any
 * provider reports its results.
 */

type Entry = SenderAuth["spf"];
const pass = (domain: string): Entry => ({ result: "pass", domain });
const fail = (domain: string | null = null): Entry => ({ result: "fail", domain });
const none: Entry = { result: "none", domain: null };

export const auth = {
  /** Both SPF and DKIM passed for `domain` (what a well-configured sender looks like). */
  aligned: (domain: string): SenderAuth => ({ spf: pass(domain), dkim: [pass(domain)] }),
  spfOnly: (domain: string): SenderAuth => ({ spf: pass(domain), dkim: [] }),
  dkimOnly: (domain: string): SenderAuth => ({ spf: none, dkim: [pass(domain)] }),
  none: { spf: none, dkim: [] } as SenderAuth,
  failedAll: { spf: fail(), dkim: [fail()] } as SenderAuth,
  spfFailOnly: { spf: fail(), dkim: [] } as SenderAuth,
  pass,
  fail,
};

export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

export type AuthScenario = {
  name: string;
  from: string;
  senderAuth: SenderAuth;
  authenticated: boolean;
  /** The verdicts the platform stores (aligned pass / fail / none). */
  spf: "pass" | "fail" | "none";
  dkim: "pass" | "fail" | "none";
  via: "spf" | "dkim" | null;
};

export const SCENARIOS: AuthScenario[] = [
  {
    name: "a well-configured sender (SPF and DKIM for its own domain)",
    from: "ana@customer.test",
    senderAuth: auth.aligned("customer.test"),
    authenticated: true,
    spf: "pass",
    dkim: "pass",
    via: "dkim",
  },
  {
    name: "forwarded mail: SPF breaks at the forwarder, the original DKIM signature survives",
    from: "ana@customer.test",
    senderAuth: { spf: fail("forwarder.test"), dkim: [pass("customer.test")] },
    authenticated: true,
    spf: "fail",
    dkim: "pass",
    via: "dkim",
  },
  {
    name: "an ESP sends for the customer: SPF passes for the ESP's bounce domain, DKIM is signed as the customer",
    from: "ana@customer.test",
    senderAuth: { spf: pass("bounces.esp.test"), dkim: [pass("customer.test")] },
    authenticated: true,
    spf: "fail",
    dkim: "pass",
    via: "dkim",
  },
  {
    name: "an ESP sends for the customer but only SPF/DKIM for the ESP's own domain passed (NOT aligned)",
    from: "ana@customer.test",
    senderAuth: { spf: pass("bounces.esp.test"), dkim: [pass("esp.test")] },
    authenticated: false,
    spf: "fail",
    dkim: "fail",
    via: null,
  },
  {
    name: "a spoofer authenticates their own domain and writes the victim's address in From",
    from: "ceo@customer.test",
    senderAuth: auth.aligned("evil.test"),
    authenticated: false,
    spf: "fail",
    dkim: "fail",
    via: null,
  },
  {
    name: "a spoofer adds a valid DKIM signature for their own domain next to a failing one for the victim",
    from: "ceo@customer.test",
    senderAuth: { spf: fail(), dkim: [pass("evil.test"), fail("customer.test")] },
    authenticated: false,
    spf: "fail",
    dkim: "fail",
    via: null,
  },
  {
    name: "several signatures, one of them aligned and valid (an extra foreign signature does not hurt)",
    from: "ana@customer.test",
    senderAuth: { spf: none, dkim: [pass("mailer.esp.test"), pass("customer.test")] },
    authenticated: true,
    spf: "none",
    dkim: "pass",
    via: "dkim",
  },
  {
    name: "From is a subdomain of the authenticated (organizational) domain",
    from: "ana@news.customer.test",
    senderAuth: auth.dkimOnly("customer.test"),
    authenticated: true,
    spf: "none",
    dkim: "pass",
    via: "dkim",
  },
  {
    name: "the authenticated domain is a SUBdomain of the From domain (stricter than DMARC relaxed: held)",
    from: "ana@customer.test",
    senderAuth: auth.dkimOnly("mail.customer.test"),
    authenticated: false,
    spf: "none",
    dkim: "fail",
    via: null,
  },
  {
    name: "a look-alike that merely ends with the victim's name (evilcustomer.test vs customer.test)",
    from: "ana@evilcustomer.test",
    senderAuth: auth.aligned("customer.test"),
    authenticated: false,
    spf: "fail",
    dkim: "fail",
    via: null,
  },
  {
    name: "a look-alike that embeds the victim's domain as a suffix label (customer.test.evil.test)",
    from: "ana@customer.test.evil.test",
    senderAuth: auth.aligned("customer.test"),
    authenticated: false,
    spf: "fail",
    dkim: "fail",
    via: null,
  },
  {
    name: "upper-case domains are compared case-insensitively",
    from: "ana@customer.test",
    senderAuth: { spf: pass("CUSTOMER.TEST"), dkim: [] } as unknown as SenderAuth,
    authenticated: true,
    spf: "pass",
    dkim: "none",
    via: "spf",
  },
  {
    name: "no authentication at all",
    from: "ana@customer.test",
    senderAuth: auth.none,
    authenticated: false,
    spf: "none",
    dkim: "none",
    via: null,
  },
  {
    name: "SPF permerror/softfail mapped to fail, no DKIM",
    from: "ana@customer.test",
    senderAuth: auth.spfFailOnly,
    authenticated: false,
    spf: "fail",
    dkim: "none",
    via: null,
  },
];
