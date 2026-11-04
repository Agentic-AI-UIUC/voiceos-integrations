# PRD: DoorDash for VoiceOS via AgentWeb

| Field | Value |
| --- | --- |
| Ticket | VOS-1489 |
| Team | Yue, Pranav, Rishabh — external volunteers |
| Stakeholder | Maks — authorized demo account/key, budget, deadline, stakeholder decisions |
| Status | Implementation specification; live acceptance gates remain open |
| Revision / verification date | November 3, 2026, America/Chicago |
| Delivery | VoiceOS `local-mcp` integration, installable demo, fixtures, tests, and HANDOFF.md |
| Deadline | **Unresolved: November 15 versus three weeks.** Maks and the team must confirm the date and, for three weeks, its start date. Relative milestones below are sequencing, not an agreed deadline. |
| Spending constraint | **Total incremental testing cost must be less than $20.** No food purchases, orders, payments, or automatic credit top-ups. |

## 1. Summary and boundaries

Users speak to VoiceOS to discover restaurants, browse menus, inspect an item, edit a draft cart, and hear a refreshed checkout total. They then continue in the DoorDash website. The integration never submits an order or takes payment.

Deliver a controlled demo, not a production ordering platform. Keep the original ownership split: Pranav owns browsing and fixtures; Rishabh owns carts, MCP registration, and installation; Yue owns the AgentWeb client, account/order reads, and live observation. **Yue is the proposed owner of our team's multi-login investigation.** Maks supplies access and decisions; he is not assumed to deliver multi-user architecture.

The integration exposes exactly **12 DoorDash actions** (§4). Remove `update_default_address` everywhere it was executable. Keep `list_addresses` read-only. There is no address-switching demo, request for multiple saved addresses, or address-restoration cleanup.

Current AgentWeb metadata changes two important premises of the original PRD: DoorDash map **1.2.2** lists 16 upstream actions, and `add_to_cart` now declares `quantity`, `nested_options`, `special_instructions`, and `cart_id`. It also lists `place_order`. Its checkout description still says paying is not mapped, which conflicts with that listed action and the checkout outcome's suggested next step. Therefore, ordering is excluded by **our enforced allowlist**, not by an assertion that AgentWeb lacks that capability. Parameter availability is documented metadata; actual quantity behavior and modifier encoding have not been exercised. [E01, E02]

### Evidence labels

- **D — Documented:** stated in a current vendor document, schema, or published example.
- **O — Observed:** directly inspected during this revision. Metadata/health observations are not evidence of successful DoorDash execution.
- **P — Proposed:** the implementation contract chosen by this PRD, not a claimed vendor API.
- **U — Unknown:** a specific verification remains necessary before enabling the affected capability.

Evidence IDs resolve to exact URLs, sections, versions, and verification notes in §19. Unless explicitly labeled D or O, requirements are P. The October 27 findings in the original PRD are historical claims, not test evidence.

### Verification actually performed

Read the original PRD completely; retrieved official AgentWeb and VoiceOS documentation, public AgentWeb action metadata and health, relevant repository files, and package metadata. AgentWeb's public health returned runtime **0.10.21**; its public OpenAPI document identifies itself as **0.9.0**. The detailed DoorDash map returned **1.2.2**, `partial: true`, 16 actions, and `auth_provider: doordash` for all 12 selected actions. [E01–E04]

No AgentWeb key or target VoiceOS desktop was supplied. The accessible workspace is Linux x86_64 with Node **24.22.1**, not the target VoiceOS installation. No DoorDash action, login, cart mutation, spoken interaction, installation, publication, checkout opening, or acceptance test was run. The VoiceOS main application source was not accessible through the available repository connection. [E24]

## 2. Goals, non-goals, and ownership

### Goals

1. Implement the 12 actions with strict request allowlisting, useful spoken digests, and small native result cards.
2. Require a specific proposal and host confirmation for each cart mutation in the supported demo configuration; validate again before sending a write.
3. Support “add two” through one quantity-bearing request once its live acceptance test passes. Never substitute repeated additions as an unverified workaround.
4. Offer a usable browser handoff without claiming account transfer, successful URL opening, payment, or order placement without corresponding evidence.
5. Develop offline using clearly labeled synthetic and sanitized fixtures; preserve the cost limit for bounded live checks.
6. Prove the **published/share-link installation** early, including nested-file and dependency behavior.
7. Investigate account isolation with two authorized accounts while keeping the shared-account demo limitation explicit.

### Non-goals

- Production rollout, multi-tenant hosting, a new authentication service, or a separate STT/TTS stack.
- Order submission, payment methods, payment, promos, grocery workflows, reorder, or changing account settings.
- dd-cli or direct DoorDash APIs as fallback implementations.
- Native React cards inside the VoiceOS app. We supply models, basic integration cards, and declarative confirmation views; the VoiceOS team owns any custom native cards.
- Automatic cart replacement, quantity decrement by delete-and-readd, delivery-address changes, or guaranteed cross-device cart/session transfer.

### Responsibility split

| Owner | Implementation and handoff responsibility |
| --- | --- |
| Yue | AgentWeb transport/auth/error adapters, account checks, account/order slice, private live recording, usage ledger; **proposed lead for multi-login investigation and two-account test**. |
| Pranav | Search/menu/item slice, modifier normalization with Yue, fixtures, sanitizer, browse digests. |
| Rishabh | Cart slice, pending proposals and operation journal, deduplication/reconciliation, MCP allowlist/server, manifests/confirmations, early published installation, voice-flow and checkout host coordination. |
| All three | Agree contracts, review evidence, acceptance results, demo script, and HANDOFF.md. Ownership permits parallel work; this document does not assign additional agents or contributors. |
| VoiceOS team | Native/custom cards if desired; target host/runtime and publishing support; resolution of host capability gaps. |
| Maks | Existing funded access through a private secret channel; permission for the bounded account use; less-than-$20 budget allocation; deadline and receiving reviewer. |

## 3. User stories and demo

| ID | User says | Required behavior | Priority |
| --- | --- | --- | --- |
| U1 | “Find sushi near me.” | Explain that results use the connected account's default delivery address, then speak up to three usable restaurant results and offer more. Do not imply device geolocation. | P0 |
| U2 | “The second one. What's on the menu?” | Resolve the ordinal against the most recently presented restaurant list, select that store, summarize categories/items with known prices. | P0 |
| U3 | “Tell me about the spicy tuna roll.” | Clarify duplicate names; read detail, price and known choice requirements. Missing option metadata means unknown, not no choices. | P0 |
| U4 | “Add two of those.” | Resolve one item; validate quantity/options/cart; propose the exact change and price; accept spoken correction, cancellation, or approval; execute one quantity-bearing add and verify the cart. Unsupported/unknown options block the add. | P1 |
| U5 | “What's in my cart?” / “Remove the miso soup.” | Read current lines; disambiguate the target; confirm edits, naming the affected line and quantity. Removing a line removes its whole quantity. | P1 |
| U6 | “How much is it?” | Refresh cart and checkout pricing; speak the returned total and available fee/tax breakdown, with currency and freshness. Unknown fees are not zero. | P1 |
| U7 | “Check out.” | Refresh pricing, explain browser/account limits, request the host's URL-opening action if supported, and report only its confirmed outcome. Otherwise offer a checkout link. Never say an order was submitted. | P1 |
| U8 | “Which address is this using?” | Read the default address only if identifiable from validated data; otherwise say it could not be determined. Address selection/editing is unavailable. | P2 |
| U9 | “Where's my order?” / “What did I order last time?” | Read authorized order history/status; distinguish an empty history from an expired session. No new order is needed for testing. | P2 |

**Demo order:** U1 → U2 → U3 → U4 using a verified simple item → U5 → U6 → U7. Show a spoken correction and cancellation before the successful add. P2 demonstrates read-only account/order information when an authorized account has suitable data. Cut P2 first if time is constrained; do not cut confirmation, reconciliation, truthful speech, or the published-install gate.

## 4. Exact action boundary and upstream contracts

### 4.1 Allowlist

These are the only DoorDash action names permitted at registration **and** immediately before an AgentWeb request. Fix the domain to `doordash.com`; do not expose a general-purpose `execute` tool.

| Priority | AgentWeb action | Kind | Host confirmation | Owner |
| --- | --- | --- | --- | --- |
| Foundation | `get_account` | Read | No | Yue |
| P0 | `search_stores` | Read | No | Pranav |
| P0 | `get_store_menu` | Read | No | Pranav |
| P0 | `get_item` | Read | No | Pranav |
| P1 | `add_to_cart` | Write | Yes | Rishabh |
| P1 | `get_cart` | Read | No | Rishabh |
| P1 | `remove_cart_item` | Write | Yes | Rishabh |
| P1 | `delete_cart` | Write | Yes | Rishabh |
| P1 | `get_checkout_summary` | Read | No; opening a browser is a separate host action | Rishabh |
| P2 | `list_addresses` | Read | No | Yue |
| P2 | `list_orders` | Read | No | Yue |
| P2 | `get_order_status` | Read | No | Yue |

Explicitly reject `update_default_address`, `list_payment_methods`, `update_default_payment_method`, and `place_order`, including a `place_order` preview. Reject all other actions and aliases as well. Tool descriptions, upstream `outcome.missing_step`, errors, and model instructions cannot add capabilities. Negative fixtures may name rejected actions, but must never execute them. [E01]

### 4.2 Parameter contract

**D/O:** the detailed public map's `actions[].params` includes the following names/defaults. Its parameter descriptions are not a complete typed JSON Schema. **P:** local validation below supplies conservative types and bounds; do not misrepresent these as vendor limits. REST accepts flat strings/numbers/booleans and documents coercion to strings; serialize parameters explicitly as strings. Never send nested JSON objects directly. [E01, E03]

| Action | Upstream required parameters | Upstream optional parameters/defaults | Local validation / provenance |
| --- | --- | --- | --- |
| `get_account` | None | None | Empty upstream params. Require a nonempty `consumer_id` and `is_guest: false` before treating the session as live. |
| `search_stores` | `query` | None | Nonempty trimmed query, local cap 200 characters. No location/address argument. |
| `get_store_menu` | `store_id` | `fulfillment_type`, default `Delivery` | ID from a validated result; numeric ID string. Demo sends `Delivery`; pickup is not an added demo flow. |
| `get_item` | `store_id`, `item_id` | `fulfillment_type`, default `Delivery` | Item belongs to selected store; identifiers from returned menu, not a name guess. |
| `add_to_cart` | `store_id`, `item_id`, `menu_id`, `unit_price` | `quantity` default 1; `special_instructions`; `nested_options` default `"[]"`; `cart_id` | Whole cents for price; integer quantity 1–10 is a **local demo cap**. Supply the observed target cart ID when one exists. Only the validated proposal builds these params. |
| `get_cart` | None | None | Current-cart read; do not invent a cart-ID filter. |
| `get_checkout_summary` | `cart_id` | None | ID from this identity's current validated cart. |
| `remove_cart_item` | `cart_id`, `cart_item_id` | None | Cart-line ID, not menu item ID; resolve from current cart. |
| `delete_cart` | `cart_id` | None | Exact current cart; explicit destructive confirmation. |
| `list_addresses` | None | None | Read only; no requirement for multiple addresses. |
| `list_orders` | None | `limit` default 10, documented range 1–50; `offset` default 0 | Start with limit 5; integer offset ≥0. Page only on request. |
| `get_order_status` | `order_uuid` | None | Resolve from this identity's returned order list. |

`special_instructions` is present upstream, but free-form notes are not part of the initial demo. Never use notes to substitute for required modifiers.

**Important source distinction:** `/maps/library` includes a compact mandatory-parameter list; `/api/sites/doordash.com` includes optional parameters. Absence from the compact list does not establish lack of quantity/modifier support. [E01, E02]

### 4.3 Response contract and capture requirements

**D:** REST uses an outer success/error envelope; action data may be a JSON projection or table. **U:** no authenticated samples were available to prove the exact per-action runtime shape. The response descriptions below are normalization inputs, not invented API guarantees. Yue must capture allowed samples and freeze a redacted shape reference before the corresponding live capability is accepted. [E01–E04]

| Action family | Documented information to project | Required verification |
| --- | --- | --- |
| Account | Consumer identity, guest flag, country; names/email exist but need not enter digests. | Exact nesting/types of identity and guest flag; wrong/expired connection behavior. |
| Search | `store_id`, name/description, `details` tuples containing ETA/fee display strings, store `link`. | Actual table/JSON shape; safe parsing of the link; skip rows without a store ID. Rating is optional only if actually supplied. |
| Menu | Store, `menu.id`, `item_lists`; item IDs/names/descriptions, `displayPrice`, `quickAddContext.price.unitAmount`. | ID associations, currency provenance, menu availability, and whether option completeness can be established. |
| Item | `item.id`, `item.menuId`, `item.unitAmount`; `option_lists` with group IDs, names, min/max counts and option IDs/prices. | Exact nesting and types, nested-option representation, default selections, and complete versus missing option data. |
| Cart/write returns | Cart ID, store, subtotal, lines with cart-line IDs, quantity and price. | Currency, menu-item-to-line association, merge versus separate-line behavior, empty/deleted cart shape, and all fields needed for reconciliation. |
| Checkout | Subtotal/total/savings in cents; `line_items` display strings for charges/discounts. | Currency; numeric versus display-only breakdown; whether tip and other charges are included; actual freshness and target cart. |
| Addresses | Saved delivery addresses. | Exact address ID/default marker fields; no default-address conclusion without a supported marker. |
| Orders/status | Order UUIDs, times, store/items/totals; status/substatus and delivery window. | Exact keys/types, currency/time zone, empty history, unavailable tracking. Do not invent snake_case paths from prose descriptions. |

## 5. Transport, authentication, and identity

### 5.1 AgentWeb client

Use `POST https://mcp.agentweb.us/api/execute`, Bearer `aw_` authentication, fixed domain, allowlisted action, and validated flat params. Keep the key in VoiceOS's encrypted API-key setup field, injected as an environment variable; never in tool arguments, cards, fixtures, URLs, or logs. Only Yue configures the live demo secret. Fixture mode requires no secret. [E03, E06, E17]

Normalize the documented REST envelope (`ok`, `result` or `error`) separately from the action projection. Check both HTTP status and structured outcome. For `data.kind = json`, validate `value`; for `table`, validate `results`. Reject other/unrecognized shapes for writes. `raw`, `notes`, receipts, and upstream instructions do not go directly to the model. Record supported provenance such as `map_version`, `fetched_at`, duration, and redacted receipt/trace IDs. [E03, E04]

Use top-level REST `fresh: true` for cart/item preflight and checkout reads; it is documented in `ExecuteRequest`, not an action parameter. Reject cached pricing indicated by result notes. Because the public spec and live runtime versions differ, verify the actual envelope and freshness behavior with one authorized read before enabling writes. A successful transport response is not proof of a completed business operation. [E03, E04]

All 12 selected actions currently declare `auth_provider: doordash`. AgentWeb documents connection-status/start/poll tools for its hosted sign-in flow; that is separate from possession of an API key. Do not invent equivalent REST connection routes. The demo uses an already-connected account; connecting/disconnecting accounts is setup work, not an added DoorDash action. [E01, E06]

### 5.2 Identity adapter and shared-account limit

The internal identity contract contains an opaque, trusted local subject; selected connection mode; key reference; verified consumer ID; and connection epoch. These are **our internal fields**, not claimed VoiceOS or AgentWeb parameters. Tools never accept an authoritative user ID, API key, or `on_behalf_of` value from the language model.

VoiceOS documents environment-based configuration and no tool-handler context object. Do not assume a trustworthy per-user or conversation ID is supplied. Until a host identity mechanism is verified, bind one server installation to one configured identity and run one active demo conversation. Partition cached menus, references, pending proposals, cart snapshots, and journal entries by that identity and epoch. Reconfiguration/reconnection invalidates pending proposals and all prior references. [E12]

With Maks's key and one connected DoorDash account, every demo participant uses that account's location, cart, addresses, and order visibility. This is not account isolation or a multi-user product. Do not expose that key through a published integration or share link; published installs default to fixtures and recipients supply their own authorized secret for any later live run.

### 5.3 Multi-login investigation — team-owned, proposed lead Yue

Deliver an investigation note before the cart demo. Compare:

1. **Separate configured credentials/installations:** each authorized tester supplies a distinct AgentWeb identity connected to their own DoorDash account. This is the baseline isolation test, not an end-user onboarding platform.
2. **Org delegation:** the public MCP `execute` schema now documents `on_behalf_of` for Slack-linked org members, identified by handle/name/email, and says spending actions are refused. It is no longer accurately described as undocumented. Its classification of cart writes is unknown. [E05]
3. **Enterprise/product connections:** obtain a concrete supported connection contract, account binding, consent model, and availability from AgentWeb; a pricing tier alone establishes none of these. [E07]

The public REST `ExecuteRequest` does **not** declare `on_behalf_of` and disallows additional top-level properties. Do not send it over REST based on the MCP schema. Yue must establish the supported transport and confirm whether delegation covers all selected reads and cart writes. No automatic fallback to Maks's identity is allowed when a user/delegation cannot be resolved. [E03, E05]

Required output: documented mechanism, plan/access needed, trusted identity source, connection lifecycle, action restrictions, two-account results (§12), browser-account results (§9), and a recommendation: separate credentials work for the demo / delegation works with stated limits / blocked. Maks may facilitate access, but this investigation remains ours.

## 6. Spoken interaction contract

### 6.1 Host capabilities and integration responsibility

| Capability | Evidence / limitation | Implementation consequence |
| --- | --- | --- |
| Speech recognition, agent routing, narrated results, native cards | D: VoiceOS supplies these. [E10, E13] | Use the host; no new microphone, STT, or TTS stack. Return compact factual data for narration. |
| Spoken approval, decline, correction | D: say yes; say no/dismiss; voice revision supersedes the proposed card. [E11] | Use native confirmations; test against the target host. Do not implement a text “approved” flag as authorization. |
| Confirmation before handler execution | D: acting tools declare manifest confirmation views; edited args reach the handler. Users can turn “Asks first” off. [E11] | Demo prerequisite: all three write tools have Asks first enabled. Record that configuration. Do not claim unconditional confirmation enforcement. |
| Progress for longer work | D: background mode and side-notch task tracking. D: completion narration exists in the changelog. [E12, E16] | Use background writes if the full preflight/write/verify path can exceed ~20 seconds. Mid-call spoken progress and cancellation propagation still require host verification. |
| URL opening | D: HTTPS `voiceos:openUrl` widget message opens the system browser; no completion acknowledgement is documented. [E14] | A request to open is not proof it opened. §9 defines the allowed language and host gap. |
| Transcript hooks | D: optional hooks exist, require transcript permission, and fail open on deadline. [E15] | Do not use hooks as the safety gate; the demo does not request transcript access merely to implement cart confirmations. |

If VoiceOS cannot expose/enforce the required confirmation configuration on the target host, cart writes remain disabled and that limitation is visible in the demo. A manifest alone cannot prove approval occurred when a user override skips it. Request a trusted mandatory-confirmation capability or approval receipt from VoiceOS before claiming enforcement beyond the supervised configuration. A proposal ID is not such a receipt.

### 6.2 End-to-end conversation

**Discovery:** “I found three sushi places for the connected account's delivery address: 1, A …; 2, B …; 3, C …. Want more, or a menu?” Use at most three names and short ETA/fee details, normally 20–40 words. Omit absent facts; do not read a full menu or saved street address aloud unprompted.

**Menu:** state the selected restaurant, up to three categories, and up to five example items with known prices. Offer a category or more items. On “more,” present the next page of the same validated result set; do not rerank silently. Search has no documented page parameter, so paginate locally and say when the available results are exhausted.

**References:** keep a result-set ID, ordered visible/spoken IDs, selected store/item, capture time, identity epoch, and fulfillment type. “The second one” resolves only within the latest relevant presented list. “Two of those” means quantity two of the single selected item, not the first two items. Expire references after five minutes, account/store changes, a replacement result list, or ambiguous context. Ask a specific question when more than one list/item could match; never pick by popularity or name similarity alone.

**Ambiguity:** distinguish restaurant, item, cart-line, quantity, and options. Ask one useful question at a time: “There are two spicy tuna rolls: regular or large?”; “Do you want two total, or two more?”; “Which required size?” Negation, unclear numbers, zero/negative/fractional quantities, and unavailable options produce clarification with no write.

**Proposal:** after the read-only preparation in §7, speak: “Add two [item + chosen options] from [store] at [currency/unit price], [line amount], to [current/new cart]? This only changes the cart.” Show the same facts in the host confirmation. Item line amount is not represented as the final delivered total. For removal name the line and its quantity; for deletion name the store and all affected draft items.

**Correction:** “Actually, make it one” invalidates the two-item proposal. Resolve and reprice a new one before asking again. A new item, option, quantity, account, fulfillment type, cart, or price requires a new proposal. Inline edits that change these facts must be revalidated; if they no longer match the prepared proposal, reject the stale invocation and prepare a new confirmation. Never charge the old line amount for a changed quantity.

**Approval / cancellation:** a clear yes applies only to the current host proposal. “No,” “cancel that addition,” or dismissing the pending card sends no write. The handler does not treat the transcript, a model-created `confirmed` field, or an old yes as reusable approval. If cancellation is not delivered to the server, the old proposal still expires and cannot be reused for a changed request; the host must prevent the cancelled card from executing. Verify this in the host test.

**Success:** speak “Your cart now has two [item]” only after the post-write read proves it. If the action returned success but verification failed, say the cart could not be verified. If the write outcome is uncertain, say “That may have been added. I'm checking the cart; I won't add it again yet.” No “done” before evidence.

**Slow calls:** target a host acknowledgement within three seconds. Use truthful phrases such as “Checking the menu” or “Checking whether the cart changed.” No invented completion percentages. Native background tracking is the documented fallback when spoken progress is unavailable; spoken-progress acceptance remains open until observed on the target host.

### 6.3 Stop, cancel, and undo are different

| User intent / state | Required behavior |
| --- | --- |
| “Stop talking” | Stop host playback when the host supports it. Do not claim that playback stopping cancelled a tool. Preserve actual operation state. |
| Cancel while a proposal is pending | Host dismisses/supersedes the proposal; no upstream write. |
| Cancel after dispatch / network timeout | Attempt only supported cancellation propagation; it cannot prove the upstream operation was aborted. Reconcile the cart and report the result or uncertainty. |
| “Undo” after a verified add | A new, separately confirmed removal, only if the exact added line/quantity can be targeted safely. If the add merged into an existing line, do not remove the whole line as an undo. Offer browser editing. |

### 6.4 Proposed latency targets and measurement

These are demo targets, not AgentWeb or VoiceOS SLAs. VoiceOS documents a ~8-second fetch timeout example, sync work well under 30 seconds, and background mode for work over ~20 seconds. No DoorDash-action latency SLA was verified. [E08, E12]

| Measurement | Target |
| --- | --- |
| End of user speech → first acknowledgement/clarification | p95 ≤3 seconds |
| End of speech → useful search/menu spoken summary | p50 ≤4 seconds; p95 ≤10 seconds, excluding user setup/clarification time |
| Host approval → verified cart result | p50 ≤8 seconds; p95 ≤20 seconds; show background state if still running |
| Final tool result → first grounded spoken result | p95 ≤2 seconds |
| Pending cancellation → confirmation dismissed | p95 ≤1 second; zero dispatched writes for pre-dispatch cancellations |

Measure host audio/input timestamps and tool start/response/verification timestamps separately. Use host telemetry if available; otherwise a controlled observer/audio timing session suffices, without building a speech stack. Collect at least 50 fixture-mode voice turns covering the critical flow; report sample count, host build, warm/cold start, network, p50/p95, and failures. Report bounded live observations separately; a small live sample is not a statistical latency guarantee. Backend timings exclude speech/host delay and cannot stand in for end-to-end numbers.

## 7. Cart correctness and approval binding

### 7.1 Read-only preparation using the same 12 tools

Do not add extra DoorDash actions to prepare a change. **Proposed local-MCP extension:** `get_cart` may accept an optional local-only `proposed_change` describing add/remove/delete plus resolved IDs, intended quantity, and selected option IDs. The handler strips this local field and sends empty params to upstream `get_cart`; it performs the necessary allowed item reads and prepares an intent without mutating DoorDash. Document this wrapper in the local schema and HANDOFF.md; it is not an AgentWeb parameter.

The preparation result returns an opaque `intent_id`, expiry, cart fingerprint, and a validated `proposal` with the precise display/execution facts. The three local write tools accept that intent ID and the full displayed proposal; they do not accept arbitrary authoritative upstream arguments. Manifest bindings show that proposal. A server-side comparison rejects model-edited labels, IDs, prices, or quantities that do not match stored facts. Parameters sent upstream are constructed from the stored proposal after successful revalidation.

The stored proposal binds: identity/epoch, operation, store ID/name, menu/item ID/name, canonical option tree and labels, quantity/delta, unit and line amounts with currency, target cart ID or explicit new-cart condition, affected line IDs, fulfillment type, baseline cart fingerprint, and creation/expiry timestamps. Expire after **120 seconds**. This token binds scope and deduplicates execution; it does not replace host approval.

After approval, acquire the per-identity write lock, read a fresh cart and (for adds) fresh item pricing/options. Compare against the proposal, including price and cart contents. Any mismatch returns `proposal_stale`, performs no write, and requires a newly spoken proposal and approval. The demo must not run concurrent independent writers against one connected account. An external browser edit can still race the final request; document that residual limitation, detect it in verification, and never claim atomic compare-and-swap support.

### 7.2 Quantity and repeated additions

The current detailed map supports a `quantity` parameter with default 1. U4 is therefore **documented as representable**, but live correctness remains an acceptance gate. Send `quantity: "2"` once for “add two,” then verify the requested delta. Do not silently send two single-item writes. [E01]

For an existing identical item, compare total quantity before/after across lines with the same verified item/options identity. Accept either a merged line or distinct lines only if the aggregate delta is exactly the approved quantity and unrelated lines are unchanged. Do not identify lines by name alone. If the response lacks a reliable menu-item/option-to-cart-line association, repeated-add/reconciliation support is blocked until Yue obtains that association or an adequate verified receipt mapping.

An intentional second request to “add two more” creates a new proposal. A repeated delivery of the same intent reuses its operation state/result and never triggers a second write. If a repeated utterance is ambiguous between a retry and an additional purchase intent, refresh and clarify. No content hash may suppress a genuinely new, separately approved request.

### 7.3 Required, optional, and nested modifiers

`nested_options` is documented as a **JSON string**, with `"[]"` for an item without required options. The retrieved map does not supply the nonempty JSON grammar, nested selection encoding, option quantities, or default-selection semantics. **Do not invent them.** [E01]

Pranav and Yue must obtain a current provider example/schema, bind menu group/option IDs to that grammar, and perform one approved modifier-bearing live add to a test-created cart before enabling modifier writes. Until then:

- Simple items may be added only after complete item detail proves they have no required selections and the empty-options representation is applicable.
- Required-option items and requested optional customizations return `unsupported_configuration` with a browser-editing explanation. Their choices may be browsed/read.
- Missing groups/min/max/defaults, incomplete nested children, unknown option prices, or contradictory constraints return `configuration_unknown`; they do not make an item eligible for a simple add.

When encoding is verified, validate every group recursively: min/max counts, selection availability, mutually exclusive choices, option quantity rules, parent-child activation, and price increments. Ask for each missing required choice. Do not choose a required option or a paid optional extra automatically. Display any upstream default explicitly; preserve it only after its meaning is verified. Refresh and reconfirm if the complete selected-item price changes. Unknown option cost blocks mutation.

### 7.4 Existing carts and destructive changes

Read the current cart before any mutation. Reuse an observed same-store cart by explicit `cart_id`; do not rely on the upstream empty-ID reuse behavior when a cart exists. With no cart, confirm “new cart for [store]” and capture the returned ID. Empty cart data is accepted only after a valid account check, not after a guest/expired session. [E01]

If the current cart belongs to another restaurant or contains unrecognized/multiple cart state, do not replace or clear it automatically. Offer the current cart or browser editing. If the user explicitly wants to delete the current draft, require a separate deletion confirmation, verify deletion, then prepare a separately confirmed add. Live testing (§13) permits this only for test-created state.

`remove_cart_item` removes a whole line. If the line contains three units and the user says “remove one,” this allowlist has no verified decrement/update operation: explain the limitation and hand off. `delete_cart` removes a draft cart, not an order; never describe it as cancelling delivery or refunding payment.

### 7.5 Mutation journal, verification, and uncertain results

Use a small per-installation local operation journal, not a new service. Write intent ID, identity/epoch hash, cart fingerprint, canonical request fingerprint, request key, state, affected line/cart IDs, and sanitized verification outcome atomically before dispatch. No names, street addresses, tokens, or raw responses are needed. Rishabh must verify a writable integration-local state path and exclusive writer lock in the installed runtime at M0. Never use VoiceOS's reserved `store` permission as if a store API already existed. [E17]

State progression: `prepared` → `dispatching` → `verifying` → `verified` or `outcome_unknown`; alternatively `cancelled`, `expired`, or a proven `not_executed`. Consume an intent at dispatch; duplicate calls for an in-flight/unknown intent can only inspect/reconcile it. Retain settled journal entries for 24 hours for the demo; unresolved entries must not expire into retry eligibility. If the journal is unavailable, corrupted, lost on reinstall, or has an unfinished operation after restart, disable writes. Re-enable only after account/cart reconciliation establishes a baseline and any potentially dispatched operation is resolved; a fresh snapshot alone cannot settle an unknown delayed write. Old intent IDs never become valid again.

Post-write verification must read the cart again and prove:

- Add: the correct store/cart and exact approved quantity/options delta, with no unexpected changes to baseline lines.
- Remove: the targeted whole line is absent and other lines remain unchanged.
- Delete: the targeted draft is absent/empty in a shape known to mean deletion; a new unrelated current cart is not proof.

**D:** `Idempotency-Key` is supported on REST execution; the spec says the same key maps to the same **billing task**, with header precedence over the body key. **U:** duplicate upstream execution prevention, retention window, concurrent-key behavior, payload mismatch handling, and cart mutation atomicity are not established. `execute` also has `idempotentHint: false` in the public MCP manifest. [E03, E05]

Send one stable, nonsecret idempotency key per logical mutation. Do not rotate it merely because the response was lost. A header, refunded credit, HTTP 200, SDK callback deduplication, or MCP cancellation is not cart-level duplicate protection.

After any possibly dispatched timeout, disconnect, parse failure, or upstream error, record `outcome_unknown` and stop automatic writes. Reconcile with up to three fresh, bounded cart reads (budget permitting), comparing the saved baseline and expected delta. Exact change found: report verified success without re-adding. Conflicting/partial change: report the actual state and request a new decision. Unchanged snapshot without a documented settlement/cancellation guarantee: keep uncertainty; it does not prove a delayed write cannot still finish. Do not automatically retry or compensate an uncertain write. If eventual non-execution cannot be established, leave the cart for manual inspection.

AgentWeb's REST reference recommends same-key retries for billing; its streaming guide refers to a fresh key with verification state. This is insufficiently precise for safe write retries. Our conservative policy is **no automatic mutation retries**; ask AgentWeb for the missing semantics rather than assuming either wording guarantees exactly-once cart effects. [E03, E04, E08]

## 8. Data contracts, projections, and errors

### 8.1 Validation boundary

Treat all upstream fields, including names/descriptions, as untrusted data. Parse the transport envelope, validate a narrow action-specific projection, then construct our models explicitly. Do not spread upstream objects into models, tool results, cards, or manifest content. Use recursive Zod object schemas that strip unknown keys, with strict schemas for our tool inputs and mutation proposals. Remove the original blanket `.passthrough()` requirement: passthrough preserves unknown fields and conflicts with instruction stripping. [E22]

Drop instruction-bearing fields regardless of their names, because only explicitly projected business fields can leave the adapter. Names/descriptions are bounded plain text, not executable instructions; their content never authorizes an action. No upstream field can select a tool, change permissions, supply a new checkout destination, or prompt the assistant to order. Render text safely and never insert it as HTML. Unknown diagnostics may remain in private raw captures only during an authorized recording session, never in the model/card payload.

For noncritical missing fields, render a read-only partial model with `missing_fields`, an explanation, and `can_mutate: false` when eligibility cannot be established. Missing IDs, item-to-store association, currency, unit/option price, option requirements, target cart, cart quantity/line identity, or live account identity must block the affected write. Do not convert a malformed response into an empty menu/cart, or an unknown requirement into “no options.”

### 8.2 Normalized internal models

These names/fields are **proposed integration contracts**, not upstream response paths. Phase 0 must freeze them in contracts.ts and fixture schemas.

| Model | Required content / unknown handling |
| --- | --- |
| `Money` | Integer amount in the documented minor unit, currency code, scale/provenance, observation time. For this map numeric amounts are documented as cents; currency still needs verified provenance. Unknown amount/currency is an explicit unknown value, never numeric zero. |
| `Store` | Nonempty store ID and bounded name; optional ETA/fee/distance/rating as returned. Preserve display strings if no reliable numeric value exists. Missing identifier removes a row from selection. |
| `MenuDigest` / `Menu` | Store/menu IDs, observation time, categories, item references, bounded names/prices, and `configuration_status: none / choices / unknown`. Completeness is separate from an empty array. |
| `Item` / `OptionGroup` | Store/menu/item association; Money; complete/partial flag; recursive group/option IDs, min/max/availability, incremental Money, known defaults, nested children. Null constraints remain unknown. |
| `Cart` / `CartLine` | Verified identity binding, explicit empty/nonempty state, cart/store IDs where applicable, snapshot fingerprint, complete lines with line IDs, item/options identity, quantity and known prices. Partial carts cannot authorize writes. |
| `CheckoutSummary` | Target cart/fingerprint, refreshed time, currency, source-reported subtotal/total/savings and charge lines. Each missing charge is unavailable; `includes_tip` and completeness remain unknown unless evidenced. |
| `Address` | Projected ID, safe label, explicit default marker only if supported. Full street details only for a user-requested address response and authorized testing. Never mutate. |
| `Order` / `OrderStatus` | Identity-bound order UUID, supported status/time window, store/items, optional known monetary data. Do not infer “delivered” solely from an absent active status. |
| `PendingChange` / `OperationOutcome` | §7 proposal, expiry, fingerprint, journal state, verified result or uncertainty. No fallback that permits execution. |
| `DoorDashError` | Internal state, safe spoken message, retriable-read flag, write outcome (`not_sent / proven_not_executed / possibly_executed`), optional redacted trace/receipt. |

Preserve source monetary units separately from AgentWeb billing units. Never interpret 873 cents as $873, assume a dollar sign means USD, or mix `charge_unit: credit` with `charge_unit: cent`. Use source currency evidence from the validated runtime payload; if it is absent, Yue must establish a trustworthy account/store-specific currency mapping before live writes. Country alone does not establish a currency. Arithmetic used for an item quote must be exact integer arithmetic with checked bounds; final checkout totals come from the refreshed checkout response, not a local fee estimate. [E01, E03]

### 8.3 Digests and cards

The model gets explicit factual digests, missing-field indicators, allowed next choices, and verified outcome states. Initial local limits: search 10 selectable records per model page, menu 20 item references per page, serialized factual digest ≤8,000 UTF-16 code units; trim descriptions first and page deterministically. Speech follows the smaller §6 limits.

Full normalized menus remain local to the integration for lookup/paging and the future native-card contract; never return the whole raw menu to the model. Initial integration cards show at most six list rows, up to three glance blocks, with bounded strings. Richer native cards remain the VoiceOS team's work. Card-only UI is removed before model narration, so any fact that must be spoken also appears in the factual digest. The host's documented native-card payload limit is 32,000 serialized characters; widgets have different limits and are not a license to dump full raw data. [E13, E17]

At checkout, perform a fresh account check, cart read, and summary read for that exact cart. Do not reuse a total after a write or after more than 30 seconds. Any changed price is spoken as an update; a changed item price invalidates pending cart approval. If cart contents change during the checkout reads, discard the summary and refresh. Missing currency/total or unverified freshness prevents the claim of a complete priced summary; a browser link can still be offered with an explicit “total unavailable” explanation.

### 8.4 Error and retry contract

Read timeouts default to **8 seconds per HTTP request**; one read retry maximum for transient network/429/5xx errors, honoring `Retry-After`. If the indicated wait would exceed the current turn budget, return a wait/retry-later state instead of blocking the turn. Do not retry schema/auth/parameter failures. No automatic mutation retry. Background write flow has a proposed 45-second total processing budget; exceeding it yields an uncertainty result and retained journal state, not a false failure. Local abort does not prove server cancellation. [E08, E12]

| Condition | Internal state / required spoken behavior | Action |
| --- | --- | --- |
| No key / invalid API key (401) | `not_connected`: “The AgentWeb connection needs setup.” | No cart reads/mutations; no auto sign-in or key disclosure. |
| `AUTH_REQUIRED`, `AUTH_MISCONFIGURED` | `session_expired` or `not_connected`, based on known setup history: “Reconnect the DoorDash account.” | Invalidate cached identity/proposals; use documented hosted connection flow during authorized setup. |
| `get_account` guest flag true / missing consumer ID | `session_expired`; never present empty cart/history as valid. | Stop; do not fabricate missing IDs. |
| `INSUFFICIENT_CREDITS` (402) | `insufficient_credits`: “The integration has insufficient test credits.” | Stop paid calls. Never initiate a top-up. |
| `USAGE_CAP_EXCEEDED`, `BILLING_ACCOUNT_RESTRICTED`, `BILLING_UNAVAILABLE` | Budget/billing unavailable, not a restaurant/cart error. | Stop; retain error state and inspect usage. Documented non-execution may be recorded, but no auto write retry. |
| `MAP_NOT_FOUND`, `ACTION_NOT_FOUND`, stale map | `unsupported_action` / `map_changed`: “That action isn't available through this integration.” | Disable affected capability; no alternative action or browser automation fallback. |
| `INVALID_PARAMS`, `PARAM_UNRESOLVED` | `clarification_required` / `invalid_request`. | Use validated IDs; clarify; no mutation. Resolver substeps can still incur charges. |
| Malformed success body, missing critical data | `invalid_response`: “I couldn't verify the information needed to change the cart.” | Reads fail safely; a possibly dispatched write becomes `outcome_unknown`. |
| `TIMEOUT`, disconnection, `UPSTREAM_ERROR`, `UPSTREAM_APP_ERROR`, `PARSE_ERROR` after dispatch | “The cart may have changed; I need to check it.” | §7 reconciliation, not blind retry. A refund is not proof of rollback. |
| Supported read with valid empty result | `empty`, after a live identity check. | Honest empty result; distinguish filtered/invalid rows and unavailable data. |
| Unexpected error | `upstream_error` with a safe, short explanation. | Redacted diagnostics; no raw upstream text spoken or passed as instructions. |

Codes/statuses above are documented in AgentWeb's REST reference/OpenAPI; capture actual envelopes before freezing their exact adapter paths. Return MCP error semantics (`isError`/SDK error) for failures so they cannot be read as successful fallback data. Optional safe display data may accompany an error, but never `can_mutate: true`. [E03, E04]

## 9. Browser checkout and account binding

`get_checkout_summary` remains read-only. It returns a refreshed, projected summary and an optional handoff destination; it does not open a browser or place an order. Do not follow the current map's instruction-like outcome text suggesting `place_order`. [E01]

The original generic candidate is `https://www.doordash.com/consumer/checkout/`. This revision could not validate its authenticated behavior. Current AgentWeb metadata says to continue on doordash.com, not that it generates a cart-specific checkout link. Treat the path as a **candidate to verify on the target browser**, with the DoorDash home page as an honest manual-navigation fallback. Do not invent cart-ID query parameters, authentication tokens, or deep links. [E01, E23]

The integration sends no cookies or authentication material through the handoff. Opening a generic URL establishes neither the correct browser account nor the correct cart. Per-user AgentWeb connections alone do not solve browser account matching.

**Executable handoff check, owned by Rishabh with Yue:** on an authorized account A and a test-created cart, have the account owner confirm which account/profile is signed in to the target system browser. Request the approved URL. After opening, compare store, line identities/quantities, and a refreshed total with the AgentWeb snapshot; also confirm the displayed account matches A. Repeat with browser signed into authorized account B, and with signed-out browser state if available. Record matching, mismatching, and sign-in-required outcomes without proceeding to payment. Do not send session cookies between systems or claim transfer. If the browser cannot identify the same cart, stop at a summary/link handoff and explain the limitation.

**VoiceOS opening mechanics:** the documented widget bridge accepts `voiceos:openUrl` for HTTPS and opens the default browser. It does not document a success/failure acknowledgement. VoiceOS must identify its native agent URL-opening operation and whether it returns a trusted successful-open result. No such method name is invented in this PRD. [E14]

| Evidence available | Allowed speech |
| --- | --- |
| Only a link exists | “Here's the link to continue checkout on DoorDash. Check the account and cart there.” |
| Open request sent, no host acknowledgement | “I requested DoorDash checkout in your browser. Check that the account and cart match.” |
| Host confirms URL-opening success, account/cart not yet verified | “Opened DoorDash in your browser. Check the account and cart before continuing.” |
| Host confirms open, and the authorized test has established the matching session/cart under the documented demo conditions | “Opened your DoorDash checkout. Review the final total and finish there.” |
| Host reports failure | “I couldn't open DoorDash. Use this link to continue.” |

Never say “opened” based solely on a returned URL or a widget postMessage. Even a successful opening does not prove that checkout loaded, authentication succeeded, or a cart transferred. “Ordered,” “paid,” “submitted,” and “your food is on its way” are prohibited handoff outcomes.

Use a fixed validated HTTPS DoorDash destination; do not open a URL supplied by an arbitrary upstream instruction field. Opening is a host action outside the 12 DoorDash tools and follows the host's own confirmation policy. If voice-triggered URL opening cannot be verified, U7's automatic-open variant remains blocked; the clearly labeled manual-link variant can demonstrate the rest of the flow.

## 10. Installation, runtime, and package contract

### 10.1 Development sources versus published runtime

Preserve modular ownership in source. **Do not assume the source folder is the publish artifact.** The current Asana example's AGENTS.md explicitly says Publish ships only `server.ts`, `widgetKit.ts`, `voiceos.integration.json`, `package.json`, and `icon.png`. This is a directly inspected example constraint, not inspection of VoiceOS's publisher implementation. It corroborates the teammate's report and requires an early test. [E18]

VoiceOS distribution docs describe folder/repository installs and say the cloud store is not live, while its changelog describes share-link installs and bundled runtimes. Those sources conflict. Use the actual target build and published install as the deciding evidence, without treating either source as proof of recursive file inclusion. [E16, E17]

| Development path | Owner / role |
| --- | --- |
| `contracts.ts` | All three; shared models, action specs, error/result contracts |
| `agentweb.ts` | Yue; transport, trusted identity, billing/error normalization |
| `fixtures.ts`, `fixtures/` | Pranav; fixture adapter and labeled sanitized/synthetic cases |
| `scripts/record.ts`, local `raw/` | Yue; explicit bounded recording, never automatically exercised by preview |
| `scripts/sanitize.ts` | Pranav; allowlisted projection/redaction and synthetic identifiers |
| `tools.ts`, `server-source.ts` | Rishabh; exact registry and stdio entry source |
| `slices/browse.ts` | Pranav |
| `slices/cart.ts` | Rishabh |
| `slices/account.ts` | Yue |
| `test/`, `verify.ts`, preview fixtures | Slice tests plus Rishabh's protocol/package tests |
| `voiceos.integration.json` | Rishabh with slice owners; runtime, tools, setup, permissions, confirmations |
| `HANDOFF.md` | All three |
| Build step → root `server.ts` | Rishabh; generated publish runtime bundle, not separately hand-edited logic |

**Proposed publish artifact:** bundle first-party runtime modules, the selected fixture data, and required runtime dependency code into root `server.ts` as portable ESM; keep any required Widget Kit code in that bundle or the explicitly shipped root `widgetKit.ts`. Retain appropriate dependency license notices in the shipped material. There must be no runtime import/read from omitted nested directories. Generated package metadata must accurately describe anything still needed; no undeclared `tsx`, SDK, data file, or local absolute-path dependency.

Bundling success is not assumed. M0 must prove the generated runtime launches without the development tree, developer `node_modules`, or global tools. If publisher inclusion/build-size rules prevent this, Rishabh must verify a supported root-file artifact/dependency mechanism with VoiceOS before adding more slice code. Do not switch scope to a hosted service to sidestep the test.

### 10.2 Runtime and SDK compatibility

| Component | Verified state | Proposed decision / required check |
| --- | --- | --- |
| MCP TypeScript SDK | v1 package metadata: `@modelcontextprotocol/sdk` **1.32.2**, Node ≥18, Zod `^3.25 || ^4.0`. Official docs describe v1 as maintenance and v2 as current stable. [E20] | Pin v1.32.2 for this demo to match current VoiceOS stdio/scaffold examples. This is a deliberate compatibility choice, not a claim to use the newest SDK generation. Test actual host handshake. |
| Zod | Stable v3 metadata includes **3.25.76**; v1 SDK supports v3.25+. Latest overall observed package is 4.6.7. [E20, E22] | Pin **3.25.76** and use v3 APIs. The Asana example's `^3.24.0` is not evidence that an arbitrary old v3 satisfies the current SDK. |
| Node | Local inspection: 24.22.1 on Linux. Node 24 docs say type stripping is stable from 24.12 and does not type-check or honor tsconfig transformations. [E21, E24] | Node 24.12+ for development checks; type-check separately. Use erasable TS/no runtime enums/path aliases, or emitted JS for the bundle. No claim that `node --test` proves Bun/VoiceOS compatibility. |
| VoiceOS launcher | Asana run.sh prefers host-injected `VOICEOS_BUN`; published changelog describes bundled runtimes. [E16, E19] | Use the target host's generated OS launcher/runtime contract; record the actual Bun/runtime version. Do not replace it with a hard-coded machine Node path. |
| VoiceOS Integration SDK | Docs provide a repository CLI fallback; the public npm lookup returned 404 during revision. [E17, E24] | Do not require public npm availability. Obtain the current scaffold/validator from the VoiceOS team or accessible checkout; keep runtime helpers inline where supported. |
| VoiceOS main repository Zod | Not accessible. The team Asana integration is a separate package. [E19, E24] | Portability is unverified. Request the main package/version only if native porting is planned; it is not a blocker for an isolated demo. |

Build tools, type-checker, and test runner are development dependencies and must be locked. The shipping runtime uses standard fetch/AbortController and Node-compatible primitives rather than Bun-only file APIs. Preserve exact versions/integrities and generated bundle hash in HANDOFF.md. Upgrading to SDK v2 is a separate compatibility decision, not an automatic dependency bump.

### 10.3 Manifest, permissions, and previews

- Manifest/UI `schemaVersion: 1`; stable integration ID; semver version; exact 12-tool registry; every tool has routing-oriented description and strict input schema. All three cart writes declare confirmation views; reads do not. [E10–E12, E17]
- Default `DOORDASH_MODE=fixture`. Explicit live mode plus configured secret and passed gates is required; invalid mode fails closed. Fixture mode must reject any network attempt. Never silently substitute fixtures when live authentication fails.
- Minimal runtime network permission: `mcp.agentweb.us` only. Add another domain only if an implemented runtime call truly needs it. DoorDash browser handoff is performed by the host, not an extra integration fetch. Bundled runtime dependencies should not require registry downloads at startup.
- Background permission for the write/preflight/verification flow; no notify, transcript, store, webhook, direct-payment, or address-edit permission unless a demonstrated requirement changes the design. Do not use undeployed/reserved APIs. [E12, E15, E17]
- Safe preview inputs exercise all 12 tools only in fixture mode. VoiceOS's verifier actually invokes handlers, and Studio may overwrite preview samples after real runs. Add a guard that refuses the entire preview/verification run in live mode; sanitize/review preview artifacts before sharing. [E17]

### 10.4 Early install proof — M0, before live slice work

Rishabh runs this on the chosen VoiceOS build with a fixture-only skeleton:

1. Record app version/build, OS/architecture, generated launchers, bundled runtime, manifest schema, and source/bundle hashes.
2. Install through the documented **Settings → Agent Mode → Integrations → Install from folder** route, or record the actual equivalent Studio route. Verify consent/setup, MCP initialize, the exact tool set, a fixture result card, and a native yes/no/correction cycle. [E17]
3. In a disposable fixture build, reference a small nested module and nested data marker; publish/share it using the actual UI. Inspect the exported/recipient file inventory and startup outcome. A local-folder success is not a published-package result.
4. Publish the bundled root runtime. Open the share link in a clean recipient profile/machine with no source checkout, developer dependencies, or live key. Confirm nested source/data behavior survives through the bundle, tools/cards load, and fixture mode makes no network calls.
5. Test reload, restart, journal write access, uninstall/reinstall, missing-secret behavior, and launch from a path different from the developer checkout. Verify no key, raw capture, operation journal, or account-specific setup is included in the shared artifact.
6. Record which files and dependencies actually shipped, the share URL, artifact hash, and pass/fail evidence. No publishing or installation has occurred as part of this PRD revision.

If nested files are omitted, keep development modular but ship the verified root bundle. If share publication is unavailable in the target account/build, document the precise access blocker and verify the folder artifact separately; **published installation remains an unresolved acceptance gate**, not an implied pass.

## 11. Offline fixtures and acceptance tests

### 11.1 Fixture provenance

Each fixture includes an action, case ID, map/schema version, `synthetic` or `sanitized_live` provenance, capture date when applicable, and expected normalization/error state. Hand-authored examples unblock work but never count as live observations. Do not relabel them after a demo without replacing and reviewing their payloads.

Cover all 12 actions and failure cases, but record only authorized reads and test-created cart mutations. Preserve cross-file relationships with deterministic synthetic IDs; keep monetary values/types/option nesting intact. Replace names, emails, phone numbers, street addresses, consumer/order/cart IDs, delivery instructions, credential-bearing URLs, and account identifiers. Automated PII patterns plus manual review are required; a regex scan alone is not proof of anonymization. `raw/`, secrets, and runtime journals are excluded from commits and publishing.

Fixture mode must intercept **all** transport paths, including usage/preflight/reconciliation; tests fail if any network request is attempted. The installed fixture bundle must include the same safe cases that protocol/voice tests use.

### 11.2 Acceptance matrix

All cases below are **not run** at revision time. Offline expected values are synthetic. Mark each case with run date, build, provenance, outcome, receipt/call count where applicable, and any gap. Live cases follow §13; do not perform destructive fault injection on a real account.

| ID / owner | Test setup and execution | Required result / evidence |
| --- | --- | --- |
| A01 / Rishabh | Compare manifest/MCP registry and attempt an unknown action plus each of the four explicitly excluded actions. | Exactly 12 registered; exclusions rejected before network in every dispatch path. No preview/order call. |
| A02 / all | Start fixture mode with no key; exercise all actions, errors, previews, and reconciliation. | No network; deterministic models, cards, and error semantics. |
| A03 / Pranav | Search has headers with empty IDs, missing fees, and a valid empty result. | Non-store rows unselectable; unknown fee omitted; valid empty distinguished from malformed/all-filtered data. |
| A04 / Pranav | Oversized menu/long descriptions and multiple pages. | Digest/card budgets hold; IDs and ordinal ordering remain stable; no raw/full menu reaches model. No popularity ranking. |
| A05 / Rishabh + Pranav | Full spoken U1–U7, including “second one,” “those,” cart read, refreshed total, and browser handoff. Run fixture voice first, then one live flow. | Correct store/item context, one approved add, verified result, current total, truthful URL-opening language. Evidence records fixture/live separately. |
| A06 / Rishabh | Propose two items, say “actually one,” approve; separately say no/cancel/dismiss. Try approving a superseded card. | New one-item proposal/price; old intent rejected; zero writes for cancellation; no stale-card execution. |
| A07 / Rishabh | Same item names across stores/variants, stale list, “two of those” with no selected item, unclear quantity. | Clarification; no write until one valid referent and quantity are established. |
| A08 / Rishabh | Simple item with quantity 2 in one request. Separately add 2 more to an existing matching line. | Quantity parameter is sent once per approval; aggregate quantity delta exactly 2, including merge/separate-line cases. Small live check required. |
| A09 / Pranav + Yue | Required size, optional paid add-on, nested required child, min/max conflict, missing constraints/price. | Correct recursive validation; no guessing. Unverified nonempty encoding and missing data block writes. Modifier success requires provider grammar plus bounded live evidence. |
| A10 / Rishabh | Existing same-store cart, different-store cart, cart changes while approval is pending. | Explicit target binding; unrelated lines preserved; no silent replacement; stale proposal rejected without write. |
| A11 / Rishabh | Remove a line with quantity 3; request “remove one”; delete a draft cart. | Confirmation names whole-line quantity; decrement refused; deletion verified and never described as cancelling an order. |
| A12 / Rishabh | Deliver the same intent twice, concurrently and after a restart; a different payload reuses its ID. | At most one dispatch; stored outcome/reconciliation reused; payload mismatch rejected; unknown/lost journal disables new writes pending baseline. |
| A13 / Rishabh | Fixture write commits but response times out; another never commits; another applies a partial/conflicting change. | No blind retry; post-read identifies known success or uncertainty; unchanged read alone does not authorize a repeat. No automatic destructive compensation. |
| A14 / Rishabh + Pranav | Price changes between read, approval and execution; checkout price changes; subtotal or currency absent. | Reconfirm changed mutation quote; speak changed checkout price; missing critical data blocks mutation/complete-total claim; never substitutes zero. |
| A15 / Yue | Guest/missing consumer ID, invalid key, auth expiry mid-flow, reconnect/account change. | No misleading empty cart/orders; typed state and safe speech; old cache/proposal/IDs unusable. |
| A16 / Yue | Credits exhausted, usage cap, billing unavailable, 429 Retry-After, stale/unsupported action, malformed/error-in-200 payload. | Correct states; no top-up; bounded read retry only; potentially executed writes reconcile. |
| A17 / Yue | Two-account isolation sequence in §12, plus cached/pending A data after switching to B. | No A cart/address/order data or IDs exposed through B; no fallback to shared identity. Live isolation cannot pass with fixtures alone. |
| A18 / Yue + Rishabh | Connected account A; browser A, browser B, signed-out browser; generic candidate URL/redirect. | Document actual cart/account match or mismatch; no assumed session transfer; no payment. |
| A19 / Rishabh | Host open success, failed opening, and no-acknowledgement path. | “Opened” only after host success; fallback offers a link; no order claim. |
| A20 / Rishabh | Stop playback while pending and during a simulated in-flight write; cancel action before/after dispatch. | Speech stop distinguished from action cancellation; no false rollback claim; actual/uncertain cart state reported. |
| A21 / Rishabh | Write “Asks first” on/off on the target build. | Supported demo configuration confirms every write; override behavior recorded. No claim that manifest default is unoverrideable; writes stay disabled if required configuration cannot be established. |
| A22 / Rishabh | Published/share-link install on clean recipient; nested module/data canary; bundled artifact; restart/reload. | Real installed artifact works without developer files/dependencies/key; exact tool set; no secret/state leakage. Local-only proof insufficient. |
| A23 / all | PII/secret scan and manual fixture/preview/share inspection; malicious instruction-like fields within nested payloads. | Explicit projections only; secrets/PII removed; no instruction-induced action, URL, or permission escalation. |
| A24 / all | §6 latency measurement, slow/timeout fixtures, background completion. | Measured counts/p50/p95 reported; truthful progress and no premature success. Host end-to-end timing distinct from API duration. |
| A25 / Yue | Cleanup with both test-created and baseline carts/lines; unrelated browser edit. | Only manifest-listed test-created state is removed with exact confirmation; ownership uncertainty halts cleanup. Addresses/orders/payment state untouched. |

Global release gates: offline suite and stdio verifier pass; target host voice flow and safety tests pass; live simple quantity test passes; published install passes; cost ledger remains below $20; handoff is reviewed. Modifier support and multi-user support may remain explicitly disabled/limited, but cannot be advertised as passing. U7's auto-open claim requires its host acknowledgement gate.

## 12. Executable two-account isolation test

**Owner:** Yue (proposed); Rishabh verifies local state/checkout boundaries. Use two existing, explicitly authorized DoorDash accounts A and B. No request for multiple addresses on either account. No new orders, payment methods, or account-setting changes.

1. Establish a supported mapping `local installation/subject A → AgentWeb connection A → consumer A` and likewise B. Separate keys/installations are acceptable for this test. If testing org delegation, first verify its supported transport and restrictions. Confirm consumer IDs differ; otherwise stop as a setup failure.
2. For each identity, capture `get_account`, `list_addresses`, `get_cart`, and `list_orders(limit=5)`. Record redacted stable hashes/IDs and currency evidence privately. An empty order list is allowed but is not by itself proof of order-data isolation. Require a valid session check for both.
3. Start only from empty current carts, or use dedicated accounts already having no unrelated draft state. If an account has an existing non-test cart, read it but postpone cart mutation testing; do not delete it to make the test pass.
4. Under A, use the confirmed simple-item path to create a test cart with quantity 1. Record cart/line/item/store identifiers in the cleanup manifest. Under B, read cart/addresses/orders again; compare with B's baseline. B must not gain A's cart/line IDs or private data.
5. Under B, create its own test cart using a distinguishable item/store. Re-read A; A's cart and private reads must still match A's expected state. Re-read B. Check each request/response against its verified consumer and connection binding, not just display names.
6. Try using A's cart/order references through B's integration input. The local provenance/identity check must reject before upstream execution. This establishes our boundary, not the provider's resource-authorization guarantee. If provider-level cross-resource isolation also needs proof, Yue must define a separately authorized read-only provider test with AgentWeb; do not infer that guarantee from local rejection.
7. For order-data isolation, where either authorized account already has history, compare returned order IDs/fields with that account's own known history and verify no cross-account exposure. Exercise a known order's status only with its owning identity. If both histories are empty or no past-order access is authorized, label the live order-content portion **inconclusive**, cover behavior synthetically, and record the remaining provider check. Do not place an order to obtain test data.
8. Create a pending A proposal; switch/reconfigure to B and restart/reload as required. A's proposal, cached references, and journal execution route must be invalid for B. Repeat with reconnect and an unresolved delegated user; neither can silently fall back to A/Maks.
9. Execute the browser checks in §9 separately. AgentWeb A/B isolation does not establish browser A/B alignment.
10. Under each owning identity, remove only that test's recorded cart/lines after confirming their current contents still match the test manifest. Verify cleanup; compare saved-address and order snapshots with baseline. No address/default/payment restoration actions are part of this plan.

Pass report: mechanism, two distinct redacted consumers, connection/subject binding, before/after cart evidence, address/order isolation or explicit inconclusive portions, stale-proposal rejection, browser findings, and cleanup receipts. If only Maks's single account is available, mark this test **blocked** and retain a single-account supervised demo; never mark it passed or defer investigation ownership to Maks.

## 13. Live-test budget, recording, and cleanup

### 13.1 Less-than-$20 spending plan

AgentWeb's public PAYG price is $0.05 per completed action, with failed-action refund policy; the smallest advertised purchased block is **$25**. Thus a new self-serve top-up would violate a less-than-$20 incremental cash limit. Use already funded, explicitly allocated credits or an explicitly provisioned evaluation allowance. Their availability is a dependency, not an assumption. If neither exists, live testing is blocked; continue offline. No purchase/top-up is authorized by this PRD. [E07]

Count consumed existing credits at the verified effective rate as testing cost, even when the current cash outlay is zero. Before a session, read `GET /api/usage` and confirm its `action_price`, `charge_unit`, payer/metering mode, balance source, and allowance. Use the actual values, not a hard-coded one-credit conversion. The spec permits credit or cent billing units. [E03]

| Planned phase | Maximum execute attempts | Cost at $0.05 if all complete |
| --- | --- | --- |
| Session/schema/currency checks and approved P2 samples | 30 | $1.50 |
| Browse/item discovery and one simple quantity case | 40 | $2.00 |
| Cart behavior, fresh pricing, post-write reads | 50 | $2.50 |
| Two-account isolation and browser alignment | 50 | $2.50 |
| One published-install live smoke flow / final demo | 30 | $1.50 |
| Reserved reconciliation and test-state cleanup | 60 | $3.00 |
| Contingency, including one verified modifier case if unblocked | 40 | $2.00 |
| **Total hard attempt cap** | **300** | **$15.00** |

These are maxima, not a requirement to spend them. Early published installation is fixture-only; the 30-call installed live smoke occurs later. Calls to `get_account`, verification reads, repeated reads, any provider resolver substeps, and cleanup all count. Send known IDs to avoid unnecessary resolver work. No local retry can bypass the ledger.

Set an internal stop threshold of **$18.00 projected total incremental cost**, including pending/unknown charges, any attributable incremental host/service charges, and known taxes/fees, leaving headroom below $20. Before each call reserve its worst-case cost; preserve the 60-call recovery/cleanup allocation before optional probes. Reduce the attempt cap if the effective rate is higher than $0.05. If a bounded per-call charge cannot be established, do not execute live. A refund reduces cost only after it is reflected in evidence. Stop optional tests early rather than spending the cleanup reserve.

Yue owns a private session ledger: local operation/call ID, action, account label, timestamp, reserved/settled amount, unit/rate, returned `charged`/legacy billing alias, trace/support receipt, outcome, cumulative cost, and cleanup eligibility. Parent failures can still have billed resolver reads. Compare receipts with usage at session start/end; a shared workspace balance delta alone is not our spend because others may use it. Unreconciled charges remain reserved; unavailable usage evidence pauses further tests. [E03, E04]

### 13.2 Live scope and cleanup

Only Yue holds the shared demo key and operates live calls. Other teammates develop and test with fixtures. Two-account runs require each account owner's authorized credentials/participation without distributing Maks's key. Pause other cart editors for the supervised session.

Before each session record the permitted account, baseline cart, test-created-state manifest, available budget, and cleanup plan. Capture only what is needed to prove a selected contract. Do not run all scenarios live: timeouts, duplicates, malformed data, price races, and destructive fault injection belong primarily in fixtures. At most one controlled real modifier add is needed after its grammar is established. Stop at checkout; do not place any order.

Cleanup may remove only cart IDs/lines created by the test and still attributable to it. Confirm the exact target and verify it. If a test line merged into a pre-existing line, or someone added unrelated state, do not delete the entire line/cart. Report the remaining test state for manual review. Never clear an arbitrary “current cart,” delete/revoke unrelated connections, alter saved addresses/defaults, or touch order/payment history. Keep raw captures private until sanitized fixtures are reviewed, then delete the raw copies within seven days; retain only redacted test evidence, bundle hashes, and billing receipts needed for handoff.

## 14. Milestones and gates

The original three-way implementation split is retained. Work can proceed in parallel after contracts agree, while demonstrations are prioritized P0 → P1 → P2. The schedule below is a **provisional three-week work sequence only**. November 15 and three weeks remain competing deadline statements; no calendar completion date is committed.

| Milestone | Provisional sequence | Owner | Exit evidence |
| --- | --- | --- | --- |
| Contracts / investigation start | Day 1 | All three; Yue leads identity | Freeze normalized models, local wrapper versus upstream params, error/proposal contracts, fixture provenance and budget ledger. List live capability blockers rather than filling them with guessed schemas. Ask Maks to resolve deadline/start date. |
| **M0 — early install and share proof** | Days 1–2, before substantial slice implementation | Rishabh | Target build/runtime recorded; fixture skeleton installs locally and through a real share link; nested-file canary and bundled-root strategy evaluated; dependency/state-path behavior recorded. Publication access failure is an explicit blocker. |
| **M1 — foundation** | Remainder of Week 1 | Yue / Pranav / Rishabh | Client/envelopes/key handling; 12-action registry; offline cases for all actions; PII projection tests; approved initial live schema/account/currency observations if access is available. Synthetic data remains labeled. |
| **M2 — P0 browse** | Mid Week 2 | Pranav | Spoken search/menu/item flow; stable reference resolution; bounded digests/cards; ambiguous/missing choices safely handled. |
| **M3 — P1 cart** | Early Week 3 | Rishabh, with Yue's live operation | Native confirmation/correction/cancellation; quantity-2 single-call proof; existing-cart behavior; journal/deduplication/post-read verification; fresh checkout; truthful handoff. Modifier writes enabled only if their separate gate passes. |
| **M4 — identity findings / optional P2 reads** | Before final integration; P2 target mid Week 3 | Yue | Team-owned multi-login note; two-account test passed or explicitly blocked/inconclusive; read-only addresses/history/status shown when available. No address change. |
| **M5 — installed demo and handoff** | End of provisional Week 3 | All three; Yue runs live | Published build reinstalled, complete voice-led flow and approved limitations recorded, cost/cleanup evidence complete, HANDOFF.md reviewed. No fixture pass is relabeled as live. |

If the key/credits are late, continue fixture and published-install work; do not invent successful live recordings. If November 15 is selected, Maks and the team must explicitly rescope/resequence using this gate list. P2 and verified modifier support are candidates to defer; safety, published installation, quantity honesty, and browser handoff truthfulness remain required for the behaviors advertised.

## 15. Dependencies and precise asks

### 15.1 Work our team can implement

| Work | Owner | External input actually needed |
| --- | --- | --- |
| Strict 12-action adapter, projections, errors, usage tracking | Yue | Public docs/metadata available; real key and authorized samples needed for live verification. |
| Browse, safe modifier read models, fixture adapter/sanitizer | Pranav | Nonempty option encoding only for modifier writes; not needed to browse or refuse unsupported configurations. |
| Cart proposals, locks/journal, deduplication, reconciliation, confirmations, packaged stdio runtime | Rishabh | Target VoiceOS scaffold/build and early install access. No DoorDash API partnership required by this implementation plan. |
| Multi-login investigation and two-account test | Yue, proposed lead; Rishabh supports host state | Existing authorized second account/connection or a supported delegated mechanism; AgentWeb must clarify unresolved delegation limits. |
| Basic integration cards and contract handoff | Slice owners | VoiceOS owns any custom native React card implementation. |

### 15.2 Maks supplies decisions/access, not a multi-login solution

| Ask | Needed by | Effect if unavailable |
| --- | --- | --- |
| Existing AgentWeb key via private secret setup; identify and verify its connected DoorDash account | Initial bounded live reads | Live work blocked; fixtures continue. |
| Explicit scope for reading saved-address/order data and creating/removing only test draft state | Before those checks | Omit unauthorized reads/writes; no default-address changes requested. |
| Allocation of existing funded credits or a provisioned evaluation allowance; total test cost < $20 | Before live session | No new $25 self-serve purchase; live checks blocked without a compliant allowance. |
| Resolve **November 15 vs three weeks**, including the three-week start date; identify reviewing recipient | Day 1 | Relative gates remain; no invented deadline. |
| Existing past order only if available and authorized; facilitate access to a second consenting tester if possible | Identity/P2 gate | Empty/inconclusive order test or blocked two-account test; never create an order or require multiple addresses. |
| Confirm receiving format and review/demo cadence | Before M5 | Proposed deliverable is source repository/folder plus published demo link and HANDOFF.md. |

### 15.3 AgentWeb clarification/support

Yue owns preparing and tracking these questions; Maks may facilitate vendor contact. This revision sends no messages.

| Question | Concrete evidence required | Scope impact |
| --- | --- | --- |
| Exact `nested_options` grammar, nested/default/quantity rules | Versioned schema and successful current example mapping real `get_item` groups/options to an add | Blocks modifier writes, not simple-item browsing/demo. |
| `quantity` delta/merge semantics and reliable cart-line association | One controlled quantity test and stable response fields; document cart price/quantity response shape | Required to accept “add two” and repeated additions. |
| `on_behalf_of` supported transport, org/member requirements, cart-write classification | Current contract and two distinct authorized consumers; explain REST/MCP mismatch | Determines viable delegated demo mechanism; team investigation does not wait for an assumed future feature. |
| Cart-effect idempotency and timeout settlement | Key scope/retention, same-key concurrency/payload mismatch, whether execution or only billing deduplicates, how to establish terminal non-execution | Until established, no automatic write retry. |
| Current REST response/freshness contract versus runtime 0.10.21/public spec 0.9.0 | Actual supported envelope and cache-bypass evidence; currency and pricing completeness | Required for reliable normalization/preflight. |
| Optional cart-specific browser handoff | Existing supported URL/session mechanism, if any, without credential exposure | Nice to have only; not assumed, not a required DoorDash deliverable. |

Guest search with location is not a dependency for this default-address demo. It may be noted as a future provider request, with no promise to deliver it here. Enterprise availability is not presumed to resolve identity or browser-session issues.

### 15.4 VoiceOS must provide or verify

| Need | Owner coordinating | Required evidence / fallback |
| --- | --- | --- |
| Named technical contact, exact target build/OS, current scaffold/validator | Rishabh | Current supported files and CLI/source access; no assumption public SDK npm package exists. |
| Actual publish/share inclusion and recipient runtime/dependency behavior | Rishabh | M0 exported/installed inventory and clean-recipient pass. Folder-only installation does not close this ask. |
| Native spoken yes/no/correction, pending-cancel and in-flight-stop semantics | Rishabh | Target-host acceptance evidence; use native UI, not a replacement speech stack. |
| Trusted required-confirmation policy / metadata and subject identity, where available | Rishabh + Yue | Document override limits and supported supervised configuration; no invented approval/user context field. |
| Native URL opener with a trustworthy success/failure result | Rishabh | Exact supported operation/result and a target-host observation. Without acknowledgement, link/requested-opening language only. |
| Spoken progress and timing visibility for slow work | Rishabh | Supported host mechanism, or documented background-card fallback plus an explicitly unpassed spoken-progress target. |
| Five custom native cards and optional later native port | VoiceOS team, coordinated by slice owners | They review our StoreList/Menu/Item/Cart/CheckoutSummary contracts. A `lib/main/doordash/` move and main-repo Zod compatibility are future decisions, not current deliverables. |

### 15.5 DoorDash dependency boundary

The demo depends on an existing authorized consumer session and current restaurant/menu/cart data accessible through AgentWeb. There is no established custom DoorDash API, consumer sandbox, partnership, or cart-link service for this project.

Official DoorDash documentation currently describes its CLI and Corporate Ordering MCP as **limited beta**, with distinct individual versus organizational purposes; Marketplace API access is also limited. Those products do not establish access for this AgentWeb demo, prove its nested-option encoding, or provide a general consumer testing sandbox. Do not carry over historical hardware/waitlist restrictions without checking their own current docs if a separate project ever adopts them. [E23]

No DoorDash engineering work or partnership deliverable is assumed necessary for the bounded demo. Nor does this PRD assert that account access alone establishes DoorDash authorization of a future commercial integration. If access/policy restrictions prevent the selected workflow, record the block and keep the demo read-only/fixture-based rather than creating a new ordering platform.

## 16. Mapping to the original ticket

| Original criterion | Revised treatment |
| --- | --- |
| Marketplace Beta / hidden on non-arm64 | This is a local-MCP demo, not the dd-cli binary. AgentWeb being cloud-based does not prove host/launcher portability; claim only the OS/architecture actually tested. |
| Five connection states | Preserve connected/not-connected/session-expired/insufficient-credits/upstream-error concepts, with explicit unsupported, invalid-data, stale-proposal, and unknown-write states. Do not collapse uncertainty into success. |
| 13 operations | **12 by confirmed scope change.** `list_addresses` retained; address mutation removed. |
| Order submission blocked | Enforced before every network call. Current map includes `place_order`; even its preview is excluded. |
| Default-address location, no Cupertino fallback | Still applicable. Search uses connected account's default address; no invented location override or fallback city. |
| Directive fields never reach AI | Explicit recursive projections; no blanket passthrough. |
| Menu digested | Bounded paged factual digest; local full normalized menu for lookup/card handoff; no raw dump. |
| Required modifiers never guessed | Retained; current parameter exists but nonempty encoding is gated on evidence. |
| Live checkout pricing and browser handoff | Fresh cart/summary, currency/completeness checks, separate account-match and host-open evidence. |
| Never claims an order was placed | Retained in tools, errors, cards, spoken output, tests, and handoff. |
| Sanitized fixtures; no raw captures committed | Retained, with provenance and published-preview review. |
| Cards render from fixtures | Our basic integration cards/confirmations must render in the installed fixture build. The VoiceOS team owns custom native cards. |

## 17. Handoff and definition of done

HANDOFF.md must contain:

1. Target app/build/OS/runtime, exact package versions and integrities, bundle/source hashes, actual folder/publish/share path, shipped file inventory, and clean-install result.
2. Fixture/live setup, secret configuration, exact 12-action manifest/registry, denied actions, permissions, safe preview command, and refusal to run previews live.
3. Shared contracts, upstream-to-model mappings and captured shape references; StoreList, Menu, Item, Cart, and CheckoutSummary card payloads with always-present/optional/unknown fields; rendering budgets.
4. Spoken script, reference-expiry rules, native confirmation configuration and override limitation, cancellation/stop/undo behavior, measured latency and gaps.
5. Quantity behavior and proof; modifier encoding status; critical-data gates; journal/state path, recovery and deduplication procedure; known residual cart races.
6. Identity investigation, two-account evidence or precise blocked/inconclusive portions, and browser-account/cart-match findings. No claim that per-user connections automatically solve checkout.
7. Checkout URL evidence, host-open operation/result if available, approved wording for each outcome, and the prohibition on order/payment calls.
8. Test matrix with actual runs/provenance, unsupported/error observations, remaining blockers, cost/receipt summary, cleanup manifest/result, and raw-data retention/deletion status.
9. Responsibility boundary for native cards, optional native port, provider support, and any later production work. Production is not this project's acceptance target.

**Done means demonstrated, installed behavior matches the advertised scope.** An integration may be handed over as a limited simple-item, single-account demo only when its limitations are explicit and its applicable safety/install/voice/live gates pass. Do not label disabled modifiers, blocked account isolation, unacknowledged URL opening, or a folder-only install as completed capabilities.

## 18. Concise change log

| Change | Result |
| --- | --- |
| Applied Maks's newer scope | Exactly 12 actions; removed address writes, address-switching story/demo, multiple-address requests, and address-restoration cleanup. Read-only address access remains. |
| Rechecked current map | Map 1.2.2 has quantity/options/cart-ID parameters and an upstream order action. Updated U4; explicitly deny ordering/payment actions. |
| Corrected idempotency | Billing protection is documented; cart-effect deduplication is not established. Added proposal journal, post-write verification and conservative timeout reconciliation. |
| Made voice behavior executable | Specified summaries/paging, references, clarification, spoken approval/correction/cancellation, stop/undo distinctions, progress and measurable latency. |
| Bound mutation approval | Exact identity/item/options/quantity/price/cart proposal, expiry, fresh preflight, stale rejection, and no fallback authorization. |
| Defined account and checkout checks | Team-owned multi-login investigation, proposed Yue lead, executable two-account test, browser mismatch test, and host-acknowledged opening language. |
| Replaced passthrough/fallback assumptions | Explicit projections, typed unknowns, preserved currency/units, and critical-data write gates. |
| Added early published-install gate | Verified Asana's root-file warning; proposed bundled runtime; clean recipient/share-link, nested-file and dependency tests at M0. |
| Updated runtime assumptions | Pinned compatible v1 SDK/Zod choice, distinguished maintenance from latest stable, accounted for bundled Bun and unavailable public VoiceOS SDK package. Main-repo portability remains unverified. |
| Bounded spending and dates | Planned 300-call/$15 cap at verified PAYG rate, $18 projected stop, existing-credit requirement; explicitly retained November 15 versus three-week deadline conflict. |

## 19. Evidence register

All sources below were inspected on **November 3, 2026 (America/Chicago)**; some HTTP response dates are November 4 UTC. D/O labels describe what was actually established. No source establishes that this project's live acceptance tests passed.

| ID | Exact source and relevant section/version | Conclusion and evidentiary limit |
| --- | --- | --- |
| **E01** | [AgentWeb detailed DoorDash map](https://mcp.agentweb.us/api/sites/doordash.com), JSON `version`, `partial`, `actions[].name/kind/auth_provider/params/description/outcome`; **1.2.2**. Retrieved successfully by public HTTP GET. Snapshot SHA-256: `d21c82ab2daba10475f38939bacb8f01b71a30ad77a5e1fc14582050737c1ee9`. | **D/O metadata:** 16 upstream actions, all selected actions require `doordash`; optional quantity/options/cart parameters exist; price units described as cents; account/default-address behavior and action response descriptions. Nonempty option grammar and complete typed output schemas are absent. No action execution observed. |
| **E02** | [AgentWeb full mapped-site library](https://mcp.agentweb.us/maps/library), map with `domain=doordash.com`, **1.2.2**, `actions[].params`. | **D/O metadata:** independently retrieved compact map confirms action names/descriptions but lists mandatory params only. Not suitable for inferring absence of optional quantity/modifiers. |
| **E03** | [AgentWeb OpenAPI](https://www.agentweb.us/openapi.json), `info.version=0.9.0`; `paths./api/execute.post`, `components.schemas.ExecuteRequest`, `ExecuteResponse`, `ExecuteResult`, `ExecuteErrorResponse`, `UsageResponse`; `paths./api/usage.get`. | **D/O schema:** Bearer/REST route, flat/coerced params, `fresh`, response/data forms, idempotency billing semantics, codes and credit/cent units. REST schema omits `on_behalf_of`; version differs from live health. Schema is not proof that a DoorDash write deduplicates. |
| **E04** | [AgentWeb REST reference](https://docs.agentweb.us/rest-api), **Core runtime → Execute**, response examples/error table/retry notes; [live health](https://mcp.agentweb.us/health), **0.10.21** observed. | **D:** REST versus MCP envelope descriptions, structured failures and trace/receipt guidance. **O:** public runtime reachable/healthy at revision; not proof of credentialed endpoints. Documentation/public-spec/runtime differences require real read-envelope capture. |
| **E05** | [AgentWeb runtime tool manifest](https://mcp.agentweb.us/.well-known/mcp/tools.json), `tools[name=execute].input_schema.properties.on_behalf_of`, `params`, annotations; [public mirror](https://www.agentweb.us/.well-known/mcp/tools.json). | **D/O metadata:** org-only Slack-linked delegation and refusal of spending actions; `params` string values; `idempotentHint=false`. Whether cart writes count as spending and whether REST supports delegation are unverified. No generic arbitrary-end-user connection contract established. |
| **E06** | [AgentWeb authentication and target-site connections](https://docs.agentweb.us/agent-auth), **Public access**, **Connect a target-site account**, **Provider connection example**, **Authority is separate**. Tool manifest entries `agentweb_connection_status`, `agentweb_start_connection`, `agentweb_poll_connection`. | **D:** account API key and target-site connection are distinct; exact provider comes from the action map; hosted connection/status/poll mechanisms exist; access is not action approval. No account connected during this revision. |
| **E07** | [AgentWeb pricing](https://docs.agentweb.us/pricing), **Pay as you go**, **Enterprise**, **Checkout**. | **D:** indicative $0.05 completed action, advertised $25/$50/$100 blocks, failed-action refund policy, custom Enterprise terms. Actual signed-in catalog/account rate and available credits were not accessible. A fresh advertised minimum top-up exceeds the user's testing limit. |
| **E08** | [AgentWeb streaming/recovery](https://docs.agentweb.us/streaming), **Error recovery**; compare E03/E04 same-key billing guidance. | **D:** Retry-After and verification-aware recovery guidance. Its fresh-key wording does not establish safe cart retries or duplicate prevention. No action-specific timeout/SLA verified. |
| **E09** | [AgentWeb sandbox](https://docs.agentweb.us/sandbox), **Free public checks**, **Credentialed setup**. | **D:** public metadata evaluation is distinct from private execution. No consumer DoorDash sandbox entitlement is established by this page. |
| **E10** | [VoiceOS: How it works](https://docs.voiceos.com/integrations/how-it-works), **A turn, step by step**, **Where your code runs**, **Secrets**. | **D:** local stdio process, host voice/agent/narration/cards, manifest confirmations, env-injected secrets. Public documentation, not an observation of the target desktop. |
| **E11** | [VoiceOS confirmation cards](https://docs.voiceos.com/integrations/confirmations), **Bindings**, **What the user can do**, **Users can turn confirmations off**. | **D:** pre-handler card, edited args, spoken yes/no/revision, Asks first override. Does not establish a mandatory unoverrideable policy or a signed approval token exposed to the handler. |
| **E12** | [VoiceOS defining tools](https://docs.voiceos.com/integrations/tools), **Handlers**, **Sync vs background**, **Network**, **Action availability and visibility**. | **D:** handler input validation, configuration via env rather than context object, failure semantics, ~8-second fetch example, ~20-second background guidance. No documented general mid-call TTS function or trusted identity/approval context established. |
| **E13** | [VoiceOS result cards](https://docs.voiceos.com/integrations/result-cards), **Attaching a card**, **Background completion**, **The budget**, **The vocabulary**. | **D:** `_voiceos_glance` removed before model reads data; narration needs factual data alongside UI; native card block/row limits. Does not mean all data in a tool result is hidden from the model. |
| **E14** | [VoiceOS widget bridge](https://docs.voiceos.com/integrations/reference/widget-bridge), **voiceos:openUrl** and message tables. | **D:** HTTPS message requests default-browser opening. No open-result acknowledgement is described; neither session transfer nor cart match is promised. The Markdown source at the same path plus `.md` was retrieved directly when the search reader failed. |
| **E15** | [VoiceOS hooks](https://docs.voiceos.com/integrations/hooks), **Declaring hooks**, **Deadlines and fail-open**, **What hooks can never do**. | **D:** transcript permission, reserved hook tools, shared deadlines/fail-open, no self-approval. They are not a reliable mandatory cart authorization gate. |
| **E16** | [VoiceOS changelog](https://www.voiceos.com/changelog), public latest listed **0.1.40, October 19, 2026**; **0.1.24, August 18, 2026** sharing/runtime notes; compare [Install & share](https://docs.voiceos.com/integrations/distribution), **Installing**, **Sharing**, **The App Store**. | **D, conflicting freshness:** changelog describes shared links/bundled runtimes; distribution page says store not live/folders and repos. Exact target UI, publisher inclusion, and runtime must be observed at M0. Latest public release listing does not identify the user's installed build. |
| **E17** | [Build with code](https://docs.voiceos.com/integrations/build-with-code), **Scaffold a folder**, repository CLI fallback; [Testing & debugging](https://docs.voiceos.com/integrations/testing), **verify.ts**, **Preview fixtures**, **A cold start**; [Manifest reference](https://docs.voiceos.com/integrations/reference/manifest), **runtime/auth/permissions/tools**; [Limits](https://docs.voiceos.com/integrations/reference/limits), **Size limits**, **Timing**, **Stability**. | **D:** schema version 1, real verifier invocation, safe previews, setup/permission contracts, reserved features and budgets. More specific manifest/limits references take precedence over the overview's misleading store-permission summary. `hosted`, `store` API and brokered OAuth cannot simply be assumed deployed. |
| **E18** | [Team Asana AGENTS.md](https://github.com/Agentic-AI-UIUC/voiceos-integrations/blob/1489b8e1a5b249328ace11674a65b5c0756cd53d/integrations/asana/AGENTS.md), **Files**, commit `1489b8e1a5b249328ace11674a65b5c0756cd53d`. | **O repository / D example instructions:** explicit fixed root-file Publish warning. This is the relevant team's generated example, not vendor publisher source; recursive inclusion must still be tested. Source ownership split can remain modular if runtime delivery is bundled. |
| **E19** | [Asana package.json](https://github.com/Agentic-AI-UIUC/voiceos-integrations/blob/1489b8e1a5b249328ace11674a65b5c0756cd53d/integrations/asana/package.json) and [run.sh](https://github.com/Agentic-AI-UIUC/voiceos-integrations/blob/1489b8e1a5b249328ace11674a65b5c0756cd53d/integrations/asana/run.sh), same commit. | **O:** example declares SDK/Zod/tsx ranges; launcher prefers `VOICEOS_BUN`, then local fallbacks/install behavior. Does not prove main VoiceOS repo Zod, publisher packaging, or this project's clean launch. |
| **E20** | [Official MCP v1 docs](https://ts.sdk.modelcontextprotocol.io/), **Installation** and maintenance notice; [SDK 1.32.2 npm metadata](https://registry.npmjs.org/@modelcontextprotocol/sdk/1.32.2), **engines**, **peerDependencies**; [matching repository package.json](https://github.com/modelcontextprotocol/typescript-sdk/blob/3b73021a0a2272c0c04c3917bcdb03398b3ec63f/package.json); [current v2 docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/index.md). | **D/O:** v1.32.2 supports Node ≥18 and Zod ^3.25 or ^4; v1 is maintenance, v2 current stable. Package compatibility does not prove VoiceOS host protocol/runtime compatibility. |
| **E21** | [Node 24 TypeScript documentation](https://nodejs.org/docs/latest-v24.x/api/typescript.html), **Type stripping**, **Determining module system**, **TypeScript features**; page version observed **24.22.2**. | **D:** erasable syntax support, stable from 24.12, no type-checking or tsconfig transformation. Local 24.22.1 observation is separate from the docs and target runtime. |
| **E22** | [Zod v3 implementation](https://github.com/colinhacks/zod/blob/50606616c0d291caf3210a7521da51271b918333/packages/zod/src/v3/types.ts), **ZodObject: _parse, strip, passthrough, create**, commit matching [3.25.76 package metadata](https://registry.npmjs.org/zod/3.25.76); [current object docs](https://zod.dev/api?id=objects), **Objects**. | **D/O source:** default unknown-key stripping and passthrough preservation verified directly in v3 source; v3 docs reader was unavailable. **O metadata:** stable v3.25.76 available; overall latest lookup returned 4.6.7. Our explicit projection/no-passthrough boundary is a proposed design, not built-in prompt-injection immunity. |
| **E23** | [DoorDash agentic offerings](https://developer.doordash.com/en-US/mcp/), **Limited beta / For individuals / For organizations**; [MCP get started](https://developer.doordash.com/en-US/docs/mcp/tutorials/get_started/); [Marketplace getting started](https://developer.doordash.com/en-US/docs/marketplace/faq/getting_started/), **Limited access**. [Candidate consumer checkout URL](https://www.doordash.com/consumer/checkout/). | **D first-party DoorDash:** limited-beta offerings and restricted Marketplace access; no project-specific partnership or consumer sandbox established. **U:** generic checkout URL authenticated behavior was not accessible, and no cookie/cart transfer guarantee was located. AgentWeb's parameter names/behavior are vendor-map claims, not DoorDash first-party API guarantees. |
| **E24** | Local read-only inspection on verification date: supplied PRD read end to end; `node --version` → `v24.22.1`; `uname -srm` → Linux x86_64; no VoiceOS executable found. Repository-access search did not expose the VoiceOS main app. Public [VoiceOS SDK registry lookup](https://registry.npmjs.org/@voiceos/integration-sdk/latest) returned 404; public AgentWeb health/map GETs in E01/E04 succeeded. | **O access limits:** no target desktop/key, installation, auth-dependent action sample, or commerce test was available. Registry unavailability is an observation, not a claim the SDK can never be obtained. Re-run the precise M0/live checks once authorized access exists. |

## 20. Unresolved decisions and concrete next verification

| Decision / gap | Owner | Concrete verification / decision required |
| --- | --- | --- |
| **Deadline: November 15 or three weeks** | Maks + all three | Confirm one date; if three weeks, name the start date. Reconcile the milestone gates and reviewer availability before promising completion. |
| **Live access and budget funding** | Maks supplies; Yue validates | Supply an existing funded key/evaluation allowance and authorized account scope; read actual usage/rate and reserve cleanup. No $25 top-up under the <$20 limit. |
| **Actual output shapes, currency, quantity merge behavior** | Yue with Rishabh/Pranav | Capture an authorized read envelope and one test-created quantity-2 add; identify currency and stable item/option-to-line mapping; freeze response fixtures. No quantity-success claim until verified. |
| **Nonempty modifier encoding** | Yue + Pranav; AgentWeb clarifies | Obtain a versioned `nested_options` example/schema and perform one bounded configured-item test. Until then disable modifier writes and safely refuse incomplete configurations. |
| **Multi-login mechanism and isolation** | **Yue, proposed investigation lead** | Compare separate credentials with documented org delegation, resolve REST/MCP and spending restrictions, then execute §12. If access is missing, retain a shared-account demo and record the blocked/inconclusive portions. |
| **Target host confirmation/cancellation and identity limits** | Rishabh; VoiceOS technical contact | Record app/runtime build and observed native yes/no/revision/stop behavior; establish supervised Asks first configuration or a supported mandatory mechanism. Verify no host identity/approval context is being assumed. |
| **Publish/share packaging and dependencies** | Rishabh; VoiceOS supplies access | Run M0 nested-file canary and clean recipient install; inspect actual files, launch/dependency/state behavior and bundle hash. Resolve the docs/changelog conflict with observed evidence. |
| **Checkout destination, account/cart match, open acknowledgement** | Rishabh + Yue; VoiceOS clarifies opener | Validate the candidate URL on authorized A/B browser sessions, compare actual cart, and identify a trusted host opening result. Otherwise label link handoff/manual verification; do not say “opened.” |
| **Cart-effect idempotency / settlement guarantees** | Yue; AgentWeb clarifies | Request execution deduplication scope/retention/concurrency semantics and a terminal-state check after timeouts. Keep no-auto-retry reconciliation policy unless evidence justifies a change. |

These gaps do not authorize inventing an API, broadening DoorDash scope, or marking planned tests as completed. They define exactly which advertised behaviors stay gated while implementation proceeds.
