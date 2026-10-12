// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, holds, idempotency, backups and status from it. This file registers exactly one handler per
// manifest operation id. Op ids and input/output types come from the kit `tb-gen kit` generates (`#kit`).
//
// Agent side: inbox_ask (create an item; idempotency is the SDK's: same key + same input → the first result,
// different input → 409), inbox_status (poll the answer), inbox_reply (add to an open item).
// Owner side (person session = the workspace owner only, SDK-API §5): list/get, decide, snooze, priority, ack,
// holds overview and the alert setting.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AppDefinition, defineApp, type HandlerSpec, type OpContext, type SdkAppDefinition, TbError } from "@opt2-tealbrick/miniapp-sdk";
import {
  type AlertsGetInput,
  type AlertsGetOutput,
  type AlertsSetInput,
  type AlertsSetOutput,
  type HoldsOverviewInput,
  type HoldsOverviewOutput,
  type InboxAskInput,
  type InboxAskOutput,
  type InboxReplyInput,
  type InboxReplyOutput,
  type InboxStatusInput,
  type InboxStatusOutput,
  type ItemAckInput,
  type ItemAckOutput,
  type ItemDecideInput,
  type ItemDecideOutput,
  type ItemGetInput,
  type ItemGetOutput,
  type ItemPriorityInput,
  type ItemPriorityOutput,
  type ItemSnoozeInput,
  type ItemSnoozeOutput,
  type ItemsListInput,
  type ItemsListOutput,
  OP,
  type OpId,
} from "#kit";
import { AlertsError, alertNewItem, readAlerts, retryDue, writeAlerts } from "./alerts.ts";
import { overview } from "./holds.ts";
import * as store from "./store.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Clock seam for tests. */
export const clock = { now: () => Date.now() };

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}

/** Every op starts with the lazy expiry sweep, so no handler ever reads an item past its time as open. */
function begin(ctx: OpContext): number {
  const now = clock.now();
  store.expireDue(ctx.db, now);
  return now;
}

/** Owner ops: only a person session reaches them (SDK); this guards the handler too (C84: approver = owner only). */
function owner(ctx: OpContext): string {
  if (ctx.caller.type !== "person") throw new TbError("owner_only", "Only the workspace owner can do this.", 403);
  return ctx.caller.id;
}

/** Retries due alert sends; an alert problem never fails the op that triggered the retry. */
async function retryAlerts(ctx: OpContext, now: number): Promise<void> {
  try {
    await retryDue(ctx.db, ctx.callApp, now);
  } catch (e) {
    ctx.log.warn("alert retry failed", { error: e instanceof Error ? e.message : "unknown" });
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const handlers = {
  [OP.inboxAsk]: op<InboxAskInput, InboxAskOutput>({
    redact: (input) => clip(`${input.kind}: ${input.title}`, 280),
    async run(input, ctx) {
      const now = begin(ctx);
      const item = store.ask(ctx.db, { type: ctx.caller.type, id: ctx.caller.id, name: ctx.caller.name }, input, now);
      try {
        await alertNewItem(ctx.db, ctx.callApp, item, now);
      } catch (e) {
        ctx.log.warn("alert failed", { item: item.id, error: e instanceof Error ? e.message : "unknown" });
      }
      return { itemId: item.id, status: item.status, expiresAt: item.expiresAt };
    },
  }),
  [OP.inboxStatus]: op<InboxStatusInput, InboxStatusOutput>({
    async run(input, ctx) {
      const now = begin(ctx);
      await retryAlerts(ctx, now);
      return store.status(ctx.db, ctx.caller.id, input.itemId);
    },
  }),
  [OP.inboxReply]: op<InboxReplyInput, InboxReplyOutput>({
    redact: (input) => clip(`reply to ${input.itemId}`, 280),
    async run(input, ctx) {
      const now = begin(ctx);
      return store.reply(ctx.db, ctx.caller.id, input.itemId, input.message, now);
    },
  }),
  [OP.itemsList]: op<ItemsListInput, ItemsListOutput>({
    async run(input, ctx) {
      owner(ctx);
      const now = begin(ctx);
      await retryAlerts(ctx, now);
      return store.list(ctx.db, input.view ?? "pending", input.limit ?? 50, Number(input.cursor ?? 0), now);
    },
  }),
  [OP.itemGet]: op<ItemGetInput, ItemGetOutput>({
    async run(input, ctx) {
      owner(ctx);
      return store.get(ctx.db, input.itemId, begin(ctx));
    },
  }),
  [OP.itemDecide]: op<ItemDecideInput, ItemDecideOutput>({
    async run(input, ctx) {
      const who = owner(ctx);
      return store.decide(ctx.db, input, who, begin(ctx));
    },
  }),
  [OP.itemSnooze]: op<ItemSnoozeInput, ItemSnoozeOutput>({
    async run(input, ctx) {
      owner(ctx);
      return store.snooze(ctx.db, input.itemId, input.until, begin(ctx));
    },
  }),
  [OP.itemPriority]: op<ItemPriorityInput, ItemPriorityOutput>({
    async run(input, ctx) {
      owner(ctx);
      return store.setPriority(ctx.db, input.itemId, input.priority, begin(ctx));
    },
  }),
  [OP.itemAck]: op<ItemAckInput, ItemAckOutput>({
    async run(input, ctx) {
      owner(ctx);
      return store.ack(ctx.db, input.itemId, begin(ctx));
    },
  }),
  [OP.holdsOverview]: op<HoldsOverviewInput, HoldsOverviewOutput>({
    async run(_input, ctx) {
      owner(ctx);
      const now = begin(ctx);
      return overview(manifest, store.openItems(ctx.db, now, 100), now);
    },
  }),
  [OP.alertsGet]: op<AlertsGetInput, AlertsGetOutput>({
    async run(_input, ctx) {
      owner(ctx);
      return readAlerts(ctx.db);
    },
  }),
  [OP.alertsSet]: op<AlertsSetInput, AlertsSetOutput>({
    async run(input, ctx) {
      owner(ctx);
      try {
        return writeAlerts(ctx.db, input);
      } catch (e) {
        if (e instanceof AlertsError) throw new TbError("alerts_invalid", e.message, 400);
        throw e;
      }
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

export const definition: SdkAppDefinition = { manifest, handlers, migrations: migrationsDir };

export const app = defineApp(definition);
