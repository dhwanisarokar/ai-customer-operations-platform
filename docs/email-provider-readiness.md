# Provider readiness: evidence required before a real adapter is enabled (Phase 9.6)

This is the gate between "an adapter exists" and "an adapter may send customers' email". Nothing here is satisfied today: the
only provider is the in-memory **fake**, which models the behaviours but proves nothing about any real provider.

## Declared is not verified

`EmailProvider` carries two separate things (`src/server/email/provider.ts`):

- `sending: SendingCapabilities` - what the adapter author **declares**: idempotency and how long keys are remembered, whether a
  lookup by key exists, how consistent it is, how long it remembers, and how long a request we stopped waiting for can still be
  accepted. `null` always means unknown, and unknown is treated as "no guarantee".
- `readiness: ProviderReadiness` - `fake`, `declared` or `verified`. `verified` requires a non-empty `evidence` (a path to the
  filled-in checklist below, committed with the adapter).

`assessProvider` (`src/server/email/provider-policy.ts`) decides whether a provider may **send**, in this environment:

| Rule                                                                                                                     | Where it applies |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| declarations must be internally consistent (see the table below); an inconsistent or too-weak declaration is **refused** | everywhere       |
| `fake` readiness (or the name `fake`) is refused                                                                         | production       |
| anything but `verified` with evidence is refused (`declared` is allowed only while developing)                           | production       |

A refused provider is **never used in a weaker mode**: outbound email is simply unavailable (no reply can be recorded, a send
queued earlier is not delivered and is not lost), the reasons are logged once (codes only) and counted
(`email_provider_rejected_total{reason}`). Inbound handling and address setup are unaffected.

## What each declaration means, and the evidence it needs

| Declaration               | Meaning                                                                                                                               | Evidence needed before it may be set                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotentByKey`         | a second request with the same key is refused and answered with the original result, **including while the first is still in flight** | provider documentation AND a sandbox test: same key twice sequentially, and twice concurrently, one delivery; what the second call returns                                                |
| `keyRetentionMs`          | how long a key is remembered; must be at least `requiredKeyRetentionMs()` (twice the platform's retry horizon, about 1 hour today)    | documentation of the retention; a test after a delay is not practical for long periods, so the documented figure must come from the provider's own reference, quoted in the evidence file |
| `lookupByKey`             | `findSendByKey` exists                                                                                                                | the endpoint, its authentication, and what it returns for a key never sent, a key accepted a moment ago, and a key long ago                                                               |
| `lookupConsistency`       | `strong`: an accepted send is visible at once; `eventual`: it may be missing for up to `lookupSettleMs`; `none`: nothing reliable     | measured: accept N sends, query immediately, record the worst delay until all are visible; `strong` needs documentation that guarantees read-your-writes, not just a good measurement     |
| `lookupSettleMs`          | eventual only: the longest an accepted send stays invisible                                                                           | the measurement above with a generous margin, or the provider's stated bound                                                                                                              |
| `lookupRetentionMs`       | how long the lookup remembers; after it, "not found" proves nothing. At least the settle window plus one hour                         | documentation (event/log retention for the plan in use)                                                                                                                                   |
| `lateAcceptanceCeilingMs` | the longest, counted from the moment the request is sent, that the provider may still accept it after we stopped waiting              | the provider's own server-side request timeout; if it is not documented, **leave it `null`**: the provider is then lookup-unusable and every ambiguous send stays `UNKNOWN`               |

Also required, and not expressible as a number:

- **Message-ID preservation**: our `Message-ID`, `In-Reply-To` and `References` arrive unchanged on the wire (inspect a delivered message).
- **Signed webhooks and replay**: algorithm and what it covers, freshness window, retry horizon, replay key stability (see [email-adapter-contract](email-adapter-contract.md)).
- **Receipts**: which events exist, what "delivered" means, ids stable across retries, bounce latency, and that the provider message id is unique.
- **Bounce and complaint semantics**, and what the provider suppresses on its own.
- **Credentials**: stored in the deployment's secret store (not `.env` files in the repository), least privilege (send and lookup only, no account administration), a documented rotation procedure, and what happens to in-flight sends during rotation. Today the application has no design for this: `EMAIL_PROVIDER` accepts only `fake`.
- **Provider rate limits and quotas** against the platform's own limits (`EMAIL_OUTBOUND_*`, see [email-operations](email-operations.md)); the platform's limits must be lower, so the provider's are never the first line of defence.
- **Monitoring**: the metrics and alerts for the provider's error classes are wired before traffic.

## How the platform resolves an ambiguous send with a given provider

`reconciliationMode` (`src/server/email/outbound-state.ts`) derives one of three modes. The timeline of a request that timed out:

1. **`idempotent`** (declared, with enough key memory): retry with the same key. A late original acceptance is refused by the provider.
2. **`lookup`** (a lookup that is trusted: stated consistency, retention and late-acceptance bound): the lookup is asked at once; **found** is `SENT`. **Not found** is believed only when (a) the settle window `lateAcceptanceCeilingMs + lookupSettleMs` has passed since the request was sent, and (b) the lookup still remembers (`lookupRetentionMs`). Before the window the send **stays `PROCESSING`** (no resend); its lease is long enough (`leaseFor`) that recovery asks again after the window. After the retention it becomes `UNKNOWN`.
3. **`none`**: the send becomes `UNKNOWN` and is never resent.

A call is only **started** while at least the settle window of the lease remains, so an expired lease always means the window has passed.
The platform **never assumes cancellation**: it hands the adapter an `AbortSignal` when it stops waiting, and ignores whether the adapter honoured it.

### Safest policy for a provider with no lookup and no idempotency

Select neither: `NO_SENDING_GUARANTEES`-style declarations are accepted (the platform stays safe), but every timeout then ends `UNKNOWN`, which needs a human, and a
duplicate is possible only if staff write a second reply. If that operational cost is not acceptable, **do not enable email for that provider** until it can
be asked or deduplicated. Never use `operator_confirmed_not_sent` as a substitute for an automatic policy.

## Checklist (copy into `docs/email-provider-<name>.md` and link it from `readiness.evidence`)

- [ ] Idempotency: sequential and concurrent duplicate sends, key retention figure quoted.
- [ ] Lookup: found / not found / long ago; consistency measured; retention quoted.
- [ ] Late acceptance ceiling quoted from the provider's request timeout (or left unknown).
- [ ] Message-ID, In-Reply-To, References preserved (inspected).
- [ ] Webhook signature, freshness, replay key, receipt mapping, bounce semantics.
- [ ] Credentials: storage, least privilege, rotation, revocation.
- [ ] Rate limits and quotas compared with `EMAIL_OUTBOUND_*`.
- [ ] The shared contract suite (`tests/helpers/email-provider-contract.ts`) passes against the adapter with a harness.
- [ ] Sandbox end-to-end with a real domain (needs DNS access, which does not exist yet).
- [ ] `readiness` set to `verified` with the evidence path, in the same change that adds the adapter and its `EMAIL_PROVIDER` value.
