import { EventEmitter } from "node:events";
import { afterCommit } from "./db";

/**
 * What open pages hear about. `access` is the lowest level that may know about the change (the
 * page's effective level; for a change of visibility the lower of before and after): the event
 * stream only passes an event on to readers whose level is at least that. Titles are never sent.
 */
export type WikiEvent =
  | { type: "page.created"; slug: string; rev: number; access: number }
  | { type: "page.updated"; slug: string; rev: number; access: number }
  | { type: "page.deleted"; slug: string; access: number }
  | { type: "page.access"; slug: string; access: number };

const g = globalThis as unknown as { __wikiBus?: EventEmitter; __wikiClients?: number };
const bus = (g.__wikiBus ??= new EventEmitter().setMaxListeners(0));
g.__wikiClients ??= 0;

/** Emitted only once the write is committed (inside a transaction: after COMMIT, never on rollback). */
export const publish = (e: WikiEvent) => afterCommit(() => bus.emit("event", e));
export const subscribe = (fn: (e: WikiEvent) => void) => {
  bus.on("event", fn);
  return () => bus.off("event", fn);
};
export const clientCount = () => g.__wikiClients!;
export const addClient = () => {
  g.__wikiClients!++;
};
export const removeClient = () => {
  g.__wikiClients = Math.max(0, g.__wikiClients! - 1);
};
