# Cal.com verification — November 14, 2026 (Mac)

## Result
85 automated tests passed, 179 assertions. All seven tools were exercised live in the first sweep. The second sweep verified timezone conversion, conflict handling, new validation guards, and guarded booking changes. Windows was intentionally excluded.

## Live evidence
The first sweep created the QA event type and a booking, moved the booking, cancelled it, and verified no upcoming QA bookings remained. It also exercised reads, expanded details, external navigation, and invalid-email rejection.

After tightening validation, the second sweep:
- Queried availability on March 14 and November 7, 2027. Both returned no slots; these are empty-state/provider-query checks, not evidence of live bookings during DST transitions.
- Created 2026-11-18 00:30 +09:00 as November 17, 9:30 AM CST, correctly crossing the calendar date.
- Rejected a second booking at that occupied slot.
- Rejected an edited, offset-free 2027-03-14T02:30:00 before sending a reschedule write.
- Moved the booking using 16:00 UTC to 10:00 AM CST; the preflight booking lookup succeeded.
- Rejected 40 minutes against an explicitly selected 15-minute event type.
- Cancelled the test booking with the new preflight guard.
- Verified no upcoming bookings remain for the unique QA attendee. The QA event type remains available.

## Automated coverage (external HTTP simulated)
The suite calls actual MCP handlers through linked transports with deterministic HTTP fixtures. It does not invalidate live credentials or force real provider outages.
- All seven tool registrations; all booking status filters and attendee/limit mapping.
- Empty and malformed provider responses.
- Invalid emails, limits, fractional/out-of-range durations, and missing confirmation identity fields.
- ISO offset requirements, impossible dates, clock fields, leap years, +05:45 / +14:00 offsets, UTC conversion.
- Spring gap and both fall repeated-hour instants, plus distinct CST/CDT labels.
- Local-date filtering for 23-hour spring and 25-hour fall days, including midnight exclusion.
- Event-type resolution by ID/slug/title, exact duration matching, unknown IDs/slugs and missing lengths.
- Fresh booking verification before cancel/reschedule; wrong title/time/attendee/UID, cancelled and already-moved records block writes.
- Auth 401, revoked tokens, rate limiting, server failure, timeout, network failure, occupied slot.
- Uncertain writes report ambiguity and issue no automatic retry.
- Escaping, links, long/empty cards, and all four embedded confirmation date formatters.

## Fixes made
Strict explicit-offset/date validation, ordered valid availability ranges, exact duration validation for explicit links, no invented event-type metadata, required and verified booking identity, and honest uncertain-write handling. Confirmation date hints use strict validation as well.

## Limits
This is broad risk-based coverage, not every possible combination. Named-zone interpretation is performed by the voice agent; tools take explicit offsets. Concurrent external edits can race the preflight lookup because the provider does not expose an atomic compare-and-swap here. Recurring-series and seated/team workflows are not advertised or comprehensively tested. Windows, real credential expiry/outages, performance/load and all account-specific provider rules are not live-tested. Share-link publication remains pending.

## Commands
`bun install --frozen-lockfile`, `bun test`, and `bun build server.ts --target=bun` passed. Strict premium UI static audit reported zero findings.

## Source references
- [Cal.com booking lookup contract](https://cal.com/docs/api-reference/v2/bookings/get-a-booking), version 2026-02-25
- [NIST DST rules](https://www.nist.gov/pml/time-and-frequency-division/popular-links/daylight-saving-time-dst)

## Screenshots
Right-side-only recaptures of actual VoiceOS screenshots. Images 01–16 are the initial live sweep; 17 onward document expanded checks. No synthetic result cards are presented as live evidence.

## Studio refresh limitation
The installed server passed the missing-offset and duration guards. VoiceOS Studio
continued displaying its cached, older confirmation date hint after server restart
and editor reopen. A manifest-only Studio rebuild then failed with “Integration
generation is not available right now.” The corrected embedded formatters in this
PR pass automated tests, but their deployment to Studio's cached UI still needs
verification when that service recovers. No booking was approved in the final
confirmation-only check.

The corrected manifest was also rendered in a browser at 388px width; the invalid
input displayed the expected correction hint. Its screenshot is labelled as a local
render check, separate from the live Studio evidence.
