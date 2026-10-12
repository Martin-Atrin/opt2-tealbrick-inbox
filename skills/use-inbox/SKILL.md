---
name: use-inbox
description: How to list and add items in Operator Inbox.
---
# Using Operator Inbox

{{agent.name}}, you can keep short items in collections.

- Call `inbox__items_list` to see the newest items. Pass `collection` to read one collection; leave it out to read every collection you may see.
- Call `inbox__item_create` with a `title` to add an item. Without `collection` it goes into your own collection.
- Always send an idempotency key with `item_create`; repeating a call with the same key returns the first result.
- If a call answers `held`, the owner must approve it. Poll `inbox__tb_hold_status` with the `holdId`, then repeat the same call.
