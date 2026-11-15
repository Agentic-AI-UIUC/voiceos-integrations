---
version: alpha
name: Cal.com VoiceOS cards
description: Compact scheduling cards with expandable details in the VoiceOS notch.
colors:
  primary: "#292929"
typography:
  sans:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif'
components:
  disclosure: {}
---

# Cal.com VoiceOS cards

## Product context
VoiceOS users scan bookings and event types, expand a row for complete details,
and deliberately follow a Cal.com link. English copy and local-time formatting
follow the existing integration. This is a product surface, not a marketing page.

## Visual ownership
Existing widgetKit.ts owns theme tokens (--ink-1 through --ink-4, --fill-1,
--fill-2, --line), external-link routing, and automatic height measurement.
server.ts CARD_CSS owns established calendar tiles, 52px rows, system typography,
and monochrome accent #292929. This document mirrors those runtime owners.
server.ts extends those tokens for disclosure hover, focus, and full-text details.
Do not change the existing visual identity for this feature.

## Interaction and canonical owners
Shared detailRow in server.ts owns the native details/summary disclosure for
both meeting and event-type rows. Native keyboard activation, expansion state,
and focus remain browser-owned. Full API text is escaped and wraps in details.
The shared card() wrapper bounds disclosure cards to 330px with an operable scrollbar.
The host's widgetKit bridge owns HTTPS navigation and resize messages.
Cal.com event-type links use positive numeric IDs; invalid IDs fall back to the
Event Types page. Meeting links deliberately open the authenticated Bookings page,
not an invented or bearer-token URL. Opening details never mutates bookings.

## Verification
cardDetails.test.ts covers escaping, complete long text, and URL construction.
Use VoiceOS to verify expansion, collapse, keyboard focus, scrolling, and external
navigation. Compare unchanged empty/error/availability cards for consistency.
