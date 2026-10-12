// Test helpers: a migrated in-memory database shaped like the SDK's Db (transactions roll back on throw, as the
// SDK's do), and a minimal OpContext for calling handlers directly.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Db, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";

export function memoryDb(): Db {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  let depth = 0;
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      const sp = `sp${depth}`;
      raw.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
      depth++;
      try {
        const out = fn();
        raw.exec(depth === 1 ? "COMMIT" : `RELEASE ${sp}`);
        return out;
      } catch (e) {
        raw.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw e;
      } finally {
        depth--;
      }
    },
  } as unknown as Db;
}

export type CallApp = OpContext["callApp"];
export interface Sent {
  product: string;
  op: string;
  input: Json;
  key: string | undefined;
}

export const AGENT = { type: "agent", id: "agt_01J0000000000000000000000A", name: "Scout", mode: "free" } as const;
export const OTHER = { type: "agent", id: "agt_01J0000000000000000000000B", name: "Other", mode: "free" } as const;
export const OWNER = { type: "person", id: "per_01J00000000000000000000000", name: "Owner", mode: "free" } as const;

export const PORTAL = "https://portal.example.test";
export const WS = "wsp_01J00000000000000000000000";

export interface CtxExtras {
  targets?: string[];
  portal?: boolean;
  status?: { pushes: number };
}

export function ctxFor(db: Db, caller: { type: string; id: string; name: string; mode: string }, callApp?: CallApp, x: CtxExtras = {}): OpContext {
  const noApp: CallApp = async () => {
    throw Object.assign(new Error("no grant"), { code: "no_grant" });
  };
  return {
    db,
    caller,
    callApp: callApp ?? noApp,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    receipt: { summary() {}, meta() {} },
    statusChanged() {
      if (x.status) x.status.pushes++;
    },
    // the SDK's rule: <portalUrl>/w/<ws>/open?product=<own>&path=<path>
    ownerLink: (path: string) => (x.portal === false ? null : `${PORTAL}/w/${WS}/open?product=inbox&path=${encodeURIComponent(path)}`),
    companionTargets: () => x.targets ?? [],
  } as unknown as OpContext;
}
