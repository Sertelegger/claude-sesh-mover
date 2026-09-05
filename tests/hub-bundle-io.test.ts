/**
 * # `classifyBundleFailure` (bundle-io.ts)
 *
 * Both no-throw contracts in bundle-io.ts — `fetchBundleArchive` and
 * `rewrapBundleFile`, each documented in bold as "returns a result and never
 * throws" — bottom out in this one classifier, inside their own `catch`
 * blocks. The tests here are shaped by the one way that promise was found to
 * be false (#96, finding 5): a rejection REASON is whatever the failing code
 * threw, `throw null` is legal, and `(e as Error).message` made it a TypeError
 * thrown from the function whose contract is that it does not throw — exit 1
 * through the CLI's outer catch, no `suggestion`, every disclosure from
 * bundles already applied in the chain dropped.
 *
 * Two halves, deliberately:
 *
 * 1. **Every reason shape classifies without throwing**, and every result
 *    carries a real string `message` — the interface says `string` and every
 *    caller interpolates it into prose, so `undefined` leaking through is the
 *    quieter sibling of the throw.
 * 2. **Real Errors classify exactly as before.** The kind-per-AgeError-code
 *    table is pinned so the hardening cannot be paid for with a behaviour
 *    change on the path every genuine failure takes. These stay green under
 *    the mutation below, as they should — they guard the other property.
 *
 * Mutation-proved 2026-09-03: reverting the extraction to
 * `const message = (e as Error).message;` fails 10 of the 22 tests here
 * (null/undefined and the throwing-getter throw outright; string, number,
 * object, symbol and the non-string-message Error return a non-string or wrong
 * `message`; the end-to-end fetch rejects); restoring the fix returns all 22
 * to green. A green suite is not evidence a guard guards — this one was
 * watched failing first.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyBundleFailure, fetchBundleArchive } from "../src/hub/bundle-io.js";
import { AgeError, type AgeErrorCode } from "../src/crypto/age.js";
import type { HubBackend } from "../src/hub/backend.js";

describe("classifyBundleFailure never throws, whatever was thrown", () => {
  it("classifies null (property access on null is the original TypeError)", () => {
    const f = classifyBundleFailure(null);
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("null");
  });

  it("classifies undefined", () => {
    const f = classifyBundleFailure(undefined);
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("undefined");
  });

  it("keeps a string reason whole as the message", () => {
    const f = classifyBundleFailure("the share went away");
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("the share went away");
  });

  it("renders a number reason", () => {
    const f = classifyBundleFailure(42);
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("42");
  });

  it("renders a plain object reason", () => {
    const f = classifyBundleFailure({});
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("[object Object]");
  });

  it("renders a symbol reason (String() handles it; a template literal would throw)", () => {
    const f = classifyBundleFailure(Symbol("boom"));
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("Symbol(boom)");
  });

  it("keeps a duck-typed string message whole, Error or not", () => {
    // Deliberate: cross-realm Errors fail `instanceof Error`, and their
    // message is still the diagnosis worth keeping (the "kept WHOLE" rule on
    // `BundleFetchFailure.message`).
    const f = classifyBundleFailure({ message: "boom from another realm" });
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("boom from another realm");
  });

  it("classifies by CLASS, never by shape: a code field on a non-AgeError is ignored", () => {
    // An index file is another machine's write, so a reason must not be able
    // to steer its own kind by carrying an AgeError-looking `code`.
    const f = classifyBundleFailure({ code: "no-matching-identity", message: "impostor" });
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("impostor");
  });

  it("renders an Error subclass whose message was reassigned to a number", () => {
    const e = new Error("was a string once");
    (e as unknown as { message: unknown }).message = 42;
    const f = classifyBundleFailure(e);
    expect(f.kind).toBe("transfer");
    // Error.prototype.toString coerces: name + ": " + ToString(message).
    expect(f.message).toBe("Error: 42");
  });

  it("survives a message getter that throws", () => {
    const hostile = {
      get message(): string {
        throw new Error("gotcha");
      },
    };
    const f = classifyBundleFailure(hostile);
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("(rejection reason could not be rendered)");
  });

  it("survives a toString that throws", () => {
    const hostile = {
      toString(): string {
        throw new Error("gotcha");
      },
    };
    const f = classifyBundleFailure(hostile);
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("(rejection reason could not be rendered)");
  });
});

describe("classification is pinned for real Errors", () => {
  it("a plain Error is a transfer failure with its message kept whole", () => {
    const f = classifyBundleFailure(new Error("ENOENT: no such file or directory"));
    expect(f.kind).toBe("transfer");
    expect(f.message).toBe("ENOENT: no such file or directory");
  });

  it("AgeError no-matching-identity → no-matching-identity", () => {
    const f = classifyBundleFailure(new AgeError("no-matching-identity", "none of 2 stanzas"));
    expect(f.kind).toBe("no-matching-identity");
    expect(f.message).toBe("none of 2 stanzas");
  });

  it("AgeError bad-key → no-identity (a key problem, not a bundle problem)", () => {
    const f = classifyBundleFailure(new AgeError("bad-key", "not an age identity"));
    expect(f.kind).toBe("no-identity");
    expect(f.message).toBe("not an age identity");
  });

  it("AgeError no-recipients → no-identity (a fact about keys, not damaged ciphertext)", () => {
    const f = classifyBundleFailure(new AgeError("no-recipients", "empty recipient list"));
    expect(f.kind).toBe("no-identity");
    expect(f.message).toBe("empty recipient list");
  });

  it.each<AgeErrorCode>([
    "malformed-header",
    "unsupported-version",
    "bad-passphrase",
    "header-mac-mismatch",
    "payload-authentication-failed",
    "truncated",
  ])("AgeError %s → ciphertext-rejected", (code) => {
    const f = classifyBundleFailure(new AgeError(code, `refused: ${code}`));
    expect(f.kind).toBe("ciphertext-rejected");
    expect(f.message).toBe(`refused: ${code}`);
  });
});

describe("the contract holds at the caller, not just the unit", () => {
  it("fetchBundleArchive resolves a typed failure when the source rejects with null", async () => {
    // A mocked backend, flagged as such: no real filesystem can reject with
    // `null` — the shape is only producible by injection, which is exactly why
    // it earns the mock. Only `readStream` is reachable on this path (the file
    // name is plaintext, so no identity is read).
    const backend = {
      readStream: () => Promise.reject(null),
    } as unknown as HubBackend;
    const dir = mkdtempSync(join(tmpdir(), "sesh-mover-bundle-io-"));
    try {
      const outcome = await fetchBundleArchive({
        backend,
        file: "projects/p/bundles/m/b.tar.gz",
        destPath: join(dir, "b.tar.gz"),
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.encrypted).toBe(false);
        expect(outcome.failure.kind).toBe("transfer");
        expect(outcome.failure.message).toBe("null");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
