import { afterEach, describe, expect, it, vi } from "vitest";
import { type DealChange, createChangeHub } from "@shared/pathDeal.ts";

/** `createChangeHub`: one entry per subscription, isolated listeners, a failed start (REVIEW §2.15). */

const groups: DealChange = { kind: "groups" };

const hub = () => {
  let emit: (change: DealChange) => void = () => {};
  const counts = { start: 0, stop: 0 };
  const subscribe = createChangeHub((e) => {
    counts.start++;
    emit = e;
    return () => {
      counts.stop++;
      emit = () => {};
    };
  });
  return { subscribe, counts, emit: (change: DealChange) => emit(change) };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createChangeHub", () => {
  it("starts with the first listener and stops with the last, as before", () => {
    const { subscribe, counts, emit } = hub();
    const seen: string[] = [];
    const a = subscribe(() => seen.push("a"));
    const b = subscribe(() => seen.push("b"));
    emit(groups);
    a();
    a(); // twice: harmless
    emit(groups);
    b();
    expect(counts).toEqual({ start: 1, stop: 1 });
    expect(seen).toEqual(["a", "b", "b"]);
  });

  it("treats the same function subscribed twice as two subscriptions", () => {
    const { subscribe, counts, emit } = hub();
    let calls = 0;
    const listener = () => calls++;
    const first = subscribe(listener);
    const second = subscribe(listener);
    emit(groups);
    expect(calls).toBe(2);
    first();
    first(); // a repeated unsubscribe can't end the other one
    emit(groups);
    expect(calls).toBe(3);
    expect(counts.stop).toBe(0);
    second();
    expect(counts.stop).toBe(1);
  });

  it("a listener that throws doesn't stop the others; its error is rethrown later", () => {
    const queued: (() => void)[] = [];
    vi.stubGlobal("reportError", undefined);
    vi.stubGlobal("queueMicrotask", (callback: () => void) => queued.push(callback));
    const { subscribe, emit } = hub();
    const seen: string[] = [];
    subscribe(() => seen.push("before"));
    subscribe(() => {
      throw new Error("listener failed");
    });
    subscribe(() => seen.push("after"));
    expect(() => emit(groups)).not.toThrow();
    vi.unstubAllGlobals();
    expect(seen).toEqual(["before", "after"]);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toThrow("listener failed");
  });

  it("a start that throws leaves no listener behind", () => {
    let fail = true;
    let emit: (change: DealChange) => void = () => {};
    const subscribe = createChangeHub((e) => {
      if (fail) throw new Error("store not ready");
      emit = e;
      return () => {};
    });
    let ghost = 0;
    expect(() => subscribe(() => ghost++)).toThrow("store not ready");
    fail = false;
    let calls = 0;
    subscribe(() => calls++);
    emit(groups);
    expect([ghost, calls]).toEqual([0, 1]);
  });
});
