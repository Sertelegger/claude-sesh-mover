/**
 * # `errorMessage` — reading a thrown value safely (#102)
 *
 * The function this pins is three lines long, which is exactly why it needs a
 * test file of its own: it is three lines that ~45 call sites depend on, several
 * of them on contracts where a throw is not cosmetic (both hook endpoints, which
 * must ALWAYS exit 0; `pull-fetch.ts`'s stage aborts, whose module contract is
 * that untrusted input produces a typed abort rather than an exception).
 *
 * **What makes this hard to test by accident.** Every one of these values is a
 * legal thing to `throw` or `reject` with, and JavaScript offers no type that
 * excludes them — `catch` binds `unknown`, and `(e as Error).message` is an
 * assertion nobody checked. A test suite that only ever throws real `Error`s
 * exercises none of it, which is how the shape survived at 45 sites through
 * 1500 passing tests.
 *
 * So the cases below are not a list of exotica. Each is a value some real code
 * path can produce: `reject()` with no argument gives `undefined`, a rejected
 * `child_process` gives an object, a cross-realm `Error` (worker, vm) fails
 * `instanceof`, and a getter that throws is what a Proxy or a lazily-computed
 * error property does.
 */

import { describe, it, expect } from "vitest";
import { errorMessage } from "../src/errors.js";

describe("errorMessage", () => {
  it("keeps a real Error's message verbatim, including an empty one", () => {
    // The property every call site depends on and the one a fix could quietly
    // break: converting the extraction must not reword, prefix or truncate the
    // diagnosis. An empty message is a real Error's real message, not a missing
    // one, so it must not be replaced with a placeholder.
    expect(errorMessage(new Error("ENOENT: no such file or directory"))).toBe(
      "ENOENT: no such file or directory"
    );
    expect(errorMessage(new Error(""))).toBe("");
    expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
  });

  it("survives null and undefined — the case that made this a TypeError", () => {
    // `throw null` is legal, and `reject()` with no argument yields undefined.
    // This is the exact shape that threw out of a function documented as never
    // throwing (#96 finding 5), and the reason the optional chain is there.
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });

  it("renders primitives, including a symbol", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(42)).toBe("42");
    // A symbol is why the fallback is `String(e)` and not a template literal:
    // `${sym}` throws a TypeError, which would reintroduce the whole defect
    // inside the guard meant to prevent it.
    expect(errorMessage(Symbol("s"))).toBe("Symbol(s)");
  });

  it("duck-types `message` rather than testing instanceof", () => {
    // A cross-realm Error — from a worker thread or a vm context — fails
    // `instanceof Error` while carrying the diagnosis worth keeping whole. This
    // object stands in for one: no prototype relationship, a string `message`.
    expect(errorMessage({ message: "from another realm" })).toBe("from another realm");
    // Including one with a null prototype, which has no `hasOwnProperty` and no
    // `toString` — `String()` handles it, the optional chain reaches `message`.
    const bare = Object.assign(Object.create(null) as { message?: string }, { message: "np" });
    expect(errorMessage(bare)).toBe("np");
  });

  it("falls back when `message` exists but is not a string", () => {
    // An Error subclass whose `message` was reassigned is legal and does
    // happen. The result must still be a string; what it says matters less than
    // that no caller receives a number where it expects text.
    const weird = Object.assign(new Error("original"), { message: 7 });
    expect(typeof errorMessage(weird)).toBe("string");
    expect(errorMessage({ a: 1 })).toBe("[object Object]");
  });

  it("does not throw even when the value's own code throws", () => {
    // THE GUARD NO SHAPE CHECK CAN REPLACE. A property read and a `String()`
    // both run code the value's author chose, so a promise not to throw cannot
    // trust its own extraction. Both of these are reachable in real code — a
    // Proxy, a lazily-computed property, a class with a custom toString.
    const throwingGetter = {
      get message(): string {
        throw new Error("getter says no");
      },
    };
    const throwingToString = {
      toString(): string {
        throw new Error("toString says no");
      },
    };
    expect(() => errorMessage(throwingGetter)).not.toThrow();
    expect(() => errorMessage(throwingToString)).not.toThrow();
    expect(errorMessage(throwingGetter)).toBe("(error could not be rendered)");
    expect(errorMessage(throwingToString)).toBe("(error could not be rendered)");
  });

  it("returns a string for every shape, which is the whole contract", () => {
    // The property stated once over everything, because a caller's only
    // assumption is that it got text. A future edit that returns `undefined`
    // for some newly-considered shape would pass every specific case above.
    const values: unknown[] = [
      null, undefined, "s", 0, -0, NaN, Infinity, false, 0n, Symbol("x"),
      {}, [], () => {}, new Error("e"), new Error(""),
      { message: 1 }, { message: null }, Object.create(null),
      new Date(), /re/, new Map(), Promise.resolve(),
    ];
    for (const [i, v] of values.entries()) {
      // The label is built through `errorMessage` itself rather than through a
      // bare `String(v)` — which is not cuteness. The first draft used
      // `String(v?.constructor?.name ?? v)` and THREW on `Object.create(null)`,
      // because a null-prototype object has no `toString`: the exact defect
      // this function exists to prevent, reproduced inside the test asserting
      // it. The helper was right and the assertion label was the unguarded one.
      const label = `case ${i}: ${errorMessage(v)}`;
      let out: unknown;
      expect(() => { out = errorMessage(v); }, `threw on ${label}`).not.toThrow();
      expect(typeof out, `non-string for ${label}`).toBe("string");
    }
  });
});
