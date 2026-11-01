# GitHub for VoiceOS (through Composio)

Eight GitHub actions for the VoiceOS voice agent, run through Composio with a
repo-scope OAuth connection. Every change is shown on a confirmation card first,
and the server refuses any change that arrives without that card's approval.

## Use it

1. VoiceOS → Integrations → GitHub → Configure → **Composio project API key**
   (composio.dev → Settings → Project Settings → API Keys). It must be a project
   key, not a `ck_` consumer key or a `uak_` user key. A full-access key works;
   the least a scoped key needs is Auth configs, Connected accounts and Session
   management (read and write) and Session tool execution (write).
2. Ask for something on GitHub. The first answer is a **Connect GitHub** card:
   click it, approve the `repo` scope in the browser, then ask again.
3. Keep **Ask before every action** on. With it off, VoiceOS skips the
   confirmation cards, so every change is refused and nothing is sent.
4. Send a change by clicking its card's button. Saying "yes" out loud doesn't
   send it: VoiceOS approves a card by voice without the card's staged values,
   so the approval never arrives. The agent then shows the card again once.

It works with every repository the connected GitHub account can reach, public
and private. Try "show all my PRs" or "show the open pull requests in
octocat's Hello-World". Your own repositories work by name alone, even as
speech recognition hears them ("break write" finds BrickWrite). For anyone
else's, say the owner the first time; after that, reads accept its name alone
until VoiceOS restarts. Two matches get a question back.

To disconnect, turn off **Use my GitHub connection**: VoiceOS stops using the
account right away and asks Composio to revoke and delete it, retrying until
Composio confirms. A disconnected account is never reused; connecting again
starts a new GitHub sign-in. To pause GitHub without disconnecting, switch the
integration off in VoiceOS.

## The eight actions

| Tool | Composio action | Kind |
| --- | --- | --- |
| `get_issue` | `GITHUB_GET_AN_ISSUE` | read |
| `list_pull_requests` | `GITHUB_LIST_PULL_REQUESTS` | read |
| `search_repositories` | `GITHUB_SEARCH_REPOSITORIES` | read |
| `search_code` | `GITHUB_SEARCH_CODE` | read |
| `create_issue` | `GITHUB_CREATE_AN_ISSUE` | change, confirmed |
| `update_issue` | `GITHUB_UPDATE_AN_ISSUE` | change, confirmed |
| `create_issue_comment` | `GITHUB_CREATE_AN_ISSUE_COMMENT` | change, confirmed |
| `create_pull_request_review` | `GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST` | change, confirmed |

Not available, by design: creating, merging or editing pull requests, reading
diffs or files, listing issues, and inline review comments.

## How it works

- **No error that the next answer replaces.** VoiceOS shows each result's
  card as it arrives, so a failed first try used to flash an error card before
  the agent's retry showed the right answer. Now a call the agent fixes itself,
  or a question it has to ask the user, comes back without a card, and the
  notch keeps what it shows. Something a read doesn't find (an issue, a PR
  number, a repository) is told by the agent the same way. Real failures (a
  refused change, a rate limit, a lost connection, an outage) still show
  theirs. The audit log marks a failure the user didn't see with
  `card: "none"`.
- **Names as heard.** VoiceOS can't be taught repository names, so "BrickWrite"
  can arrive as "break-write". When GitHub says a repository isn't there (for
  an issue, a one-row PR read checks that it's the repository, not the issue),
  it is matched once against its owner's real repositories (same letters, whole
  words, then near spellings and sound-alikes) and the read is retried before
  any error. Only a complete list (an owner with at most 300 repositories)
  read in the last two minutes can swap a name. Your own repositories need no
  owner: they and the ones used lately are one pool, so your exact name wins
  and two exact names are a question. An owner the user said is never swapped:
  a match under another owner goes back to the agent as a question. A code
  search scoped to a misheard repository (GitHub answers it with nothing found
  and incomplete results) is corrected the same way. Results carry
  `repository_requested` or `query_requested` when what ran differs from what
  was said.
- **All your pull requests.** `list_pull_requests` with no owner or repo lists
  the connected account's own open pull requests across the repositories it
  owns: it reads the account's repositories (the approved repository search,
  at most two minutes old), skips those with nothing open, lists the rest six
  at a time (up to 300 open PRs each), and returns the total, a count per
  repository and the newest first. Repositories it couldn't read, or not in
  time, are counted and said, never shown as having none. Pull requests the
  account opened in other owners' repositories aren't included, and the result
  says so. The list is kept a minute for the same question, and ten minutes
  for "more".
- **"More" is the next rows on the card.** A page of pull requests is what
  the card shows: three. Its result holds those three, in the card's order,
  with counts for the whole list (`total`, or `total_at_least` until the end
  has been read; who opened them, or how many in each repository). "More" is
  the next page, so it shows rows 4 to 6, never row 21 or an empty page 2.
  One repository's PRs are read from GitHub 20 at a time as the pages reach
  them ("17+ more" until the end is known), and a later page continues the
  list its first page read, for ten minutes; a new question reads it again.
  A page past the end comes back without a card, so the notch keeps the last
  rows instead of flashing "No more" before the agent's next call replaces
  it; searches do the same. Every page asks for its own summary under its
  rows.
- **Search follows the card.** Repository and code searches default to five
  results. Only the displayed rows reach the model, in the same order; counts
  still describe the whole search. A `next` call carries an opaque continuation
  that keeps the owner, language, visibility, fork intent, sort and displayed
  position together. Even a larger fetched page is consumed five rows at a
  time before advancing upstream. Continuations expire after ten minutes or a
  server restart, and are scoped to their original account and tool.
- **Pull request cards lead with state.** One PR looked up by number shows an
  Open, Draft, Merged or Closed pill and who has been asked to review it; its row
  links to the PR. List rows carry the same tags (an open-only list leaves plain
  open rows untagged). Each PR's data carries `status` and `html_url`. Approvals
  and change requests aren't shown: GitHub returns them only through a reviews
  action outside the eight, so a single-PR result says `review_state:
  "not_available"` and tells the agent never to claim either. The summary
  under a PR card is the agent's own text, sent back through
  `list_pull_requests`; the integration makes no model calls. It only adds to
  the card: a list shows the same three rows before and after it arrives.
  `author` takes a bot by its name ("dependabot" is `dependabot[bot]`).
- **Code is evidence, when supplied.** The integration retains up to four
  actual content excerpts per file, including implementation matches after an
  import, and tells the model which files lack excerpts. It cannot fetch full
  files. An implementation question uses `intent: "explain"`; descriptions and
  results require it to stop when source context is missing, and the server
  permits at most one refinement per repository in thirty seconds. Identical
  code searches share a thirty-second cache. Indexing can miss default-branch
  files, especially in forks, so an empty search never proves absence.
- **Filters and dates stay explicit.** `include_forks: true` adds `fork:true`
  to repository searches; public and private results remain eligible unless
  visibility was restricted. `updated_at` and `pushed_at` keep their distinct
  GitHub meanings. Unsupported REST search syntax is identified as local
  validation, before any GitHub request.
- **Plain results.** Agent Mode is the agent: it picks the tool, reads the
  result and writes the answer, so the integration returns facts, not prose.
  Issues and PRs come back as number, title, state, author and a short
  description excerpt (300 characters in a list, up to 1,500 for one item);
  every item carries its `html_url`; searches return the total and the top
  five; errors say what happened in plain words; changes return what was
  created or changed with its link. Cards link the same way everywhere: the
  item's own title is the link.
- **A fast first answer.** At start-up, and right after GitHub is approved in
  the browser, the server opens the Composio session for an account that's
  already connected, so the first question doesn't wait for five round trips.
  It never starts a sign-in or creates anything to do so.
- **One self-contained file.** `server.ts` bundles the MCP SDK and zod, so a
  teammate's install from the share link starts offline with nothing to
  download. The build switches off zod 4's code generation and the SDK's ajv
  validator, because VoiceOS's share review rejects code compiled from
  strings.
- **`src/` is the source.** `server.ts` is a self-contained bundle of it, and the
  manifest's tools, setup fields and detail page are generated from it, so the
  folder runs the way Integration Studio expects. Don't edit `server.ts` or the
  manifest's `tools` by hand.
- **Composio.** One tool-router session per connected account, with exactly the
  eight actions as direct tools: no tool search, multi-execute, workbench or
  proxy. The integration creates its own GitHub auth config that requests only
  `repo` (Composio's default asks for much more), and it refuses any auth config
  or account that asks for more than `repo` or `public_repo`. Network access is
  `backend.composio.dev` only.
- **Confirmation receipts.** Each write's confirmation card stages a
  `confirmation_receipt`: a SHA-256 digest of the exact arguments on screen
  (with a time and a nonce), re-minted on every edit. It holds no secret,
  because VoiceOS's share review rejects keys in the manifest. The server dispatches a
  write only with a valid receipt that is under 10 minutes old and unused. The
  receipt is spent only when the change is sent: a repeated delivery replays
  the first outcome instead of writing twice, and a change refused before
  sending is checked again from scratch. Honest limit: it stops the agent, which
  never sees the card's script, from approving its own change. Anyone who reads
  the manifest can compute one, because VoiceOS doesn't yet give integrations a
  host-signed approval.
- **Card edits.** VoiceOS carries at most 16,384 characters per edited field,
  so the cards stop there (titles at GitHub's 240). A longer description the
  agent proposes is shown read-only, to approve as written or have shortened.
- **Outcomes are never guessed.** A timeout or 5xx after a write was sent is
  reported as "Check GitHub before resubmitting", never retried automatically.
  A change that VoiceOS stopped waiting for, or that took over 30 seconds to
  prepare, is never sent afterwards.
- **Upstream schemas.** `UPSTREAM_SNAPSHOT` in `src/catalog.ts` records the
  eight Composio input schemas this build was reviewed against (catalog
  20261023_00). Each new session compares them and logs
  `upstream_schema_changed` in the audit log; a change that no longer fits
  what the integration sends makes that action unavailable.
- **Local state** lives in `.state/`: `state.json` (connection binding,
  operation ledger, spent receipts; mode 0600, no keys or tokens) and
  `audit.jsonl`. A lock file keeps it consistent when VoiceOS and an
  Integration Studio test run use the folder at the same time.

## Develop

```bash
bun install
bun run build    # src/ → server.ts, voiceos.integration.json, preview fixtures
bun test         # unit and acceptance tests against a fake Composio
bun run verify   # launches server.ts on VoiceOS's bundled Bun, as VoiceOS does, and calls every tool
bun verify.ts --package  # the shared files alone, empty folder and Bun cache: a teammate's first launch
```

`server.ts` is committed because VoiceOS runs it directly and a shared install
has no `node_modules`. It's marked as generated in `.gitattributes`, so review
`src/` instead.

Then reload the integration in VoiceOS (Integration Studio → My Integrations →
GitHub → Reload). VoiceOS also caches the manifest in `installedIntegrations`
in its `config.json`, so a restart alone can leave old descriptions and
argument schemas there.

Don't use **Edit with AI → Save** in Integration Studio on this integration: it
installs a fresh folder holding only `server.ts` and the manifest, and deletes
this one, including `src/`, `tests/` and `.state/`.

## What a folder can't change in VoiceOS

- Confirm button labels are fixed per tool ("Submit review"). The card's
  headline states the consequence instead ("Request changes on #55").
- Cards can't name the GitHub login before the first change.
- A spoken "yes" on a confirmation card doesn't carry the card's staged values
  (VoiceOS 0.1.40 sends them only on a click), so a change approved by voice
  arrives without its receipt and is refused; it would also lose any edit made
  on the card. The agent then shows the card again once. The fix belongs in VoiceOS: forward
  staged edits when a card is approved by voice.
- There are no host toasts, loading labels or a GitHub settings screen.
  Connecting happens on the card, and disconnecting happens in Configure.
