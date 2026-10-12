// Inbox domain over the app's own tables (migrations/0001_init.sql). Plain functions over the SDK's Db with an
// explicit `now`, so handlers stay thin and tests drive them directly. Every state change is one transaction and is
// guarded in SQL (`WHERE status = 'open' …`, changes === 1): a duplicate, stale or expired answer fails closed.
import { ulid } from "@opt2-tealbrick/manifest";
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";

export const KINDS = ["approval", "question"] as const;
export const RESPONSES = ["approve", "deny", "answer", "clarify"] as const;
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Kind = (typeof KINDS)[number];
export type Response = (typeof RESPONSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Status = "open" | "answered" | "expired";

/** Allowed answers per kind; the first list is also the default. */
export const KIND_RESPONSES: Record<Kind, readonly Response[]> = {
  approval: ["approve", "deny", "clarify"],
  question: ["answer", "clarify"],
};
/** These answers carry the owner's words; without a message they are refused. */
export const NEEDS_MESSAGE: ReadonlySet<Response> = new Set(["answer", "clarify"]);

export const DEFAULT_EXPIRY_S = 7 * 24 * 3600;
export const MAX_SNOOZE_MS = 30 * 24 * 3600 * 1000;
/** Open items one caller may have at a time (a looping agent must not flood the owner). */
export const MAX_OPEN_PER_CALLER = 100;

export interface From {
  type: "agent" | "app" | "person";
  id: string;
  name: string;
}

export interface ItemSummary {
  id: string;
  kind: Kind;
  title: string;
  from: From;
  status: Status;
  priority: Priority;
  acked: boolean;
  snoozedUntil: string | null;
  response: Response | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface Message {
  id: string;
  author: "agent" | "owner";
  body: string;
  createdAt: string;
}

export interface Decision {
  response: Response;
  message: string | null;
  decidedBy: string;
  decidedAt: string;
}

export interface DeliveryView {
  id: string;
  channel: "buzz" | "channel";
  status: "pending" | "sent" | "held" | "failed";
  holdId: string | null;
  error: string | null;
  attempts: number;
  updatedAt: string;
}

export interface ItemDetail extends ItemSummary {
  context: string | null;
  responses: Response[];
  messages: Message[];
  decision: Decision | null;
  deliveries: DeliveryView[];
}

type Row = Record<string, unknown>;
const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function notFound(): never {
  throw new TbError("item_not_found", "No such item.", 404);
}

function toSummary(r: Row, now: number): ItemSummary {
  const snoozed = r.snoozed_until === null || r.snoozed_until === undefined ? null : Number(r.snoozed_until);
  return {
    id: String(r.id),
    kind: r.kind as Kind,
    title: String(r.title),
    from: { type: r.from_type as From["type"], id: String(r.from_id), name: String(r.from_name) },
    status: r.status as Status,
    priority: r.priority as Priority,
    acked: r.acked_at !== null && r.acked_at !== undefined,
    // a passed snooze is no snooze: the item is pending again without a write
    snoozedUntil: r.status === "open" && snoozed !== null && snoozed > now ? iso(snoozed) : null,
    response: (str(r.response) as Response | null) ?? null,
    version: Number(r.version),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    expiresAt: iso(r.expires_at),
  };
}

const SELECT = `SELECT i.*, d.response AS response FROM inbox_items i LEFT JOIN inbox_decisions d ON d.item_id = i.id`;

function row(db: Db, id: string): Row | undefined {
  return db.prepare(`${SELECT} WHERE i.id = ?`).get(id);
}

/** Expires every open item whose time has passed (lazy sweep, run at the start of each op). */
export function expireDue(db: Db, now: number): number {
  return Number(db.prepare("UPDATE inbox_items SET status = 'expired', updated_at = ? WHERE status = 'open' AND expires_at <= ?").run(now, now).changes);
}

// ── agent side ──

export interface AskInput {
  kind: Kind;
  title: string;
  context?: string;
  responses?: Response[];
  priority?: Priority;
  expiresInS?: number;
}

export function ask(db: Db, from: From, input: AskInput, now: number): ItemSummary {
  const allowed = KIND_RESPONSES[input.kind];
  const responses = input.responses ?? [...allowed];
  const wrong = responses.filter((r) => !allowed.includes(r));
  if (wrong.length > 0)
    throw new TbError("response_not_allowed", `A ${input.kind} item allows only ${allowed.join(", ")}; not ${wrong.join(", ")}.`, 400);
  if (input.kind === "approval" && !responses.some((r) => r === "approve" || r === "deny"))
    throw new TbError("response_not_allowed", "An approval item must allow approve or deny.", 400);
  const open = Number(db.prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE from_id = ? AND status = 'open'").get(from.id)?.n ?? 0);
  if (open >= MAX_OPEN_PER_CALLER)
    throw new TbError("too_many_open_items", `You have ${open} open items. Wait for answers or let some expire before asking again.`, 429);
  const id = `itm_${ulid(now)}`;
  const expiresAt = now + (input.expiresInS ?? DEFAULT_EXPIRY_S) * 1000;
  db.prepare(
    `INSERT INTO inbox_items (id, kind, title, context, responses, from_type, from_id, from_name, status, priority, version, acked_at, snoozed_until, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, NULL, NULL, ?, ?, ?)`,
  ).run(id, input.kind, input.title, input.context ?? null, JSON.stringify(responses), from.type, from.id, from.name, input.priority ?? "normal", now, now, expiresAt);
  return toSummary(row(db, id) as Row, now);
}

/** An item as its creator sees it; another caller's item is "not found" (no existence leak). */
function ownRow(db: Db, callerId: string, itemId: string): Row {
  const r = row(db, itemId);
  if (!r || r.from_id !== callerId) notFound();
  return r;
}

export interface AgentStatus {
  itemId: string;
  kind: Kind | null;
  status: Status | "unknown";
  seenByOwner: boolean;
  response: Response | null;
  message: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
}

/** An unknown id, or another caller's item, reads as `unknown` (no existence leak; never an approval). */
export function status(db: Db, callerId: string, itemId: string): AgentStatus {
  const r = row(db, itemId);
  if (!r || r.from_id !== callerId)
    return { itemId, kind: null, status: "unknown", seenByOwner: false, response: null, message: null, decidedAt: null, expiresAt: null };
  const d = db.prepare("SELECT response, message, decided_at FROM inbox_decisions WHERE item_id = ?").get(itemId);
  return {
    itemId,
    kind: r.kind as Kind,
    status: r.status as Status,
    seenByOwner: r.acked_at !== null || d !== undefined,
    response: d ? (String(d.response) as Response) : null,
    message: d ? str(d.message) : null,
    decidedAt: d ? iso(d.decided_at) : null,
    expiresAt: iso(r.expires_at),
  };
}

export function reply(db: Db, callerId: string, itemId: string, body: string, now: number): { itemId: string; messageId: string } {
  return db.transaction(() => {
    const r = ownRow(db, callerId, itemId);
    if (r.status !== "open") throw new TbError("item_closed", `The item is ${r.status}; ask a new question instead.`, 409);
    // the version bump makes an answer the owner gave on the older text stale
    const changed = db.prepare("UPDATE inbox_items SET version = version + 1, updated_at = ? WHERE id = ? AND status = 'open'").run(now, itemId).changes;
    if (changed !== 1) throw new TbError("item_closed", "The item is no longer open.", 409);
    const messageId = `msg_${ulid(now)}`;
    db.prepare("INSERT INTO inbox_messages (id, item_id, author, author_id, body, created_at) VALUES (?, ?, 'agent', ?, ?, ?)").run(messageId, itemId, callerId, body, now);
    return { itemId, messageId };
  });
}

// ── owner side ──

export type View = "pending" | "snoozed" | "done" | "all";

const RANK = "CASE i.priority WHEN 'urgent' THEN 3 WHEN 'high' THEN 2 WHEN 'normal' THEN 1 ELSE 0 END";
const VIEWS: Record<View, { where: string; order: string; withNow: boolean }> = {
  pending: { where: "i.status = 'open' AND (i.snoozed_until IS NULL OR i.snoozed_until <= ?)", order: `${RANK} DESC, i.created_at ASC, i.id ASC`, withNow: true },
  snoozed: { where: "i.status = 'open' AND i.snoozed_until > ?", order: "i.snoozed_until ASC, i.id ASC", withNow: true },
  done: { where: "i.status <> 'open'", order: "i.updated_at DESC, i.id DESC", withNow: false },
  all: { where: "1 = 1", order: "i.created_at DESC, i.id DESC", withNow: false },
};

export function list(db: Db, view: View, limit: number, offset: number, now: number): { items: ItemSummary[]; nextCursor: string | null; counts: { pending: number; snoozed: number } } {
  const v = VIEWS[view];
  const params: unknown[] = v.withNow ? [now] : [];
  const rows = db.prepare(`${SELECT} WHERE ${v.where} ORDER BY ${v.order} LIMIT ? OFFSET ?`).all(...params, limit + 1, offset);
  const more = rows.length > limit;
  const c = db
    .prepare(
      `SELECT SUM(CASE WHEN snoozed_until IS NULL OR snoozed_until <= ? THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN snoozed_until > ? THEN 1 ELSE 0 END) AS snoozed
       FROM inbox_items WHERE status = 'open'`,
    )
    .get(now, now);
  return {
    items: rows.slice(0, limit).map((r) => toSummary(r, now)),
    nextCursor: more ? String(offset + limit) : null,
    counts: { pending: Number(c?.pending ?? 0), snoozed: Number(c?.snoozed ?? 0) },
  };
}

/** Open items, pending first (as the owner's list orders them), for the holds overview. */
export function openItems(db: Db, now: number, limit: number): ItemSummary[] {
  return db
    .prepare(`${SELECT} WHERE i.status = 'open' ORDER BY (i.snoozed_until IS NOT NULL AND i.snoozed_until > ?) ASC, ${RANK} DESC, i.created_at ASC LIMIT ?`)
    .all(now, limit)
    .map((r) => toSummary(r, now));
}

export function get(db: Db, itemId: string, now: number): ItemDetail {
  const r = row(db, itemId);
  if (!r) notFound();
  const messages = db
    .prepare("SELECT id, author, body, created_at FROM inbox_messages WHERE item_id = ? ORDER BY created_at ASC, id ASC")
    .all(itemId)
    .map((m) => ({ id: String(m.id), author: m.author as Message["author"], body: String(m.body), createdAt: iso(m.created_at) }));
  const d = db.prepare("SELECT response, message, decided_by, decided_at FROM inbox_decisions WHERE item_id = ?").get(itemId);
  const deliveries = db
    .prepare("SELECT id, channel, status, hold_id, error, attempts, updated_at FROM inbox_deliveries WHERE item_id = ? ORDER BY created_at ASC, id ASC")
    .all(itemId)
    .map((x) => ({
      id: String(x.id),
      channel: x.channel as DeliveryView["channel"],
      status: x.status as DeliveryView["status"],
      holdId: str(x.hold_id),
      error: str(x.error),
      attempts: Number(x.attempts),
      updatedAt: iso(x.updated_at),
    }));
  return {
    ...toSummary(r, now),
    context: str(r.context),
    responses: JSON.parse(String(r.responses)) as Response[],
    messages,
    decision: d ? { response: String(d.response) as Response, message: str(d.message), decidedBy: String(d.decided_by), decidedAt: iso(d.decided_at) } : null,
    deliveries,
  };
}

export interface DecideInput {
  itemId: string;
  version: number;
  response: Response;
  message?: string;
}

/**
 * The owner's answer. Fails closed, in this order: unknown item (404), expired (409 item_expired), already answered
 * (409 already_decided), the owner saw an older version (409 stale_version), a response the item does not allow
 * (409 response_not_allowed), answer/clarify without words (400 message_required). One transaction; the guarded
 * UPDATE (status open + same version) is the real duplicate guard.
 */
export function decide(db: Db, input: DecideInput, decidedBy: string, now: number): { itemId: string; status: Status; response: Response; decidedAt: string } {
  return db.transaction(() => {
    const r = row(db, input.itemId);
    if (!r) notFound();
    // (the lazy sweep at the start of each op writes the expiry; here only the check, so a rollback loses nothing)
    if (r.status === "expired" || (r.status === "open" && Number(r.expires_at) <= now)) throw new TbError("item_expired", "The item expired before it was answered. The agent must ask again.", 409);
    if (r.status !== "open") throw new TbError("already_decided", `The item was already answered (${String(r.response)}).`, 409);
    if (Number(r.version) !== input.version)
      throw new TbError("stale_version", "The agent added to this item after you opened it. Read the new message, then answer again.", 409, { version: Number(r.version) });
    const allowed = JSON.parse(String(r.responses)) as Response[];
    if (!allowed.includes(input.response))
      throw new TbError("response_not_allowed", `This item allows only ${allowed.join(", ")}.`, 409);
    const message = input.message?.trim() ? input.message.trim() : null;
    if (NEEDS_MESSAGE.has(input.response) && !message) throw new TbError("message_required", `"${input.response}" needs a message for the agent.`, 400);
    const changed = db
      .prepare("UPDATE inbox_items SET status = 'answered', version = version + 1, updated_at = ?, snoozed_until = NULL WHERE id = ? AND status = 'open' AND version = ?")
      .run(now, input.itemId, input.version).changes;
    if (changed !== 1) throw new TbError("already_decided", "The item changed while you answered. Reload it.", 409);
    db.prepare("INSERT INTO inbox_decisions (id, item_id, response, message, decided_by, decided_at, item_version) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      `dcs_${ulid(now)}`,
      input.itemId,
      input.response,
      message,
      decidedBy,
      now,
      input.version,
    );
    if (message)
      db.prepare("INSERT INTO inbox_messages (id, item_id, author, author_id, body, created_at) VALUES (?, ?, 'owner', ?, ?, ?)").run(`msg_${ulid(now)}`, input.itemId, decidedBy, message, now);
    return { itemId: input.itemId, status: "answered" as const, response: input.response, decidedAt: iso(now) };
  });
}

/** Triage changes on OPEN items only (a closed item never re-opens or changes). */
function triage(db: Db, itemId: string, set: string, params: unknown[], now: number): ItemSummary {
  const changed = db.prepare(`UPDATE inbox_items SET ${set}, updated_at = ? WHERE id = ? AND status = 'open' AND expires_at > ?`).run(...params, now, itemId, now).changes;
  if (changed !== 1) {
    const r = row(db, itemId);
    if (!r) notFound();
    throw new TbError("item_closed", `The item is ${r.status === "open" ? "expired" : String(r.status)}.`, 409);
  }
  return toSummary(row(db, itemId) as Row, now);
}

export function ack(db: Db, itemId: string, now: number): ItemSummary {
  return triage(db, itemId, "acked_at = COALESCE(acked_at, ?)", [now], now);
}

export function setPriority(db: Db, itemId: string, priority: Priority, now: number): ItemSummary {
  return triage(db, itemId, "priority = ?", [priority], now);
}

export function snooze(db: Db, itemId: string, until: string | null, now: number): ItemSummary {
  if (until === null) return triage(db, itemId, "snoozed_until = NULL", [], now);
  const t = Date.parse(until);
  if (!Number.isFinite(t) || !/^\d{4}-\d{2}-\d{2}T/.test(until)) throw new TbError("until_invalid", "until must be an ISO 8601 date and time.", 400);
  if (t <= now) throw new TbError("until_invalid", "until must be in the future.", 400);
  if (t - now > MAX_SNOOZE_MS) throw new TbError("until_invalid", "Snooze for at most 30 days.", 400);
  return triage(db, itemId, "snoozed_until = ?", [t], now);
}

// ── settings ──

export function readSetting<T>(db: Db, key: string, fallback: T): T {
  const r = db.prepare("SELECT value FROM inbox_settings WHERE key = ?").get(key);
  return r ? (JSON.parse(String(r.value)) as T) : fallback;
}

export function writeSetting(db: Db, key: string, value: unknown): void {
  db.prepare("INSERT INTO inbox_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

/** Items that wait for the owner now (open, not expired, not snoozed): Inbox's share of the TBD badge (C86). */
export function waitingCount(db: Db, now: number): number {
  return Number(
    db.prepare("SELECT COUNT(*) AS n FROM inbox_items WHERE status = 'open' AND expires_at > ? AND (snoozed_until IS NULL OR snoozed_until <= ?)").get(now, now)?.n ?? 0,
  );
}
