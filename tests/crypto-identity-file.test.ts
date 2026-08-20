import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { overrideHome, type HomeOverrideHandle } from "./helpers/env.js";
import {
  identityFilePath,
  loadOrCreateIdentity,
  readIdentityFile,
} from "../src/crypto/identity-file.js";
import { encodeRecipient, parseIdentity, recipientFromIdentity } from "../src/crypto/age.js";

const isPosix = process.platform !== "win32";

/**
 * This machine's private key, and the three states its file can be in.
 *
 * The test that carries the most weight here is not the happy path — it is
 * "unreadable is not absent". A `string | null` read with a `loadOrCreate` that
 * mints on `null` is a key SHREDDER: a truncated write or a sync conflict copy
 * would be silently replaced, and every bundle on the hub encrypted to the old
 * public key becomes permanently unreadable by this machine, with the old key
 * having been right there on disk until we overwrote it.
 */
describe("crypto/identity-file", () => {
  let home: string;
  let restore: HomeOverrideHandle;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sesh-identity-"));
    restore = overrideHome(home);
  });

  afterEach(() => {
    restore.restore();
    // Never leave key material behind, even a throwaway one.
    rmSync(home, { recursive: true, force: true });
  });

  it("mints an identity on first use, at ~/.sesh-mover/identity.age", () => {
    expect(readIdentityFile()).toEqual({ state: "absent" });

    const first = loadOrCreateIdentity();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);
    expect(first.identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
    expect(first.recipient).toMatch(/^age1[0-9a-z]+$/);
    expect(identityFilePath()).toBe(join(home, ".sesh-mover", "identity.age"));
    expect(existsSync(identityFilePath())).toBe(true);
  });

  it("returns the same key on the second call, and does not rewrite the file", () => {
    const first = loadOrCreateIdentity();
    const bytesAfterFirst = readFileSync(identityFilePath(), "utf-8");

    const second = loadOrCreateIdentity();
    expect(first.ok && second.ok).toBe(true);
    if (!(first.ok && second.ok)) return;
    expect(second.created).toBe(false);
    expect(second.identity).toBe(first.identity);
    expect(second.recipient).toBe(first.recipient);
    // Byte-identical: a rewrite would change the `# created:` stamp even when
    // the key survived, which is how "we regenerated silently" would look.
    expect(readFileSync(identityFilePath(), "utf-8")).toBe(bytesAfterFirst);
  });

  it("derives the published recipient from the secret, not from the file's comment", () => {
    const loaded = loadOrCreateIdentity();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // Rewrite the `# public key:` comment to a DIFFERENT, valid recipient. The
    // read must ignore it: a comment is a claim, the derivation is the fact, and
    // publishing a recipient nobody holds the key for surfaces only as "I cannot
    // decrypt my own bundles".
    const other = encodeRecipient(recipientFromIdentity(Buffer.alloc(32, 7)));
    expect(other).not.toBe(loaded.recipient);
    const doctored = readFileSync(identityFilePath(), "utf-8").replace(
      /# public key: age1\S+/,
      `# public key: ${other}`
    );
    writeFileSync(identityFilePath(), doctored, "utf-8");

    const read = readIdentityFile();
    expect(read.state).toBe("present");
    if (read.state !== "present") return;
    expect(read.recipient).toBe(loaded.recipient);
    expect(read.recipient).toBe(
      encodeRecipient(recipientFromIdentity(parseIdentity(read.identity)))
    );
  });

  it("writes age's own identity-file shape, so `age -i` can read it", () => {
    loadOrCreateIdentity();
    const lines = readFileSync(identityFilePath(), "utf-8").split("\n");
    expect(lines[0]).toMatch(/^# created: \d{4}-\d{2}-\d{2}T/);
    expect(lines[1]).toMatch(/^# public key: age1[0-9a-z]+$/);
    expect(lines[2]).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/);
    // The escape hatch this shape exists for: `age -d -i identity.age …`
    // recovers a bundle with this plugin uninstalled.
  });

  it.runIf(isPosix)("creates the key file mode 0600 on POSIX", () => {
    loadOrCreateIdentity();
    expect(statSync(identityFilePath()).mode & 0o777).toBe(0o600);
  });

  it.runIf(isPosix)("is 0600 regardless of the process umask", () => {
    // The `mode` argument to `open` is a CEILING, not a floor — it is masked by
    // umask — so it alone cannot promise an exact mode, which is why the create
    // path also chmods. Without that chmod this passes vacuously at the ordinary
    // umask of 022 and fails only for the user who has one set.
    //
    // Safe to mutate process-wide state here: vitest's default `forks` pool runs
    // each test FILE in its own child process and one file at a time within it.
    // 0o400 (strip owner-READ) rather than 0o200: the same masking applies to
    // the `mkdir(mode: 0o700)` above the write, and stripping owner-write or
    // owner-execute there leaves a directory nothing can be created in — which
    // is a different, honest finding about an exotic umask, and not the one this
    // test is for.
    const previous = process.umask(0o400);
    try {
      loadOrCreateIdentity();
      expect(statSync(identityFilePath()).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
      // The masked `mkdir` left `~/.sesh-mover` at 0300 — writable and
      // traversable, but not LISTABLE, so the afterEach cleanup cannot walk it.
      chmodSync(join(home, ".sesh-mover"), 0o700);
    }
  });

  it.runIf(isPosix)("reports a group/world-readable key file as insecureMode", () => {
    loadOrCreateIdentity();
    expect((readIdentityFile() as { insecureMode: boolean }).insecureMode).toBe(false);

    // A key file restored from a backup, copied with `cp -p` from elsewhere, or
    // unpacked from an archive commonly lands at 0644. Nothing else in the
    // system would ever notice.
    // Group and other are checked SEPARATELY, so that a mask narrowed to one of
    // them (0o007, 0o070) is caught: 0644 alone leaves both mutants green.
    for (const mode of [0o644, 0o640, 0o604]) {
      chmodSync(identityFilePath(), mode);
      const read = readIdentityFile();
      expect(read.state).toBe("present");
      if (read.state !== "present") return;
      expect(read.insecureMode, `mode ${mode.toString(8)}`).toBe(true);
      // Advisory, not fatal: the key still loads.
      expect(loadOrCreateIdentity().ok).toBe(true);
    }
    // And an owner-execute bit, which grants nobody else anything, is not it.
    chmodSync(identityFilePath(), 0o700);
    expect((readIdentityFile() as { insecureMode: boolean }).insecureMode).toBe(false);
  });

  describe("a present-but-unusable file is not an absent one", () => {
    it("classifies unparseable contents as unreadable/malformed and REFUSES to overwrite", () => {
      mkdirSync(join(home, ".sesh-mover"), { recursive: true });
      const junk = "this is not an age identity\n";
      writeFileSync(identityFilePath(), junk, "utf-8");

      const read = readIdentityFile();
      expect(read.state).toBe("unreadable");
      if (read.state !== "unreadable") return;
      expect(read.cause).toBe("malformed");
      expect(read.detail.length).toBeGreaterThan(0);

      const loaded = loadOrCreateIdentity();
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.cause).toBe("malformed");
      // THE assertion. Minting over these bytes would destroy whatever key they
      // are a damaged copy of, and lock this machine out of its own history.
      //
      // MEASURED: the property is DOUBLY guarded, and this pins the property
      // rather than either guard. Deleting the `unreadable` early return leaves
      // it green (the `wx` open flag catches it and the EEXIST arm re-reads);
      // so does turning `wx` into `w` (the early return catches it). Removing
      // BOTH turns this red. That redundancy is deliberate — do not "simplify"
      // one of them away on the strength of a green suite.
      expect(readFileSync(identityFilePath(), "utf-8")).toBe(junk);
    });

    it("classifies a comments-only file as malformed", () => {
      mkdirSync(join(home, ".sesh-mover"), { recursive: true });
      writeFileSync(identityFilePath(), "# created: whenever\n# public key: age1zzz\n\n", "utf-8");

      const read = readIdentityFile();
      expect(read.state).toBe("unreadable");
      if (read.state !== "unreadable") return;
      expect(read.cause).toBe("malformed");
      expect(read.detail).toMatch(/no key line/);
    });

    it("classifies a RECIPIENT stored where the identity belongs as malformed", () => {
      // The plausible user error: pasting the public half into the key file.
      // Both are bech32 and both are 32 bytes; only the HRP tells them apart, so
      // an implementation that skipped that check would happily "load" a key it
      // cannot decrypt with.
      mkdirSync(join(home, ".sesh-mover"), { recursive: true });
      writeFileSync(
        identityFilePath(),
        encodeRecipient(recipientFromIdentity(Buffer.alloc(32, 3))) + "\n",
        "utf-8"
      );

      const read = readIdentityFile();
      expect(read.state).toBe("unreadable");
      if (read.state !== "unreadable") return;
      expect(read.cause).toBe("malformed");
    });

    it("classifies bytes it cannot read at all as unreadable/io, distinctly from malformed", () => {
      // A directory at the path stands in for the family of "the key may be
      // perfectly intact, the filesystem is the problem" failures (a dead mount,
      // a permission failure) — and unlike a chmod 000 file it behaves the same
      // way when the suite runs as root.
      mkdirSync(identityFilePath(), { recursive: true });

      const read = readIdentityFile();
      expect(read.state).toBe("unreadable");
      if (read.state !== "unreadable") return;
      expect(read.cause).toBe("io");

      const loaded = loadOrCreateIdentity();
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.cause).toBe("io");
    });
  });
});
