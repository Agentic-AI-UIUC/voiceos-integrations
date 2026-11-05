# DoorDash integration documentation

Ticket: **VOS-1489**. Team: Yue, Pranav, Rishabh.

## PRD

[DoorDash for VoiceOS via AgentWeb](./PRD_DOORDASH_UPDATED.md) is the updated PRD posted in the DoorDash Integration thread on November 3, 2026. This copy is unchanged from that attachment.

This folder records the design for review. It does not contain a working integration or evidence that the planned live acceptance tests have passed. Future implementation belongs in `integrations/doordash/`.

## Scope and open decisions

The PRD proposes 12 DoorDash actions for restaurant browsing, cart editing, priced checkout summaries, and read-only account/address/order information. Order placement, payment, and default-address changes are excluded.

The testing budget remains below $20. The deadline, live access, modifier behavior, account isolation, published-install behavior, and browser checkout binding remain open or gated as described in PRD sections 14 and 20.

## Review and implementation sequence

Keep this PR docs-only. The milestone boundaries in PRD section 14 provide the proposed slices for later implementation PRs:

1. **M0:** fixture skeleton, runtime packaging, and clean share-link installation proof.
2. **M1:** AgentWeb client, shared contracts, identity boundary, 12-action registration, and offline fixtures/tests.
3. **M2:** P0 restaurant/menu/item browsing.
4. **M3:** P1 cart operations, confirmation, reconciliation, quantity gates, and checkout handoff.
5. **M4:** multi-login investigation and optional P2 account/address/order reads.
6. **M5:** installed demo, live evidence, cleanup, and handoff.

Use focused PRs and link the relevant PRD sections and predecessor PRs. These are review boundaries, not claims that every slice must depend on every previous slice. Keep deferred features and stretch goals out of the core implementation diff.

### Native GitHub stacking

[GitHub stacked PRs](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs) require every branch in a stack to be in the same repository; cross-fork stacks are not supported. This documentation contribution follows the repository's existing fork-to-main workflow and is therefore a standalone PR, not a native stack.

For a native implementation stack in the main repository, maintainers need to establish same-repository branches. The bottom PR targets `main`; each dependent PR targets the previous PR's branch. If implementation stays fork-based, use separate upstream PRs with explicit dependency links instead of claiming native stack support.
