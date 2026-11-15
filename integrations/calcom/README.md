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
Windows execution has not yet been verified. The tests cover disclosure rendering,
escaping, URL construction, long content, and empty states. They do not establish
end-to-end coverage of all Composio operations.

## Remaining review items

- Publish the integration and add its VoiceOS share link before submission.
- Complete Windows QA.
- An explicit event-type ID/slug bypasses the requested-duration match check.
- Cancel/reschedule use the booking UID without checking title/time against the
  confirmation's displayed details.
- Confirmation widgets currently use the existing widget format rather than
  native cards with Cancel buttons.
