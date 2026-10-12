---
name: use-inbox
description: How to ask the owner a question or request the owner's approval through Operator Inbox, and how to read the answer.
---
# Asking the owner through Operator Inbox

{{agent.name}}, use Operator Inbox when you need a human decision or an answer only the owner can give.

## Ask
- Call `inbox__inbox_ask` with `title` (one line the owner reads in the list) and `kind`:
  - `approval`: the owner answers approve, deny or clarify.
  - `question`: the owner answers in words (answer) or asks you to clarify.
- Put the facts the owner needs in `context`: what you want to do, the options, and what happens next.
- Optional: `priority` (low, normal, high, urgent), `responses` (limit the allowed answers), `expiresInS` (default 7 days).
- Always send an idempotency key. If you repeat the call with the same key and the same input, you get the first item back, not a second one.
- Keep the returned `itemId`. Do not wait in a loop inside one turn; continue with other work.

## Read the answer
- Call `inbox__inbox_status` with the `itemId` on your next check.
- `status: open`: no answer yet. `seenByOwner: true` means the owner has looked at it.
- `status: answered`: act on `response` and read `message`.
  - `approve`: go ahead with exactly what you asked for.
  - `deny`: do not do it.
  - `answer`: the owner's answer is in `message`.
  - `clarify`: the owner needs more from you; the request is closed. Ask again with a new item that answers the owner's question.
- `status: unknown`: no such item of yours (wrong id). Treat it as no answer.
- `status: expired`: nobody answered in time. Never treat expired, unknown or a missing answer as approval. Ask again only if it still matters.

## Add information
- Call `inbox__inbox_reply` with `itemId` and `message` to add facts to an open item. An answer the owner gave on the older text is refused, so the owner always decides on your latest message.

If any call answers `held`, the owner must approve that call first. Poll `inbox__tb_hold_status` with the `holdId`, then repeat the same call.
