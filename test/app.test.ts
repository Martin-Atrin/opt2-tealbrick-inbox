// App-level tests: manifest + kit, the app boots on the SDK, and the handlers (as the SDK calls them) implement the
// decision loop, owner-only decisions, the holds overview feature check and the optional owner alert DM.
// Agent calls through a bridge (proofs, grants, idempotency, receipts) are covered by `pnpm conformance`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { manifestDigest, validateManifest } from "@opt2-tealbrick/manifest";
import { defineApp, type Json, startApp, type TbError } from "@opt2-tealbrick/miniapp-sdk";
import { MANIFEST_DIGEST, OP } from "#kit";
import { ALERTS_OFF, alertText, MAX_ATTEMPTS } from "../src/alerts.ts";
import { clock, definition, handlers, manifest } from "../src/app.ts";
import { holdsPendingDeclared, NOT_YET } from "../src/holds.ts";
import { AGENT, type CallApp, ctxFor, memoryDb, OTHER, OWNER, type Sent } from "./helpers.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}

const h = handlers as Record<string, { run(input: any, ctx: any): Promise<any> }>;
const code = (c: string) => (e: unknown) => (e as TbError).code === c;
const NPUB = `npub1${"q".repeat(58)}`;

test("manifest validates; agent ops and person ops are the brief's set", () => {
  const v = validateManifest(manifest);
  assert.equal(v.ok, true, v.ok ? "" : JSON.stringify(v.errors));
  const by = (aud: string) =>
    manifest.operations
      .filter((o) => o.audience === aud)
      .map((o) => o.id)
      .sort();
  assert.deepEqual(by("agent"), ["inbox_ask", "inbox_reply", "inbox_status"]);
  assert.deepEqual(by("person"), ["alerts_get", "alerts_set", "holds_overview", "item_ack", "item_decide", "item_get", "item_priority", "item_snooze", "items_list"]);
  const ask = manifest.operations.find((o) => o.id === "inbox_ask");
  assert.equal(ask?.idempotency, "required", "inbox_ask needs an idempotency key");
  assert.deepEqual(manifest.companions?.map((c) => [c.product, c.operations]), [["connect", ["buzz_dm", "channel_dm"]]]);
});

test("the generated kit matches the manifest and every operation has exactly one handler", () => {
  assert.equal(MANIFEST_DIGEST, manifestDigest(manifest), "kit is stale: run node --run kit");
  const ids = manifest.operations.map((o) => o.id).sort();
  assert.deepEqual(Object.values(OP).sort(), ids);
  assert.deepEqual(Object.keys(handlers).sort(), ids);
});

test("boots on the SDK (migrations applied), serves derived routes, refuses agent ops without a bridge", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${manifest.id}-test-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const local = { ...manifest, runtime: { ...manifest.runtime, port } };
  const running = await startApp(defineApp({ ...definition, manifest: local }), { TB_DATA_DIR: dir, TB_STANDALONE: "1", TB_LOG_LEVEL: "error" });
  try {
    const base = `http://127.0.0.1:${port}`;
    const health = (await (await fetch(`${base}/tb/v1/health`)).json()) as { status: string; manifestDigest: string };
    assert.equal(health.status, "ok");
    assert.equal(health.manifestDigest, manifestDigest(local));
    const openapi = (await (await fetch(`${base}/tb/v1/openapi.json`)).json()) as { paths: Record<string, unknown> };
    for (const op of manifest.operations) assert.ok(Object.keys(openapi.paths).some((p) => p.endsWith(`/${op.id}`)), `openapi lists ${op.id}`);
    const refused = await fetch(`${base}/tb/v1/ops/inbox_ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
    assert.equal(refused.status, 503);
  } finally {
    await running.stop();
  }
});

test("ACCEPTANCE (handlers): an agent asks → the owner answers → the agent reads the answer; a stale answer is refused", async () => {
  const db = memoryDb();
  const agent = ctxFor(db, AGENT);
  const me = ctxFor(db, OWNER);
  const asked = await h.inbox_ask.run({ kind: "approval", title: "Publish the release notes?", context: "Draft attached in the PR.", priority: "high" }, agent);
  assert.equal(asked.status, "open");

  const listed = await h.items_list.run({}, me);
  assert.deepEqual(
    listed.items.map((i: { id: string }) => i.id),
    [asked.itemId],
  );
  assert.equal(listed.counts.pending, 1);
  const opened = await h.item_get.run({ itemId: asked.itemId }, me);
  assert.equal(opened.context, "Draft attached in the PR.");

  // the agent adds a correction after the owner opened the item → the owner's answer on the old version is stale
  await h.inbox_reply.run({ itemId: asked.itemId, message: "Also tag v0.2.0." }, agent);
  await assert.rejects(h.item_decide.run({ itemId: asked.itemId, version: opened.version, response: "approve" }, me), code("stale_version"));
  assert.equal((await h.inbox_status.run({ itemId: asked.itemId }, agent)).status, "open");

  const fresh = await h.item_get.run({ itemId: asked.itemId }, me);
  await h.item_decide.run({ itemId: asked.itemId, version: fresh.version, response: "approve", message: "Yes, with the tag." }, me);
  const answer = await h.inbox_status.run({ itemId: asked.itemId }, agent);
  assert.deepEqual([answer.status, answer.response, answer.message, answer.seenByOwner], ["answered", "approve", "Yes, with the tag.", true]);

  // a second (duplicate) answer is refused; the agent still reads the first one
  await assert.rejects(h.item_decide.run({ itemId: asked.itemId, version: fresh.version + 1, response: "deny" }, me), code("already_decided"));
  assert.equal((await h.inbox_status.run({ itemId: asked.itemId }, agent)).response, "approve");
  // another agent cannot read it
  await assert.rejects(h.inbox_status.run({ itemId: asked.itemId }, ctxFor(db, OTHER)), code("item_not_found"));
});

test("expiry through the handlers: the lazy sweep closes the item; answering it is refused", async (t) => {
  const db = memoryDb();
  const real = clock.now;
  t.after(() => {
    clock.now = real;
  });
  let now = Date.parse("2026-10-12T10:00:00Z");
  clock.now = () => now;
  const asked = await h.inbox_ask.run({ kind: "question", title: "Lunch order?", expiresInS: 60 }, ctxFor(db, AGENT));
  now += 61_000;
  assert.equal((await h.items_list.run({}, ctxFor(db, OWNER))).items.length, 0);
  assert.equal((await h.inbox_status.run({ itemId: asked.itemId }, ctxFor(db, AGENT))).status, "expired");
  await assert.rejects(h.item_decide.run({ itemId: asked.itemId, version: 1, response: "answer", message: "pizza" }, ctxFor(db, OWNER)), code("item_expired"));
});

test("owner ops refuse a non-person caller (approver = owner only)", async () => {
  const db = memoryDb();
  const asked = await h.inbox_ask.run({ kind: "approval", title: "x" }, ctxFor(db, AGENT));
  for (const [id, input] of [
    ["item_decide", { itemId: asked.itemId, version: 1, response: "approve" }],
    ["items_list", {}],
    ["item_ack", { itemId: asked.itemId }],
    ["holds_overview", {}],
    ["alerts_set", ALERTS_OFF],
  ] as const)
    await assert.rejects(h[id].run(input, ctxFor(db, AGENT)), code("owner_only"), id);
});

test("holds_overview before spec 0.1.13: Inbox's own open items, the feature check off, a clear note", async () => {
  const db = memoryDb();
  const a = await h.inbox_ask.run({ kind: "approval", title: "Approve the plan" }, ctxFor(db, AGENT));
  await h.inbox_ask.run({ kind: "question", title: "Answered one" }, ctxFor(db, AGENT));
  const done = (await h.items_list.run({}, ctxFor(db, OWNER))).items.find((i: { title: string }) => i.title === "Answered one");
  await h.item_decide.run({ itemId: done.id, version: 1, response: "answer", message: "ok" }, ctxFor(db, OWNER));
  assert.equal(holdsPendingDeclared(manifest), false);
  assert.equal(holdsPendingDeclared({ companions: [{ product: "*" as never, operations: ["tb.holds_pending"], crud: ["read"], purpose: "x" }] }), true);
  const o = await h.holds_overview.run({}, ctxFor(db, OWNER));
  assert.equal(o.source, "inbox_only");
  assert.equal(o.unavailable, NOT_YET);
  assert.deepEqual(
    o.rows.map((r: { product: string; id: string; summary: string; decidePath: string }) => [r.product, r.id, r.summary, r.decidePath]),
    [["inbox", a.itemId, "Approve the plan", `/?item=${a.itemId}`]],
  );
});

function fakeConnect(script: (n: number, sent: Sent) => Json | Error): { callApp: CallApp; sent: Sent[] } {
  const sent: Sent[] = [];
  const callApp = (async (product: string, op: string, input: Json, opts?: { idempotencyKey?: string }) => {
    const s = { product, op, input, key: opts?.idempotencyKey };
    sent.push(s);
    const r = script(sent.length, s);
    if (r instanceof Error) throw r;
    return r;
  }) as CallApp;
  return { callApp, sent };
}

test("alerts: off by default (no companion call); settings validate and clear the other channel", async () => {
  const db = memoryDb();
  const { callApp, sent } = fakeConnect(() => ({ status: "ok", output: {} }));
  assert.deepEqual(await h.alerts_get.run({}, ctxFor(db, OWNER)), ALERTS_OFF);
  await h.inbox_ask.run({ kind: "approval", title: "x" }, ctxFor(db, AGENT, callApp));
  assert.equal(sent.length, 0);
  await assert.rejects(h.alerts_set.run({ dm: "buzz", buzzTo: "not-a-key", channelAccount: null, channelPerson: null }, ctxFor(db, OWNER)), code("alerts_invalid"));
  await assert.rejects(h.alerts_set.run({ dm: "channel", buzzTo: null, channelAccount: "acc_1", channelPerson: null }, ctxFor(db, OWNER)), code("alerts_invalid"));
  const set = await h.alerts_set.run({ dm: "buzz", buzzTo: NPUB, channelAccount: "acc_1", channelPerson: "@me" }, ctxFor(db, OWNER));
  assert.deepEqual(set, { dm: "buzz", buzzTo: NPUB, channelAccount: null, channelPerson: null });
});

test("alerts: a Buzz DM goes out through Connect with an idempotency key; the ask never fails because of it", async () => {
  const db = memoryDb();
  await h.alerts_set.run({ dm: "buzz", buzzTo: NPUB, channelAccount: null, channelPerson: null }, ctxFor(db, OWNER));
  const { callApp, sent } = fakeConnect(() => ({ status: "ok", output: {} }));
  const asked = await h.inbox_ask.run({ kind: "approval", title: "Ship it?", priority: "urgent" }, ctxFor(db, AGENT, callApp));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.product, "connect");
  assert.equal(sent[0]?.op, "buzz_dm");
  assert.deepEqual(sent[0]?.input, { to: NPUB, content: "Scout asks for your approval (urgent): Ship it?\nOpen Operator Inbox to answer." });
  assert.match(String(sent[0]?.key), /^inbox-alert-dlv_/);
  const d = (await h.item_get.run({ itemId: asked.itemId }, ctxFor(db, OWNER))).deliveries;
  assert.deepEqual(
    d.map((x: { channel: string; status: string; attempts: number }) => [x.channel, x.status, x.attempts]),
    [["buzz", "sent", 1]],
  );

  // a refusal (e.g. Connect not deployed, no sender identity) is recorded, the ask still succeeds, nothing retries
  const failing = fakeConnect(() => Object.assign(new Error("no sender"), { code: "no_sender_identity" }));
  const b = await h.inbox_ask.run({ kind: "question", title: "Q" }, ctxFor(db, AGENT, failing.callApp));
  assert.equal(b.status, "open");
  const fd = (await h.item_get.run({ itemId: b.itemId }, ctxFor(db, OWNER))).deliveries[0];
  assert.deepEqual([fd.status, fd.error], ["failed", "no_sender_identity"]);
});

test("alerts: a held send is repeated with the SAME input and key until Connect answers, then stops", async (t) => {
  const db = memoryDb();
  const real = clock.now;
  t.after(() => {
    clock.now = real;
  });
  let now = Date.parse("2026-10-12T10:00:00Z");
  clock.now = () => now;
  await h.alerts_set.run({ dm: "channel", buzzTo: null, channelAccount: "acc_owner", channelPerson: "U123" }, ctxFor(db, OWNER));
  const { callApp, sent } = fakeConnect((n): Json => (n < 3 ? { status: "held", holdId: "hld_1", expiresAt: "x" } : { status: "ok", output: {} }));
  const asked = await h.inbox_ask.run({ kind: "approval", title: "Hold me" }, ctxFor(db, AGENT, callApp));
  await h.inbox_status.run({ itemId: asked.itemId }, ctxFor(db, AGENT, callApp));
  assert.equal(sent.length, 1, "not due yet");
  now += 61_000;
  await h.inbox_status.run({ itemId: asked.itemId }, ctxFor(db, AGENT, callApp));
  now += 61_000;
  await h.items_list.run({}, ctxFor(db, OWNER, callApp));
  now += 61_000;
  await h.items_list.run({}, ctxFor(db, OWNER, callApp));
  assert.equal(sent.length, 3, "sent, held twice, then ok; no more after ok");
  assert.ok(sent.every((s) => s.op === "channel_dm" && s.key === sent[0]?.key && JSON.stringify(s.input) === JSON.stringify(sent[0]?.input)));
  assert.deepEqual(sent[0]?.input, { account: "acc_owner", person: "U123", text: alertText({ kind: "approval", priority: "normal", title: "Hold me", from: { name: "Scout" } } as never) });
  const d = (await h.item_get.run({ itemId: asked.itemId }, ctxFor(db, OWNER))).deliveries[0];
  assert.deepEqual([d.status, d.holdId, d.attempts], ["sent", "hld_1", 3]);
  assert.ok(MAX_ATTEMPTS >= 15, "keeps trying for at least a hold's default lifetime");
});
