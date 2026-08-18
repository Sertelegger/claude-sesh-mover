import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaultConfig } from "../src/config.js";

/**
 * THE APPLY BOUNDARY IS CONSENT, AND CONSENT IS A DEFAULT (#36).
 *
 * The owner's ruling on #36: one explicit per-import decision gating every
 * payload that lands outside a minted session id, with the full write set
 * disclosed — and **no path filter, ever**. That second half is what makes the
 * first half load-bearing. The `NEVER_INCLUDABLE` floor can be complete because
 * "names that subvert sesh-mover itself" is a finite set this plugin defines;
 * "names that can lead to code execution" is a property of the receiving
 * machine's toolchain and can never close. So there is no denylist standing
 * behind these flags, and there is not going to be one: **the flag is the
 * consent, and it is the whole of the consent.**
 *
 * That makes each default a security property rather than a UX preference, and
 * a default is exactly the kind of thing a well-meaning edit flips. This file
 * pins the ones that exist.
 *
 * ## What this file checks, and what it deliberately does not
 *
 * It reads SOURCE SHAPE, not behaviour — the same trade `tests/hub-hooks.test.ts`
 * makes for `hooks/hooks.json`. That is the right level here because the thing
 * at risk is a one-token edit at a wiring site (`=== true` -> `!== false`,
 * `--apply-carry` -> `--no-apply-carry`), and a test that reads the token fails
 * on exactly that edit.
 *
 * The BEHAVIOURAL proof that a carry payload is not applied when the flag is
 * absent already exists and is not duplicated here — it is
 * `tests/hub-pull.test.ts`'s "reports a carried payload and saves it, without
 * touching the tree, when --apply-carry is absent", which this file asserts is
 * still present so that deleting it is loud. The plans/memory defaults are
 * proved behaviourally in `tests/importer.test.ts`; what is pinned here is the
 * CLI wiring those tests do not go through.
 */

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf-8");

/**
 * The file with its comment lines removed.
 *
 * Load-bearing, and it was found by mutation rather than by thinking: the first
 * version of this file matched `applyCarry: !!opts.applyCarry` against the raw
 * source, and the comment written directly above that line QUOTED the
 * expression to explain it. Flipping the real code to `!== false` left the test
 * green, because the regex was matching the comment. A guard that reads source
 * has to read the source and not the prose about it.
 */
const codeOf = (rel: string): string =>
  read(rel)
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

/** Every dotted key `getDefaultConfig()` declares. */
function configKeys(): string[] {
  const walk = (obj: Record<string, unknown>, prefix: string): string[] =>
    Object.entries(obj).flatMap(([k, v]) => {
      const path = prefix ? `${prefix}.${k}` : k;
      return v && typeof v === "object" && !Array.isArray(v)
        ? walk(v as Record<string, unknown>, path)
        : [path];
    });
  return walk(getDefaultConfig() as unknown as Record<string, unknown>, "");
}

describe("the apply boundary: every payload outside a minted session id is opt-in or opt-out on purpose", () => {
  it("keeps --apply-carry an opt-in whose ABSENCE means do not apply", () => {
    const cli = codeOf("src/cli.ts");
    const pull = codeOf("src/hub/pull.ts");

    // Declared as a plain boolean flag. A `--no-apply-carry` would mean
    // Commander defaults it to true, which is the whole failure this pins.
    expect(cli).toMatch(/\.option\(\s*"--apply-carry"/);
    expect(cli).not.toMatch(/"--no-apply-carry"/);

    // Two wiring sites, and BOTH have to coerce absence to "no". `!!` at the
    // CLI and `=== true` in the orchestrator: `!== false` at either one turns
    // an unattended `hub pull` into an arbitrary project-file write.
    expect(cli).toMatch(/applyCarry:\s*!!opts\.applyCarry/);
    expect(pull).toMatch(/applyRequested:\s*opts\.applyCarry === true/);
    expect(pull).not.toMatch(/opts\.applyCarry !== false/);

    // The reason has to survive at the site, or the next reader reads a default
    // and sees a taste call. Raw source here, not `codeOf` — these two ARE
    // comments. (Kept to two lines in pull.ts on purpose: `hubPull` is under a
    // length ratchet, and the argument itself lives at the cli.ts declaration.)
    expect(read("src/cli.ts")).toMatch(/SECURITY PROPERTY RATHER THAN A UX PREFERENCE/i);
    expect(read("src/hub/pull.ts")).toMatch(/security property rather/i);

    // The behavioural half, which this file does not repeat.
    expect(read("tests/hub-pull.test.ts")).toContain(
      'it("reports a carried payload and saves it, without touching the tree, when --apply-carry is absent"'
    );
  });

  it("gives no config key the power to turn a payload apply on", () => {
    // A flag whose default can be moved into a config file is not a per-run
    // consent decision any more — it is a setting someone turned on once. The
    // hub's own automation flags (`hub.pullAppend`, `hub.carryDiff`) are about
    // what a PUSH captures and how a continuation splices; none of them decides
    // whether a received payload is written into the working tree.
    //
    // #47 added `export.includeWorkspace` / `export.includeCarry`, and they are
    // NOT a counter-example: they are CAPTURE settings, about what this
    // machine's own outgoing bundles contain, which is a decision the user makes
    // about their own files. The apply side has no key and must not gain one —
    // that asymmetry is the whole distinction this test encodes, and the regex
    // below is what keeps a well-meaning `import.applyWorkspace` out.
    const offenders = configKeys().filter((k) => /apply(?!Append)/i.test(k));
    expect(
      offenders,
      "A config key now names an apply decision. Payload apply is a per-invocation consent " +
        "decision (#36) — moving it into config makes it a setting, which is exactly what the " +
        "ruling rejects."
    ).toEqual([]);
  });

  it("keeps --apply-workspace an opt-in whose ABSENCE means do not apply", () => {
    // THE TRIPWIRE, DISCHARGED. This test used to assert that
    // `--apply-workspace` did not exist yet, and named the three checks its
    // successor had to make when #47 landed. #47 has landed; these are they,
    // and they are the same three the --apply-carry test above makes.
    const cli = codeOf("src/cli.ts");
    const importer = codeOf("src/importer.ts");

    // Declared as a plain boolean flag. A `--no-apply-workspace` would mean
    // Commander defaults it to true — the exact inversion of the property.
    expect(cli).toMatch(/\.option\(\s*\n?\s*"--apply-workspace"/);
    expect(cli).not.toMatch(/"--no-apply-workspace"/);
    expect(cli).not.toMatch(/"--no-force-workspace"/);

    // Two wiring sites, and BOTH coerce absence to "no": `!!` at the CLI and
    // `=== true` in the orchestrator. `!== false` at either one turns a bundle
    // someone handed the user into an arbitrary project-file write.
    expect(cli).toMatch(/applyWorkspace:\s*!!opts\.applyWorkspace/);
    expect(cli).toMatch(/forceWorkspace:\s*!!opts\.forceWorkspace/);
    expect(importer).toMatch(/applyWorkspace\s*=\s*options\.filePayload\?\.applyWorkspace === true/);
    expect(importer).toMatch(/forceWorkspace\s*=\s*options\.filePayload\?\.forceWorkspace === true/);
    expect(importer).not.toMatch(/applyWorkspace\s*!==\s*false/);
    expect(importer).not.toMatch(/forceWorkspace\s*!==\s*false/);

    // The carry's import-side wiring is the same shape, at a site the
    // --apply-carry test above does not reach (it reads `pull.ts`).
    expect(cli).toMatch(/applyCarry:\s*!!opts\.applyCarry/);
    expect(importer).toMatch(/applyCarryRequested\s*=\s*options\.filePayload\?\.applyCarry === true/);
    expect(importer).not.toMatch(/applyCarry\s*!==\s*false/);

    // The reason has to survive at the site, or the next reader reads a default
    // and sees a taste call. Raw source — these two ARE comments.
    expect(read("src/cli.ts")).toMatch(/SECURITY PROPERTY RATHER THAN A UX PREFERENCE/i);
    expect(read("src/importer.ts")).toMatch(/security property rather/i);

    // PER PAYLOAD, and this is the check that would catch a later "simplify
    // these two into one flag": an umbrella flag is a single consent decision
    // covering two payloads with different blast radii, which is what the
    // ruling forbids.
    expect(cli).not.toMatch(/"--apply-files"/);
    expect(cli).not.toMatch(/"--apply-payload"/);

    // Never "the bundle carried one, so it was applied". The behavioural half
    // — a real bundle with a real workspace payload, imported with no flag,
    // landing not one file — is in `tests/payload-parity.test.ts`; asserted here
    // so that deleting it is loud rather than silent.
    expect(read("tests/payload-parity.test.ts")).toContain(
      'it("writes no project file when the bundle carries a workspace payload and no flag asked for it"'
    );
  });

  it("keeps the two shared-namespace layers on opposite defaults, each stated explicitly", () => {
    const cli = codeOf("src/cli.ts");

    // `plans/` -> <config-dir>/plans, shared by every project on the machine.
    // Opt-IN: absence means not written.
    expect(cli).toMatch(/\.option\(\s*\n?\s*"--include-plans"/);
    expect(cli).not.toMatch(/"--no-include-plans"/);
    expect(cli).toMatch(/includePlans:\s*!!opts\.includePlans/);

    // `memory/` -> the target project's own directory. Opt-OUT: absence means
    // written, and `--no-memory` is the escape the CLI honors. Commander's
    // negated form sets `opts.memory` to false, so the wiring reads that.
    expect(cli).toMatch(/\.option\(\s*\n?\s*"--no-memory"/);
    expect(cli).not.toMatch(/"--include-memory"/);
    expect(cli).toMatch(/noMemory:\s*opts\.memory === false/);
  });
});
