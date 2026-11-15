# Cal.com for VoiceOS

Manage bookings, booking links (event types), and availability through Composio.

## Setup

Connect the Cal toolkit in your Composio account at https://platform.composio.dev.
In VoiceOS, supply your Composio API key in the integration setup. The connected
account ID and Composio user ID are optional when automatic detection succeeds.
Use the explicit account ID when your workspace has multiple Cal connections.
`.env.example` documents the supported fields; VoiceOS injects preferences as
environment variables. A standalone `.env` file is not required.

## Tools

- `get_bookings`: upcoming, past, or cancelled meetings; optional attendee filter.
- `create_booking`: book a meeting for an attendee after confirmation.
- `cancel_booking`: cancel a booking by UID after confirmation.
- `reschedule_booking`: move a booking after confirmation.
- `get_event_types`: list booking links and their durations.
- `get_availability`: find available slots for an event type and date range.
- `create_event_type`: create a booking link after confirmation.

Meeting and event-type rows expand to show full details. Event-type buttons open
that event type's Cal.com settings. Meeting buttons open Cal.com's bookings page;
the destination can require sign-in or completed account onboarding.

## Development and verification

```sh
bun install --frozen-lockfile
bun test
bun server.ts
```

Mac and Windows launchers are included. Live UI verification was performed on Mac;
Windows execution has not yet been verified. The 85 automated tests (179 assertions) cover real MCP handlers with mocked HTTP,
strict dates and offsets, both DST boundaries, 23/25-hour availability days,
MCP input validation, booking-identity checks, provider/auth/network failures,
uncertain write outcomes, and card/confirmation rendering. These simulated cases
are separate from the live Mac evidence below.

Live Mac testing on November 14, 2026 exercised all seven tools: listing bookings
and event types, availability, creating an event type, and creating → rescheduling
→ cancelling a disposable QA booking. Fresh lookups verified the moved time and
that no upcoming QA booking remained after cancellation. Screenshots include each
write confirmation/result and an invalid-email provider error. The QA event type
`voiceos-qa-20261114` remains for reviewer testing. See [live test evidence](screenshots/README.md).

## Remaining review items

- Publish the integration and add its VoiceOS share link before submission.
- Complete Windows QA.
- Confirmation widgets currently use the existing widget format rather than
  native cards with Cancel buttons.

## Validation and timezone behavior

- Booking timestamps require ISO 8601 with `Z` or an explicit UTC offset.
  Offset-free dates, impossible calendar dates, and invalid times are rejected.
- Explicit offsets identify instants; the cards display the Mac's local timezone.
  Both fall-back occurrences remain distinct. Named-zone wall-time input is not
  a tool parameter: the voice agent must resolve the intended offset.
- Event type IDs/slugs must exist in the accessible list and match the requested
  duration. Unknown numeric IDs no longer invent a default duration.
- Cancel/reschedule require the exact title and current start from `get_bookings`.
  The server fetches the UID again and rejects changed/mismatched, cancelled, or
  already-moved bookings before writing. This is a preflight check, not an atomic
  provider-side compare-and-swap; concurrent external edits remain possible.
- `bun syncConfirmationDates.ts` regenerates embedded date hints from the server
  validator. Run it after changing date validation.

The expanded live sweep verified Tokyo → Chicago date rollover, occupied-slot
rejection, missing-offset rejection, explicit-link duration mismatch rejection,
UTC rescheduling, guarded cancellation, and an empty upcoming QA lookup. Live DST
Sunday availability queries returned no slots; exact DST-hour behavior is covered
by automated tests, not by successful live bookings during those hours.

The corrected manifest date hint still needs a successful Studio refresh: its
rebuild service was unavailable during the final live UI check. Server validation
is active and was verified live. See TESTING.md for the exact distinction.
