# Fresh live QA: Excel v5

Build: `excel-review-fixed-v5-collections`  
Toolkit: `20261029_00`; SDK: `@composio/core` 0.27.0  
VoiceOS share: https://api.voiceos.com/integration-share/09SN91amuePp/page

On November 1, 2026, Prerak confirmed successful live retesting after the v5
collection and delete-mapping fixes. In response to the explicit question about
testing all six writes and checking Excel, he confirmed: "Yes, I tested all the
6 write functions."

| Action | Result reported by tester |
| --- | --- |
| Create worksheet | Passed |
| Rename worksheet | Passed |
| Delete worksheet | Passed |
| Update cell range | Passed |
| Add table rows | Passed |
| Create chart | Passed |

This is the author's live-test attestation. It is distinct from the offline
fake-client tests. No new raw trace or timings accompanied the final confirmation;
do not represent earlier failing v4 logs as successful v5 evidence.

The server source was verified identical between the local PR checkout and the
current VoiceOS export `microsoft-excel-643af91a` before final documentation and
dependency-pin cleanup. That export had resolved SDK 0.27.0 installed but its
package manifest had reverted to `latest`; the exact pin and matching lockfile
were restored without changing the working server.

Separate coverage still needed: cancellation with no side effects, fresh share-link
installation, revoked/expired credentials, and native production account linking.
These are not claimed by the six successful action tests.
