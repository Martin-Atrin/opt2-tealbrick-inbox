// Holds overview (C84, G4): everything that waits for the owner in one list.
// Spec 0.1.13 adds the standard op `tb.holds_pending` reached through a wildcard companion (product "*") that the
// owner consents to at deploy; Inbox then lists the pending holds of ALL apps, and each row opens the owning app's
// decision page through a Portal launch ticket (deciding stays in the owning app). Until this build declares that
// companion (feature check below), the overview lists Inbox's own open items only.
import type { AppDefinition } from "@opt2-tealbrick/miniapp-sdk";
import type { ItemSummary } from "./store.ts";

type Manifest = AppDefinition["manifest"];

export const HOLDS_PENDING_OP = "tb.holds_pending";

export interface OverviewRow {
  product: string;
  id: string;
  op: string;
  family: string | null;
  reason: string | null;
  summary: string;
  caller: { type: "agent" | "app" | "person"; id: string; name: string };
  createdAt: string;
  ageS: number;
  decidePath: string;
}

export interface Overview {
  source: "inbox_only" | "all_apps";
  unavailable: string | null;
  rows: OverviewRow[];
  errors: { product: string; code: string }[];
}

/** True when this build declares the cross-app holds companion (spec 0.1.13 and later). */
export function holdsPendingDeclared(manifest: Pick<Manifest, "companions">): boolean {
  return (manifest.companions ?? []).some((c) => (c.product as string) === "*" && c.operations.includes(HOLDS_PENDING_OP));
}

export const NOT_YET =
  "Pending approvals of other apps appear here once the workspace runs Teal Brick spec 0.1.13 and you allow Operator Inbox to see them. Until then, open each app's Holds page from Portal.";

export function inboxRows(items: readonly ItemSummary[], now: number): OverviewRow[] {
  return items.map((i) => ({
    product: "inbox",
    id: i.id,
    op: "inbox_ask",
    family: null,
    reason: i.kind === "approval" ? "approval requested" : "question",
    summary: i.title,
    caller: i.from,
    createdAt: i.createdAt,
    ageS: Math.max(0, Math.floor((now - Date.parse(i.createdAt)) / 1000)),
    decidePath: `/?item=${encodeURIComponent(i.id)}`,
  }));
}

export function overview(manifest: Pick<Manifest, "companions">, items: readonly ItemSummary[], now: number): Overview {
  // 0.1.x builds never declare the wildcard companion (the 0.1.11 validator refuses product "*"), so this is always
  // the Inbox-only list; the all-apps branch arrives with the SDK that serves tb.holds_pending (spec 0.1.13).
  const unavailable = holdsPendingDeclared(manifest) ? "This build lists other apps' approvals only with SDK 0.1.13." : NOT_YET;
  return { source: "inbox_only", unavailable, rows: inboxRows(items, now), errors: [] };
}
