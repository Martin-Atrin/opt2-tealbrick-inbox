// Small helpers every Operator Inbox page uses: plain error text, time words, one person-op loader that keeps its
// error (RUL-14), and the page head / loading / failed-load pieces. The standard pages come from ./standard.tsx.
import { callOp, TbError } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Notice } from "@opt2-tealbrick/ui";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { errorMessage } from "./standard.tsx";

/** Error codes whose server text is written for the owner (src/store.ts, src/alerts.ts): shown as it is. Every other error gets the standard plain sentence. */
const OWN_TEXT = /^(item_|already_decided|stale_version|response_not_allowed|message_required|until_invalid|alerts_invalid|owner_only)/;

/** A plain sentence for a failed call (design §6, L18): the cause and what to do. */
export function errText(e: unknown): string {
  if (e instanceof TbError && OWN_TEXT.test(e.code) && e.message) return e.message;
  return errorMessage(e);
}

export const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
// Dates as the approved mockup shows them (C185): fixed "en-GB" and a 24-hour clock, so every owner sees one form.
/** Short form for tight places (a select option): "15 Oct, 08:40". */
export const whenShort = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "13 Oct 2026, 09:58". */
export const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** The date only: "20 Oct 2026". */
export const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Loads one person op; `reload()` refetches; `every` ms polls while the page is open. The error of the last load is kept next to the data. */
export function useOp<O>(op: string, input: Record<string, unknown>, every = 0): { data: O | null; error: string | null; reload: () => void } {
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

export function Head({ title, lede }: { title: string; lede?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {lede ? <p className="tb-lede">{lede}</p> : null}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="tb-soft" role="status">
      Loading {what}.
    </p>
  );
}

/** A failed load: what happened, and a Try again button (RUL-14: never an empty state that looks like "nothing here"). */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Notice tone="needs-you" role="alert">
      <span className="tb-row">
        <span>{message}</span>
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      </span>
    </Notice>
  );
}
