// Operator Inbox UI inside the ONE app shell (<AppShell>, SDK-API §14). Pages: Inbox (the queue and one item),
// Approvals (holds overview), the standard Holds and Agents pages, and Settings (the optional owner alert DM).
// Only two server paths exist (manifest ui.launchPath "/" and ui.configurePath "/configure"); other pages are
// `?page=<id>` on the launch path, and `?item=<id>` opens one item.
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { callOp, TbError, useAgents, useHolds, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, Button, Field, Notice, Select, STANDARD_PAGES, Tabs, Tag, TextInput } from "@opt2-tealbrick/ui";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useState } from "react";
import type { AlertsGetOutput, HoldsOverviewOutput, ItemGetOutput, ItemsListOutput } from "#kit";

const NAME = "Operator Inbox";
type PageId = "inbox" | "approvals" | "holds" | "agents" | "settings";
type View = "pending" | "snoozed" | "done" | "all";
type Summary = ItemsListOutput["items"][number];
type Response = ItemGetOutput["responses"][number];

const std = (id: string) => STANDARD_PAGES.find((p) => p.id === id)?.label ?? id;

// Deep links (Portal launch ticket `path`, C86): `/items/<itm_…>` opens one item; `/holds/<hld_…>` (tb.holds_pending
// decidePath, spec 0.1.13) opens that hold of Operator Inbox itself. `item` stays the query form used inside the app.
const ITEM_PATH = /\/items\/(itm_[0-9A-Za-z]{1,60})\/?$/;
const HOLD_PATH = /\/holds\/(hld_[0-9A-HJKMNP-TV-Z]{26})\/?$/;

function locate(): { page: PageId; item: string | null } {
  const url = new URL(globalThis.location.href);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/configure")) return { page: "settings", item: null };
  const hold = HOLD_PATH.exec(path)?.[1];
  if (hold) return { page: "holds", item: hold };
  const deep = ITEM_PATH.exec(path)?.[1];
  if (deep) return { page: "inbox", item: deep };
  const p = url.searchParams.get("page");
  const page: PageId = p === "approvals" || p === "holds" || p === "agents" ? p : "inbox";
  return { page, item: url.searchParams.get("item") };
}

/** In-app URLs, relative to <base href="/a/inbox/">. */
function href(page: PageId, item?: string | null): string {
  if (page === "settings") return "configure";
  if (page === "holds" && item) return `holds/${item}`;
  if (page === "inbox" && item) return `items/${item}`;
  return page === "inbox" ? "./" : `./?page=${page}`;
}

const errText = (e: unknown) => (e instanceof TbError ? e.message : e instanceof Error ? e.message : "Something went wrong.");
const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const when = (iso: string) => new Date(iso).toLocaleString();

/** Loads one person op; `reload()` refetches; `every` ms polls while the page is open. */
function useOp<O>(op: string, input: Record<string, unknown>, every = 0): { data: O | null; error: string | null; reload: () => void } {
  const key = JSON.stringify(input);
  const [data, setData] = useState<O | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `input`; `tick` forces a refetch
  useEffect(() => {
    let live = true;
    callOp<O>(op, JSON.parse(key))
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => live && setError(errText(e)));
    const timer = every > 0 ? setInterval(() => setTick((t) => t + 1), every) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [op, key, tick, every]);
  return { data, error, reload };
}

const ALERT_ERRORS: Record<string, string> = {
  no_sender_identity: "choose the workspace sender identity in Connect's settings",
  no_grant: "Connect is not in this workspace",
  denied: "you denied it in Connect",
};

const PRIORITY_TONE: Record<string, "blocked" | "action" | "neutral"> = { urgent: "blocked", high: "action", normal: "neutral", low: "neutral" };
const LABEL: Record<Response, string> = { approve: "Approve", deny: "Deny", answer: "Send answer", clarify: "Ask for clarification" };
const VARIANT: Record<Response, "primary" | "danger" | "secondary"> = { approve: "primary", answer: "primary", deny: "danger", clarify: "secondary" };

const split: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: "var(--tb-s4)", alignItems: "start" };
const rowStyle = (active: boolean): CSSProperties => ({
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "var(--tb-s3)",
  border: "1px solid var(--tb-line)",
  borderRadius: "var(--tb-radius)",
  background: active ? "var(--tb-teal-50)" : "var(--tb-surface)",
  cursor: "pointer",
  marginBottom: "var(--tb-s2)",
  font: "inherit",
  color: "inherit",
});
const pre: CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0, font: "inherit" };

function Row({ item, active, onOpen }: { item: Summary; active: boolean; onOpen: () => void }) {
  return (
    <button type="button" style={rowStyle(active)} onClick={onOpen} aria-current={active ? "true" : undefined}>
      <strong>{item.title}</strong>
      <div className="tb-muted">
        {item.from.name} · {item.kind === "approval" ? "approval" : "question"} · {ago(item.createdAt)}
      </div>
      <div>
        {item.priority !== "normal" ? <Tag tone={PRIORITY_TONE[item.priority]}>{item.priority}</Tag> : null}{" "}
        {item.status !== "open" ? <Tag tone={item.status === "answered" ? "ok" : "neutral"}>{item.response ?? item.status}</Tag> : null}{" "}
        {item.snoozedUntil ? <Tag>snoozed</Tag> : null}
      </div>
    </button>
  );
}

const SNOOZE: { value: string; label: string; ms: number }[] = [
  { value: "1h", label: "1 hour", ms: 3600_000 },
  { value: "4h", label: "4 hours", ms: 4 * 3600_000 },
  { value: "1d", label: "1 day", ms: 86400_000 },
  { value: "1w", label: "1 week", ms: 7 * 86400_000 },
];

function Detail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { data: item, error, reload } = useOp<ItemGetOutput>("item_get", { itemId: id }, 15_000);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "action" | "ok"; text: string } | null>(null);
  // The version the owner has read. A poll may bring a newer one (the agent added a message); answers keep using the
  // read version until the owner confirms the new text, so an answer on unread text is refused as stale (409).
  const [seen, setSeen] = useState<{ id: string; version: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new item starts with an empty note
  useEffect(() => {
    setMessage("");
    setNotice(null);
    setSeen(null);
  }, [id]);
  useEffect(() => {
    if (item && item.id === id && seen?.id !== id) setSeen({ id, version: item.version });
  }, [item, id, seen]);

  const act = async (op: string, input: Json, done?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await callOp(op, input);
      if (done) setNotice({ tone: "ok", text: done });
      setSeen(null);
      setMessage("");
      onChanged();
    } catch (e) {
      const stale = e instanceof TbError && e.code === "stale_version";
      setNotice({ tone: "action", text: stale ? "The agent added a message while you were reading. Read it, then answer again." : errText(e) });
    } finally {
      setBusy(false);
      reload();
    }
  };

  if (error) return <Notice tone="action">{error}</Notice>;
  if (!item) return <p className="tb-muted">Loading the item.</p>;
  const open = item.status === "open";
  const version = seen?.id === item.id ? seen.version : item.version;
  const unread = open && version < item.version;
  return (
    <section className="tb-panel tb-stack" aria-label={item.title}>
      <div>
        <div className="tb-muted">
          {item.from.name} · {item.kind === "approval" ? "asks for your approval" : "asks a question"} · {when(item.createdAt)}
        </div>
        <h2 style={{ margin: "var(--tb-s1) 0" }}>{item.title}</h2>
        <Tag tone={open ? "action" : item.status === "answered" ? "ok" : "neutral"}>{open ? "waiting for you" : item.status}</Tag>{" "}
        <Tag tone={PRIORITY_TONE[item.priority]}>{item.priority}</Tag> {item.acked && open ? <Tag>seen</Tag> : null}
        {open ? <div className="tb-muted">Expires {when(item.expiresAt)}</div> : null}
      </div>
      {item.context ? <p style={pre}>{item.context}</p> : <p className="tb-muted">The agent gave no further context.</p>}
      {item.messages.length > 0 ? (
        <ol className="tb-stack" style={{ listStyle: "none", padding: 0 }} aria-label="Messages">
          {item.messages.map((m) => (
            <li key={m.id}>
              <strong>{m.author === "owner" ? "You" : item.from.name}</strong> <span className="tb-muted">{ago(m.createdAt)}</span>
              <p style={pre}>{m.body}</p>
            </li>
          ))}
        </ol>
      ) : null}
      {item.decision ? (
        <Notice tone="ok">
          You answered <strong>{item.decision.response}</strong> {when(item.decision.decidedAt)}.
        </Notice>
      ) : null}
      {item.status === "expired" ? <Notice tone="action">This item expired before it was answered. The agent must ask again.</Notice> : null}
      {unread ? (
        <Notice tone="action" role="alert">
          The agent added a message after you opened this item. Read it before you answer.{" "}
          <Button size="sm" onClick={() => setSeen({ id: item.id, version: item.version })}>
            I have read it
          </Button>
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone={notice.tone} role="alert">
          {notice.text}
        </Notice>
      ) : null}
      {open ? (
        <div className="tb-stack">
          <Field label="Message to the agent" hint="Needed to answer or to ask for clarification; optional for approve and deny.">
            <textarea className="tb-textarea" aria-label="Message to the agent" rows={4} maxLength={4000} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <div className="tb-row" style={{ flexWrap: "wrap", gap: "var(--tb-s2)" }}>
            {item.responses.map((r) => (
              <Button
                key={r}
                variant={VARIANT[r]}
                disabled={busy || ((r === "answer" || r === "clarify") && !message.trim())}
                onClick={() =>
                  void act("item_decide", { itemId: item.id, version, response: r, ...(message.trim() ? { message: message.trim() } : {}) }, "Answer sent. The agent reads it on its next check.")
                }
              >
                {LABEL[r]}
              </Button>
            ))}
          </div>
          <div className="tb-row" style={{ flexWrap: "wrap", gap: "var(--tb-s2)", alignItems: "end" }}>
            {item.acked ? null : (
              <Button variant="ghost" disabled={busy} onClick={() => void act("item_ack", { itemId: item.id })}>
                Mark as seen
              </Button>
            )}
            <Field label="Priority">
              <Select
                value={item.priority}
                disabled={busy}
                onChange={(e) => void act("item_priority", { itemId: item.id, priority: e.target.value })}
                options={["low", "normal", "high", "urgent"].map((p) => ({ value: p, label: p }))}
              />
            </Field>
            <Field label="Snooze">
              <Select
                value=""
                disabled={busy}
                onChange={(e) => {
                  const s = SNOOZE.find((x) => x.value === e.target.value);
                  if (s) void act("item_snooze", { itemId: item.id, until: new Date(Date.now() + s.ms).toISOString() }, `Snoozed for ${s.label}.`);
                  if (e.target.value === "wake") void act("item_snooze", { itemId: item.id, until: null });
                }}
                options={[{ value: "", label: item.snoozedUntil ? `until ${when(item.snoozedUntil)}` : "Not snoozed" }, ...SNOOZE, ...(item.snoozedUntil ? [{ value: "wake", label: "Wake now", ms: 0 }] : [])]}
              />
            </Field>
          </div>
        </div>
      ) : null}
      {item.deliveries.length > 0 ? (
        <p className="tb-muted">
          Alert: {item.deliveries.map((d) => `${d.channel === "buzz" ? "Buzz DM" : "channel DM"} ${d.status}${d.error ? ` (${ALERT_ERRORS[d.error] ?? d.error})` : ""}`).join("; ")}
        </p>
      ) : null}
    </section>
  );
}

function Inbox({ selected, onSelect, onCounts }: { selected: string | null; onSelect: (id: string | null) => void; onCounts: (n: number) => void }) {
  const [view, setView] = useState<View>("pending");
  const { data, error, reload } = useOp<ItemsListOutput>("items_list", { view, limit: 100 }, 15_000);
  useEffect(() => {
    if (data) onCounts(data.counts.pending);
  }, [data, onCounts]);
  const empty: Record<View, string> = {
    pending: "Nothing waits for you. Your agents' questions and approval requests appear here.",
    snoozed: "No snoozed items.",
    done: "No answered or expired items yet.",
    all: "No items yet.",
  };
  return (
    <div style={split}>
      <div>
        <Tabs
          label="Show"
          value={view}
          onChange={setView}
          tabs={[
            { value: "pending", label: data ? `Waiting (${data.counts.pending})` : "Waiting" },
            { value: "snoozed", label: data ? `Snoozed (${data.counts.snoozed})` : "Snoozed" },
            { value: "done", label: "Done" },
            { value: "all", label: "All" },
          ]}
        />
        {error ? <Notice tone="action">{error}</Notice> : null}
        {!data ? <p className="tb-muted">Loading.</p> : data.items.length === 0 ? <p className="tb-muted">{empty[view]}</p> : null}
        <nav aria-label="Items">
          {data?.items.map((i) => (
            <Row key={i.id} item={i} active={i.id === selected} onOpen={() => onSelect(i.id)} />
          ))}
        </nav>
      </div>
      <div>{selected ? <Detail id={selected} onChanged={reload} /> : <p className="tb-muted">Select an item to read it and answer.</p>}</div>
    </div>
  );
}

function Approvals({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const { data, error } = useOp<HoldsOverviewOutput>("holds_overview", {}, 30_000);
  if (error) return <Notice tone="action">{error}</Notice>;
  if (!data) return <p className="tb-muted">Loading.</p>;
  return (
    <div className="tb-stack">
      {data.unavailable ? <Notice>{data.unavailable}</Notice> : null}
      {data.errors.map((e) => (
        <Notice key={e.product} tone="action">
          {e.product}: its approvals could not be read ({e.code}).
        </Notice>
      ))}
      {data.rows.length === 0 ? <p className="tb-muted">Nothing waits for your approval.</p> : null}
      <ul className="tb-stack" style={{ listStyle: "none", padding: 0 }}>
        {data.rows.map((r) => (
          <li key={`${r.product}/${r.id}`} className="tb-panel">
            <strong>{r.summary}</strong>
            <div className="tb-muted">
              {r.product} · {r.caller.name} · {r.reason ?? r.op} · {ago(r.createdAt)}
            </div>
            {r.product === "inbox" ? (
              <Button size="sm" onClick={() => onOpenItem(r.id)}>
                Open
              </Button>
            ) : r.openUrl ? (
              // Portal opens the owning app at its decision page (launch ticket); deciding happens there
              <a className="tb-btn" data-size="sm" href={r.openUrl} target="_blank" rel="noopener noreferrer">
                Open in {r.product}
              </a>
            ) : (
              <span className="tb-muted">Open {r.product} from Portal to decide.</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Settings() {
  const { data, error, reload } = useOp<AlertsGetOutput>("alerts_get", {});
  const [form, setForm] = useState<AlertsGetOutput | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "action"; text: string } | null>(null);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  if (error) return <Notice tone="action">{error}</Notice>;
  if (!form) return <p className="tb-muted">Loading.</p>;
  const save = async () => {
    try {
      setForm(await callOp<AlertsGetOutput>("alerts_set", form as unknown as Json));
      setNotice({ tone: "ok", text: "Saved." });
      reload();
    } catch (e) {
      setNotice({ tone: "action", text: errText(e) });
    }
  };
  const set = (patch: Partial<AlertsGetOutput>) => setForm({ ...form, ...patch });
  return (
    <section className="tb-panel tb-stack" aria-label="Alerts">
      <h2 style={{ margin: 0 }}>Alerts</h2>
      <p>
        New items always show in this inbox and in the Teal Brick desktop badge. You can also get a direct message for each new item. The message goes out
        through Connect from the workspace sender identity you choose in Connect's settings, so Connect must be in your workspace, and Connect may ask you
        to approve the first message.
      </p>
      <Field label="Direct message">
        <Select
          value={form.dm}
          onChange={(e) => set({ dm: e.target.value as AlertsGetOutput["dm"] })}
          options={[
            { value: "off", label: "Off" },
            { value: "buzz", label: "Buzz DM" },
            { value: "channel", label: "Slack or Telegram DM (a Connect channel account)" },
          ]}
        />
      </Field>
      {form.dm === "buzz" ? (
        <Field label="Your Buzz key" hint="npub1… or 64 hex characters">
          <TextInput value={form.buzzTo ?? ""} onChange={(e) => set({ buzzTo: e.target.value })} />
        </Field>
      ) : null}
      {form.dm === "channel" ? (
        <>
          <Field label="Connect channel account id" hint="From Connect's channel accounts.">
            <TextInput value={form.channelAccount ?? ""} onChange={(e) => set({ channelAccount: e.target.value })} />
          </Field>
          <Field label="Your handle in that channel">
            <TextInput value={form.channelPerson ?? ""} onChange={(e) => set({ channelPerson: e.target.value })} />
          </Field>
        </>
      ) : null}
      {notice ? (
        <Notice tone={notice.tone} role="status">
          {notice.text}
        </Notice>
      ) : null}
      <div>
        <Button variant="primary" onClick={() => void save()}>
          Save
        </Button>
      </div>
    </section>
  );
}

function Holds({ only }: { only: string | null }) {
  const { holds: all, loading, decide } = useHolds({ status: "held" });
  if (loading) return <p className="tb-muted">Loading holds.</p>;
  const holds = only ? all.filter((h) => h.id === only) : all;
  if (holds.length === 0)
    return <p className="tb-muted">{only ? "This approval is no longer waiting." : "No calls to Operator Inbox wait for your approval."}</p>;
  return (
    <ul className="tb-stack" style={{ listStyle: "none", padding: 0 }}>
      {holds.map((h) => (
        <li key={h.id} className="tb-panel">
          <strong>{h.caller.name}</strong> {h.summary} <Tag tone="action">{h.op}</Tag>
          {h.view ? <pre style={pre}>{h.view}</pre> : null}
          <Button variant="primary" onClick={() => void decide(h.id as Parameters<typeof decide>[0], "approve")}>
            Approve
          </Button>{" "}
          <Button onClick={() => void decide(h.id as Parameters<typeof decide>[0], "deny")}>Deny</Button>
        </li>
      ))}
    </ul>
  );
}

function Agents() {
  const { agents, loading } = useAgents();
  if (loading) return <p className="tb-muted">Loading agents.</p>;
  if (agents.length === 0) return <p className="tb-muted">No agents are connected to this app.</p>;
  return (
    <ul>
      {agents.map((a) => (
        <li key={a.id}>
          {a.name} <Tag>{a.mode}</Tag>
        </li>
      ))}
    </ul>
  );
}

export function App() {
  const { principal, status, signOut } = useSession();
  const [loc, setLoc] = useState(locate);
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    const onPop = () => setLoc(locate());
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);
  const go = (page: PageId, item: string | null = null) => {
    globalThis.history.pushState(null, "", href(page, item));
    setLoc({ page, item });
  };
  const pages = [
    { id: "inbox", label: "Inbox", badge: pending || null },
    { id: "approvals", label: "All approvals" },
    { id: "holds", label: std("holds") },
    { id: "agents", label: std("agents") },
    { id: "settings", label: "Settings" },
  ];
  const content: Record<PageId, ReactNode> = {
    inbox: <Inbox selected={loc.item} onSelect={(id) => go("inbox", id)} onCounts={setPending} />,
    approvals: <Approvals onOpenItem={(id) => go("inbox", id)} />,
    holds: <Holds only={loc.page === "holds" ? loc.item : null} />,
    agents: <Agents />,
    settings: <Settings />,
  };
  return (
    <AppShell
      title={NAME}
      pages={pages}
      current={loc.page}
      onNavigate={(id) => go(id as PageId)}
      actions={
        status === "signed_in" && principal ? (
          <Button onClick={() => void signOut()}>Sign out</Button>
        ) : (
          <Tag tone={status === "loading" ? "progress" : "action"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="action" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : null
      }
    >
      {status === "signed_in" ? content[loc.page] : null}
    </AppShell>
  );
}
