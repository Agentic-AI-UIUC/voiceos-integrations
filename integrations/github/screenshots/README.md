# Screenshots

The GitHub integration in the VoiceOS notch, captured on November 2, 2026 on a
MacBook Pro's built-in display (VoiceOS 0.1.40, integration 2.5.2, the
published build). Every prompt was typed into Agent Mode, which shows it at
the top of the notch, and every result came from the live GitHub account.
Nothing is mocked.

The changes ran in the private sandbox repository
`rishabhcli/voiceos-github-live-check`.

## Reads

<table>
<tr>
<td valign="top" width="50%">
<img src="01-get-issue.jpg" alt="Issue card for rishabhcli/QAgent #56, Testing VoiceOS: open, opened 7 days ago by rishabhcli, 0 comments, labeled enhancement" width="100%"><br>
<b>Look up an issue</b> · <code>get_issue</code><br>
Speech recognition heard “cue agent”. The integration found
<code>rishabhcli/QAgent</code> and shows the issue's state, author, comment
count and labels.
</td>
<td valign="top" width="50%">
<img src="02-pr-by-number.jpg" alt="Pull request card for rishabhcli/QAgent #55: open, by dependabot, with the agent's summary under it" width="100%"><br>
<b>One pull request by number</b> · <code>list_pull_requests</code><br>
PR #55 in QAgent with its state, author and last update. Agent Mode adds its
summary of the PR under the row.
</td>
</tr>
<tr>
<td valign="top">
<img src="03-open-prs-in-a-repo.jpg" alt="Open pull requests in rishabhcli/BrickWrite: three rows, 13 more, page 1" width="100%"><br>
<b>Open pull requests in a repository</b> · <code>list_pull_requests</code><br>
“brick write” resolves to <code>rishabhcli/BrickWrite</code>. The card shows
three pull requests at a time and how many more there are.
</td>
<td valign="top">
<img src="04-open-prs-next-page.jpg" alt="Page 2 of BrickWrite's open pull requests, 10 more, with the agent's note" width="100%"><br>
<b>The next page</b> · <code>list_pull_requests</code><br>
Saying “more” shows the next three on page 2, with the agent's note under
them.
</td>
</tr>
<tr>
<td valign="top">
<img src="05-all-my-open-prs.jpg" alt="Your open pull requests across repositories: three rows including a draft, 24 more, from 15 of your repositories" width="100%"><br>
<b>All of your open pull requests</b> · <code>list_pull_requests</code><br>
With no repository named, it lists your open pull requests across the
repositories you own: 27 from 15 repositories. Drafts are marked.
</td>
<td valign="top">
<img src="06-prs-in-someone-elses-repo.jpg" alt="Open pull requests in octocat/Hello-World: three rows, 17+ more" width="100%"><br>
<b>Someone else's repository</b> · <code>list_pull_requests</code><br>
Any repository the account can reach works once its owner is named, here
<code>octocat/Hello-World</code>.
</td>
</tr>
<tr>
<td valign="top">
<img src="07-closed-prs.jpg" alt="Closed pull requests in rishabhcli/QAgent: three rows marked Closed, 17+ more, with the agent's summary" width="100%"><br>
<b>Closed pull requests</b> · <code>list_pull_requests</code><br>
Closed pull requests in QAgent. The agent's summary notes that none of these
three was merged.
</td>
<td valign="top">
<img src="08-prs-by-author.jpg" alt="dependabot[bot]'s open pull requests in rishabhcli/BrickWrite: three rows, 11 more, from the 16 most recent" width="100%"><br>
<b>Pull requests by one author</b> · <code>list_pull_requests</code><br>
Dependabot's open pull requests in BrickWrite: 14 of the 16 that are open.
</td>
</tr>
<tr>
<td valign="top">
<img src="09-repos-by-stars.jpg" alt="Repository search user:rishabhcli sorted by stars: QAgent 4, FreeYT 3, ZooVision 2, ReFind 1, Navio 1" width="100%"><br>
<b>Your most starred repositories</b> · <code>search_repositories</code><br>
The card shows the query sent to GitHub's search
(<code>user:rishabhcli</code>), with the top five sorted by stars.
</td>
<td valign="top">
<img src="10-repos-by-language.jpg" alt="Repository search user:rishabhcli language:Python: five repositories, two marked Private" width="100%"><br>
<b>Repositories by language</b> · <code>search_repositories</code><br>
<code>language:Python</code> across your repositories, 20 matches. Private
ones carry a lock.
</td>
</tr>
<tr>
<td valign="top">
<img src="11-code-search.jpg" alt="Code search redactShareUrl repo:rishabhcli/BrickWrite: 10 files, first five listed" width="100%"><br>
<b>Search code</b> · <code>search_code</code><br>
“break write” resolves to BrickWrite again, and 10 files match
<code>redactShareUrl</code>. GitHub's search through Composio returned no
excerpts for these files, and the card says so.
</td>
<td valign="top">
<img src="12-pr-not-found.jpg" alt="Agent answer: Couldn't find pull request #999 in rishabhcli/QAgent. It may not exist, or your account may not have access." width="100%"><br>
<b>Nothing found</b> · <code>list_pull_requests</code><br>
A pull request that doesn't exist gets a plain answer and no error card, so
no card flashes up and gets replaced.
</td>
</tr>
</table>

## Changes

Every change shows a confirmation card first, and its fields can be edited
there. It goes to GitHub only when you click the card's button.

<table>
<tr>
<td valign="top" width="50%">
<img src="13-create-issue-card.jpg" alt="Confirmation card: New issue in rishabhcli/voiceos-github-live-check with title, description, labels and assignees fields and a Create issue button" width="100%"><br>
<b>Create an issue: the card</b> · <code>create_issue</code><br>
Title, description, labels and assignees, all editable before sending.
</td>
<td valign="top" width="50%">
<img src="14-create-issue-created.jpg" alt="Result card: Created rishabhcli/voiceos-github-live-check#19, open, Notch screenshot tour, opened just now" width="100%"><br>
<b>Created</b><br>
After the click: the new issue, #19.
</td>
</tr>
<tr>
<td valign="top">
<img src="15-add-label-card.jpg" alt="Confirmation card: Update issue #19, add the documentation label, Update issue button" width="100%"><br>
<b>Add a label: the card</b> · <code>update_issue</code><br>
“add the documentation label to it” follows on from the issue just created.
The card lists the change.
</td>
<td valign="top">
<img src="16-add-label-updated.jpg" alt="Result card: Updated #19, labels none to documentation" width="100%"><br>
<b>Label added</b><br>
The change shown as before › after.
</td>
</tr>
<tr>
<td valign="top">
<img src="17-close-issue-card.jpg" alt="Confirmation card: Close issue #19 as not planned, Update issue button" width="100%"><br>
<b>Close an issue: the card</b> · <code>update_issue</code><br>
Closing it as not planned.
</td>
<td valign="top">
<img src="18-close-issue-closed.jpg" alt="Result card: Closed #19, state Open to Closed (not planned)" width="100%"><br>
<b>Closed</b><br>
State: Open › Closed (not planned).
</td>
</tr>
<tr>
<td valign="top">
<img src="19-assign-card.jpg" alt="Confirmation card: Update issue #1, assign rishabhcli, Update issue button" width="100%"><br>
<b>Assign someone: the card</b> · <code>update_issue</code><br>
“assign issue 1 in the live check repo to me”.
</td>
<td valign="top">
<img src="20-assign-updated.jpg" alt="Result card: Updated #1, assignees none to rishabhcli" width="100%"><br>
<b>Assigned</b><br>
Assignees: none › rishabhcli. Unassigning works the same way.
</td>
</tr>
<tr>
<td valign="top">
<img src="21-comment-card.jpg" alt="Confirmation card: Comment on #1, Live check target, with the comment text and a Post comment button" width="100%"><br>
<b>Comment: the card</b> · <code>create_issue_comment</code><br>
The comment text is editable before posting.
</td>
<td valign="top">
<img src="22-comment-posted.jpg" alt="Result card: Comment posted on rishabhcli/voiceos-github-live-check#1, with the comment text" width="100%"><br>
<b>Posted</b><br>
After the click: the comment on issue #1.
</td>
</tr>
<tr>
<td valign="top">
<img src="23-spoken-yes-card-stays.jpg" alt="The comment confirmation card still waiting after the user said yes" width="100%"><br>
<b>Saying “yes” doesn't send it</b> · <code>create_issue_comment</code><br>
Taken after the reply “yes”: the card is still waiting and nothing was
posted. VoiceOS approves a card by voice without the card's values, so the
server refuses that approval.
</td>
<td valign="top">
<img src="24-spoken-yes-posted-after-click.jpg" alt="Result card: Comment posted on #1, approved by voice" width="100%"><br>
<b>Posted after the click</b><br>
Clicking Post comment sends it.
</td>
</tr>
<tr>
<td valign="top">
<img src="25-review-card.jpg" alt="Confirmation card: Post review comment on #2, commit fcacf24, Comment / Approve / Request changes, review text, Submit review button" width="100%"><br>
<b>Review a pull request: the card</b> · <code>create_pull_request_review</code><br>
Comment, Approve or Request changes, on the commit the card names.
</td>
<td valign="top">
<img src="26-review-posted.jpg" alt="Result card: Review comment posted on PR #2, commit fcacf24" width="100%"><br>
<b>Review posted</b><br>
The review comment on PR #2.
</td>
</tr>
<tr>
<td valign="top">
<img src="27-approve-own-pr-card.jpg" alt="Confirmation card: Approve PR #2 with Approve selected and a Submit review button" width="100%"><br>
<b>Approve your own pull request: the card</b> · <code>create_pull_request_review</code><br>
Approve is selected.
</td>
<td valign="top">
<img src="28-approve-own-pr-refused.jpg" alt="Error card: Can't review your own PR. GitHub doesn't allow approving or requesting changes on your own pull request." width="100%"><br>
<b>GitHub refuses</b><br>
GitHub doesn't allow approving your own pull request. A real failure like
this gets an error card.
</td>
</tr>
<tr>
<td valign="top">
<img src="29-cancel-card.jpg" alt="Confirmation card: Comment on #1 with the text this one gets cancelled" width="100%"><br>
<b>Cancel: the card</b> · <code>create_issue_comment</code><br>
A comment that won't be sent.
</td>
<td valign="top">
<img src="30-cancelled.jpg" alt="Agent answer: Cancelled." width="100%"><br>
<b>Cancelled</b><br>
Saying “cancel” closes the card. Nothing is sent.
</td>
</tr>
</table>
