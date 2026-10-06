import { afterEach, describe, expect, it } from "vitest";
import { deleteValueByPath, removeIn, setIn, setValueByPath } from "@shared/lib/path.ts";
import { parsePath, productPath } from "@shared/paths.ts";

/** The shared path helpers: prototype keys and writes under a leaf (REVIEW §2.5, §2.6). */

const proto = Object.prototype as Record<string, unknown>;
const polluted = () => ({}) as Record<string, unknown>;
afterEach(() => {
  delete proto.polluted;
});

const unsafePaths = ["__proto__.polluted", "constructor.prototype.polluted", "a.__proto__.polluted", "a.constructor.prototype.polluted"];

describe("paths: __proto__, constructor and prototype are never a path segment", () => {
  it("parsePath rejects them, anywhere in the path", () => {
    expect(parsePath("__proto__")).toBeNull();
    expect(parsePath("constructor")).toBeNull();
    expect(parsePath("prototype")).toBeNull();
    expect(parsePath(productPath("g", "p", "__proto__.polluted"))).toBeNull();
    expect(parsePath(productPath("g", "p", "constructor.prototype.polluted"))).toBeNull();
    expect(parsePath("groups.__proto__.products.p.data.x")).toBeNull();
    expect(parsePath("groups.g.products.constructor.data.x")).toBeNull();
    // everything else as before
    expect(parsePath("notionalCcy")).toEqual({ kind: "deal", key: "notionalCcy" });
    expect(parsePath(productPath("g", "p", "optionsCommon.strike"))).toEqual({
      kind: "product",
      groupId: "g",
      productId: "p",
      dataPath: "optionsCommon.strike",
    });
  });

  it("setValueByPath ignores a write through them", () => {
    for (const path of unsafePaths) {
      const target = { a: { b: 1 } };
      setValueByPath(target, path, "yes");
      expect(polluted().polluted).toBeUndefined();
      expect(target).toEqual({ a: { b: 1 } });
    }
  });

  it("setIn ignores a write through them: the same object back", () => {
    for (const path of unsafePaths) {
      const target = { a: { b: 1 } };
      expect(setIn(target, path, "yes")).toBe(target);
      expect(polluted().polluted).toBeUndefined();
    }
  });

  it("deleteValueByPath and removeIn ignore a delete through them", () => {
    proto.polluted = "keep me";
    for (const path of ["__proto__.polluted", "constructor.prototype.polluted"]) {
      deleteValueByPath({}, path);
      const target = {};
      expect(removeIn(target, path)).toBe(target);
      expect(proto.polluted).toBe("keep me");
    }
  });
});

describe("paths: a write under a leaf is ignored", () => {
  const leaves = () => ({ strike: "12", amount: NaN, nested: { flag: true } });

  it("setIn returns the same object instead of turning the leaf into an object", () => {
    const target = leaves();
    expect(setIn(target, "strike.x", 1)).toBe(target);
    expect(setIn(target, "strike.length", 1)).toBe(target);
    expect(setIn(target, "amount.x.y", 1)).toBe(target);
    expect(setIn(target, "nested.flag.x", 1)).toBe(target);
    expect(target).toEqual(leaves());
  });

  it("setValueByPath leaves the leaf alone instead of throwing", () => {
    const target = leaves();
    expect(() => setValueByPath(target, "strike.x", 1)).not.toThrow();
    expect(() => setValueByPath(target, "amount.x.y", 1)).not.toThrow();
    expect(() => setValueByPath(target, "nested.flag.x", 1)).not.toThrow();
    expect(target).toEqual(leaves());
  });

  it("deleteValueByPath and removeIn under a leaf neither throw nor change anything", () => {
    const target = leaves();
    expect(() => deleteValueByPath(target, "strike.x")).not.toThrow();
    expect(removeIn(target, "strike.x")).toBe(target);
    expect(removeIn(target, "nested.flag.x")).toBe(target);
    expect(target).toEqual(leaves());
  });

  it("still creates missing objects on the way, as before", () => {
    expect(setIn({}, "a.b", 1)).toEqual({ a: { b: 1 } });
    expect(setIn({ a: null }, "a.b", 1)).toEqual({ a: { b: 1 } });
    const target: Record<string, unknown> = {};
    setValueByPath(target, "a.b", 1);
    expect(target).toEqual({ a: { b: 1 } });
  });

  it("setIn and removeIn take pre-split segments too (no re-splitting on the way down)", () => {
    const target = { a: { b: 1, c: 2 } };
    expect(setIn(target, ["a", "b"], 3)).toEqual({ a: { b: 3, c: 2 } });
    expect(setIn(target, ["a", "b"], 1)).toBe(target);
    expect(removeIn(target, ["a", "c"])).toEqual({ a: { b: 1 } });
  });
});
