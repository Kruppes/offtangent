---
name: email
version: 1.0.0
description: Rules for working a mailbox well — triaging unread mail, bulk-marking newsletters as read instead of reading them one by one, leaving important mail unread for the human, archiving instead of deleting, handling read-only accounts, checking for new mail on the heartbeat, and what to expect from the send allowlist/approval rules. Load this before any email work.
requires_toolsets: [email_list, email_read, email_mark_read, email_mark_unread]
---

# Email

You share the mailbox with a human. Every flag you set is visible to them, and every mail you read is a mail they may never see again as "new". Work like an assistant who tidies someone else's desk: reduce noise, never hide anything that matters.

## The tools

| Tool | Use it for |
|---|---|
| `email_list` | Metadata only (sender, subject, date, UID). Defaults to **unread** in `INBOX`. Always start here. |
| `email_folders` | Discover folder paths before moving anything. |
| `email_read` | One message, full body. **Marks it as read.** |
| `email_mark_read` / `email_mark_unread` | Batch flag changes by UID, no bodies loaded. |
| `email_move` | Archive/file messages. Needs the account's manage permission. |
| `email_delete` | Last resort. Needs the account's delete permission. |
| `email_download_attachment` | Pull an attachment into the workspace. |
| `email_send` | New mail or reply. Subject to allowlist + approval. |

Tools that an account isn't permitted to use are not registered at all — if `email_move` is missing, the account may not manage the mailbox.

## Triage loop

1. `email_list` (unread, `INBOX`) — metadata only. This is cheap; reading bodies is not.
2. Classify every entry **from sender + subject alone**:
   - **Noise** — newsletters, notifications, automated reports, marketing.
   - **FYI** — relevant, but no action from you or the human.
   - **Important** — needs a human decision, a reply, a deadline, money, or is from a person who matters.
   - **Unclear** — the subject genuinely doesn't say.
3. Only open **Unclear** and **Important** ones with `email_read`, and only when you actually need the body.
4. Report a short summary: what came in, what you handled, what is waiting for the human.

Never loop `email_read` over an inbox. Reading 40 mails to summarize them burns context and destroys the human's unread state.

## Bulk-mark noise as read

Newsletters and notifications get **one `email_mark_read` call with all their UIDs** — not one `email_read` each. You already know what a newsletter is from the sender and subject; the body adds nothing.

```
email_list(unread_only: true)      → 30 UIDs
email_mark_read(uids: [ …22 noise UIDs… ])   → one call
```

Say in your summary which senders you bulk-cleared, so the human can object.

## Leave important mail unread for the human

`email_read` silently marks a message read. If it turns out to be something the human should see themselves — a personal mail, an invoice, a decision, anything you're not fully handling — put it back:

```
email_mark_unread(uids: [1234])
```

Rule of thumb: **if you are not closing the loop yourself, leave it unread.** Unread is the human's inbox-zero signal; don't spend it on their behalf.

## Archive, don't delete

Prefer `email_move` to an `Archive` folder over `email_delete`. Deletion is irreversible and rarely what someone actually wants. Use `email_folders` first to learn the real folder path — folder names differ per provider (`Archive`, `Archiv`, `[Gmail]/All Mail`, …).

Only delete when the human explicitly asked to delete *those specific* messages. Obvious spam still gets archived or left alone unless told otherwise.

## Read-only accounts

An account may be configured without manage/delete/send permissions. Then:

- **Report, don't act.** Summarize what's in the mailbox and what you would do.
- Don't work around it — no "I'll just mark everything read instead of archiving". Flag changes are still writes to a shared mailbox; keep them minimal and mention them.
- If a task genuinely needs a permission the account lacks, say which one (`canManage`, `canDelete`, `canSend`) and let the human enable it in the email account settings.

Folder access can also be restricted: if a folder is rejected, it is not accessible for that account — don't probe alternatives, report it.

## Heartbeat usage

The heartbeat is the right place to check for new mail — it's interval-based, idempotent, and safe to no-op.

- Run `email_list` (unread, metadata only). Nothing new → do nothing, produce no output.
- Triage as above, bulk-clear the noise silently.
- **Only interrupt the human when something is actually important.** Use a task injection / notification for that, with a one-line reason ("Invoice from X due Friday", "Reply expected by Y"), and leave the mail unread.
- Never send mail from a heartbeat run unless the human set up exactly that.

Routine, quiet, and boring is the goal — a heartbeat that reports "no new important mail" every 30 minutes is a broken heartbeat.

## Sending

`email_send` is checked server-side against the account's allowlist before anything leaves:

- **Blocked** — the recipient isn't allowed. Don't retry, don't try a different address. Tell the human to add the recipient to the allowlist.
- **Pending approval** — the mail is queued for a human to approve. It sends itself once approved: **do not retry and do not re-send**. Just report that it's waiting.
- **Sent** — done. Every attempt (including blocked and pending ones) is recorded in the send log.

Other things to expect: the account signature is appended automatically (don't write your own), HTML may be stripped if the account disallows it, and replies need `reply_to_uid` so `In-Reply-To`/`References` keep the thread intact.

Draft in the human's voice, keep it short, and when in doubt about tone or commitment, show the draft before sending.

## Your own rules

This skill stays generic. Account-specific conventions — which senders are always noise, which folder is the archive, who to notify immediately, standing reply templates — belong in your own files/memories (e.g. the wiki or a note under `/data/memory/`), not here. Write them down the first time the human corrects you, and check them before your next triage run.
