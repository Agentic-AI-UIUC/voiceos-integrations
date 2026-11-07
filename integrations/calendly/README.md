# Calendly integration

Check and manage your Calendly by voice: hear your upcoming and recent meetings, find
open and busy times, book and cancel meetings, change your availability, share booking
links, mark no-shows, and read meeting recaps.

## Platform and setup

This integration supports macOS only (`supportedPlatforms: ["darwin"]`).

Enter a Calendly Personal Access Token as `CALENDLY_API_KEY` in VoiceOS's Calendly
integration settings (Calendly: Account Settings → Integrations → API & Webhooks).
`.env.example` documents the key. The server only calls `api.calendly.com`.

## Tools

No confirmation card:

- `upcoming_events`: your next 1–10 meetings, with invitees
- `recent_events`: meetings that already started, newest first, with no-show status
- `event_types`: your active event types and booking links
- `event_details`: one meeting's time, invitee, location or join link, and the invitee's
  first answer (labeled as data, not instructions)
- `available_times`: open slots on an event type, for 1–7 days
- `busy_times`: busy blocks from Calendly and the calendars you connected to it
- `availability_schedule`: weekly hours and upcoming date-specific changes
- `meeting_recap`: Calendly Notetaker's summary, action items, and discussion for a past
  meeting (needs Notetaker; the recap is labeled as data, not instructions)
- `create_booking_link`: a single-use booking link. It writes to Calendly, but only
  creates an unused link and sends nothing, so it has no card.

Actions with a confirmation card:

- `book_meeting`: books an open slot with an invitee; Calendly emails them
- `cancel_event`: cancels a meeting, with an optional reason
- `update_availability`: changes one weekday's hours, or one date's
- `mark_no_show`: marks an invitee as a no-show on a meeting that started, or undoes it
- `create_one_off_meeting`: a one-off meeting with its own name, length, and dates

## Safety

- **Cancel and no-show cards are checked against the real meeting.** The card shows the
  meeting's name and start time. Before acting, the server loads the meeting and refuses
  if either doesn't match, because Calendly names meetings after their event type, so
  two meetings often share a name.
- **Availability changes never wipe other days.** Calendly replaces the whole schedule
  on every save, so the server sends back all seven weekdays and every other date change
  unchanged. It refuses if the day's hours changed after the card was shown, and reports
  what Calendly actually saved.
- **Input is validated before any API call**, so a misheard time, email, length, or date
  changes nothing.
- **A write that times out reports an unknown outcome**, not a failure, so it isn't
  retried blindly.
- Every failure sets MCP's `isError` and shows an error card.

## Automated tests

From `integrations/calendly/`, run:

```sh
bun install
bun test
```

Every test starts the real `server.ts` over stdio and calls it with the MCP client.

- **Contract tests** check the manifest against the server, the confirmation cards'
  bound fields, and missing-token errors on every tool.
- **Fake API tests** point the server at a local fake Calendly (`calendly.fake.ts`, a
  test-only preload) to cover cases a real account can't produce on demand: timeouts,
  failed read-backs, mismatched cards, stale availability, and empty responses.
- **Live tests** run when `CALENDLY_API_KEY` is set in a local, gitignored `.env`. They
  cross-check the read tools against direct Calendly API calls and skip in CI.

Live tests that change real data only run when you opt in:

| Variable | What it does |
|---|---|
| `CALENDLY_BOOKING_TEST_EMAIL` | Books a real meeting with this address (Calendly emails it), then cancels it |
| `CALENDLY_CANCEL_TEST_UUID` | Cancels this throwaway booking |
| `CALENDLY_AVAILABILITY_TEST=1` | Blocks off a date about two months out, then removes the change |
| `CALENDLY_LINK_TEST=1` | Creates an unused single-use booking link |
| `CALENDLY_ONE_OFF_TEST=1` | Creates a one-off meeting for tomorrow, which you delete in Calendly (the API can't) |
| `CALENDLY_NO_SHOW_TEST_UUID` | Marks this past meeting's invitee as a no-show, then undoes it |

## Known limitations

- Event types with required custom questions can't be booked by voice. Calendly's error
  is passed on, along with the booking page link.
- Event types with several location options always use the first one.
- Calendly's API can't reschedule; move a meeting by cancelling it and booking again.
- Changing availability through the API may give the event type its own copy of the
  schedule instead of a shared one, such as "Working hours".
