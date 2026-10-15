// Operator Inbox UI inside the ONE app shell (<AppShell>, SDK-API §14). Pages: Inbox (the queue and one item), All approvals
// (every app's holds), the standard Holds and Agents & scopes pages (./standard.tsx), and Settings (the optional owner alert DM).
// Only two server paths exist (manifest ui.launchPath "/" and ui.configurePath "/configure"); the other pages are
// `?page=<id>` on the launch path, `?item=<id>` / `/items/<id>` opens one item and `/holds/<id>` one hold.
import { callOp, useSession } from "@opt2-tealbrick/miniapp-sdk/client";
import { AppShell, appArt, appColour, Button, Notice, STANDARD_PAGES, Tag } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";
import type { ItemsListOutput } from "#kit";
import { ApprovalsPage } from "./approvals.tsx";
import { InboxPage } from "./inbox.tsx";
import { SettingsPage } from "./settings.tsx";
import { AgentsPage, HoldsPage, holdOf, portalHref } from "./standard.tsx";

const NAME = "Operator Inbox";
/** Where scripts/build-ui.ts puts this app's still (`stills/`, next to this module in the hashed asset directory, C61). */
const STILLS = new URL("./stills/", import.meta.url).href;

type PageId = "inbox" | "approvals" | "holds" | "agents" | "settings";
const std = (id: string) => STANDARD_PAGES.find((p) => p.id === id)?.label ?? id;

// Deep links (Portal launch ticket `path`, C86): `/items/<itm_…>` opens one item; `/holds/<hld_…>` (tb.holds_pending
// decidePath, spec 0.1.13) opens that hold of Operator Inbox itself. `item` stays the query form used inside the app.
const ITEM_PATH = /\/items\/(itm_[0-9A-Za-z]{1,60})\/?$/;

function locate(): { page: PageId; item: string | null } {
  const url = new URL(globalThis.location.href);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/configure")) return { page: "settings", item: null };
  const hold = holdOf(path);
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

export function App() {
  const { principal, status, signOut } = useSession();
  const [loc, setLoc] = useState(locate);
  const [pending, setPending] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [portal] = useState(portalHref);
  useEffect(() => {
    const onPop = () => setLoc(locate());
    globalThis.addEventListener("popstate", onPop);
    return () => globalThis.removeEventListener("popstate", onPop);
  }, []);
  const go = (page: PageId, item: string | null = null) => {
    globalThis.history.pushState(null, "", href(page, item));
    setLoc({ page, item });
  };
  const signedIn = status === "signed_in" && principal;
  // The nav count on every page (C185): one read of the pending count when the owner is signed in. No polling; the
  // Inbox page keeps it current through onCounts, and its newer value wins. A failed read leaves the badge as it was.
  const ready = Boolean(signedIn);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    callOp<ItemsListOutput>("items_list", { view: "pending", limit: 1 })
      .then((d) => {
        if (live) setPending((p) => p ?? d.counts.pending);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [ready]);
  const pages = [
    { id: "inbox", label: "Inbox", badge: pending || null },
    { id: "approvals", label: "All approvals" },
    { id: "holds", label: std("holds") },
    { id: "agents", label: std("agents") },
    { id: "settings", label: "Settings" },
  ];
  return (
    <AppShell
      title={NAME}
      colour={appColour("inbox")}
      art={appArt("inbox", STILLS)}
      portalHref={portal}
      pages={pages}
      current={loc.page}
      onNavigate={(id) => go(id as PageId)}
      pageHref={(id) => href(id as PageId)}
      actions={
        signedIn ? (
          <Button
            size="sm"
            onClick={() => {
              setNotice(null);
              signOut().catch(() => setNotice("Couldn’t sign you out. Check your connection and try again."));
            }}
          >
            Sign out
          </Button>
        ) : (
          <Tag status={status === "loading" ? "busy" : "needs-you"}>{status === "loading" ? "Loading" : "Signed out"}</Tag>
        )
      }
      banner={
        status === "signed_out" ? (
          <Notice tone="needs-you" role="alert">
            Open this app from Portal to sign in.
          </Notice>
        ) : notice ? (
          <Notice tone="needs-you" role="alert">
            {notice}
          </Notice>
        ) : null
      }
    >
      {!signedIn ? null : loc.page === "inbox" ? (
        <InboxPage selected={loc.item} onSelect={(id) => go("inbox", id)} onCounts={setPending} hrefOf={(id) => href("inbox", id)} />
      ) : loc.page === "approvals" ? (
        <ApprovalsPage onOpenItem={(id) => go("inbox", id)} itemHref={(id) => href("inbox", id)} />
      ) : loc.page === "holds" ? (
        <HoldsPage empty="No calls to Operator Inbox wait for your approval." only={loc.item} />
      ) : loc.page === "agents" ? (
        <AgentsPage />
      ) : (
        <SettingsPage />
      )}
    </AppShell>
  );
}
