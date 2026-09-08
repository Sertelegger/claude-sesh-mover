import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync as mkdirSyncFs,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import * as tar from "tar";
import {
  overrideTmp,
  overridePath,
  prependPathInProcess,
  type PathOverrideHandle,
  type TmpOverrideHandle,
} from "./helpers/env.js";

const isWindows = process.platform === "win32";

/**
 * Is a real `zstd` on the PATH this file was collected with? Decided once, at
 * collection time and before any test prepends a shim, so the real-binary
 * block below is skipped VISIBLY on a runner without one instead of passing
 * for want of it. Same probe as archiver.ts's `isZstdAvailable`, made
 * synchronous because `describe.skipIf` needs its answer now.
 */
const realZstdOnPath = ((): boolean => {
  try {
    execFileSync("zstd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface ZstdShim {
  /** Prepend this to PATH to put the shim in front of any real zstd. */
  binDir: string;
  /**
   * Every invocation the shim answered, argv joined by single spaces, in call
   * order. Empty after an operation means a REAL zstd answered instead — the
   * silent inertness this log exists to make loud.
   */
  calls(): string[];
}

/**
 * Install a fake `zstd` on PATH that implements the exact invocations the
 * archiver uses (`--version`, `-f <in> -o <out>`, `-d --stdout <in>`).
 * Compression is faked (output = input), which is fine: the ".tar.zst" the
 * shim produces is a plain tar, and the shim's -d writes it straight back out.
 *
 * The decompression form is pinned here deliberately. It has to be a STREAM
 * (`--stdout`) rather than the older file-to-file `-d <in> -o <out>`, because
 * a size bound that only gets to look at the result is a bound that has
 * already paid for it — see the decompression-limit tests below.
 *
 * Every invocation is also recorded in `calls()`, because a shim that is on
 * PATH and never runs is worse than no shim: the tests pass against whatever
 * real zstd the machine has and prove nothing about the shape they claim to
 * pin. That is exactly what happened on Windows CI (#16), and the log is what
 * turns it from invisible into a failure — assert the log, never just the
 * outcome.
 *
 * POSIX only, and the reason is narrower than "Windows cannot run a shebang
 * script". archiver.ts spawns `zstd` by bare name with no shell, and on
 * Windows that lookup is libuv's `search_path` (deps/uv/src/win/process.c),
 * whose contract is explicit: it follows cmd.exe's rules "with this exception
 * that PATHEXT environment variable isn't used. Since CreateProcess can start
 * only .com and .exe files, only those extensions are tried." So a
 * `zstd.cmd`/`zstd.bat` beside this script would never be a candidate either,
 * and the lookup walks past the shim directory to the runner's real
 * `zstd.exe` (windows-latest ships one at C:\tools\zstd) — which is what kept
 * the old, unguarded block green there while it exercised nothing it named.
 * Node's own post-CVE-2024-27980 refusal to spawn a batch file without a
 * shell (src/process_wrap.cc, `IsWindowsBatchFile(options.file)`) is a
 * second, independent barrier, and it only applies to a caller that names the
 * `.cmd` literally, which archiver.ts never does. The one artefact libuv would
 * accept is a `zstd.exe`, and minting a PE binary inside a vitest run means a
 * hex blob nobody can audit or a runtime compiler dependency — neither
 * provable from the platform this file is written on. So the block that uses
 * this shim is skipped on Windows, and the real-binary block beside it keeps
 * the coverage the Windows job was in fact providing.
 */
function installZstdShim(tempDir: string): ZstdShim {
  const binDir = join(tempDir, "shim-bin");
  mkdirSyncFs(binDir, { recursive: true });
  const callLog = join(binDir, "calls.log");
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> "${callLog}"`,
    'if [ "$1" = "--version" ]; then echo "zstd 1.5.5-fake"; exit 0; fi',
    'if [ "$1" = "-f" ]; then cp "$2" "$4"; exit 0; fi',
    'if [ "$1" = "-d" ] && [ "$2" = "--stdout" ]; then cat "$3"; exit 0; fi',
    "exit 64",
    "",
  ].join("\n");
  const shimPath = join(binDir, "zstd");
  writeFileSync(shimPath, script);
  chmodSync(shimPath, 0o755);
  return {
    binDir,
    calls: () =>
      existsSync(callLog)
        ? readFileSync(callLog, "utf-8").split("\n").filter((line) => line !== "")
        : [],
  };
}

describe("archiver", () => {
  let tempDir: string;
  let sourceDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sesh-mover-archiver-test-"));
    sourceDir = join(tempDir, "test-export");
    mkdirSync(join(sourceDir, "sessions"), { recursive: true });
    writeFileSync(
      join(sourceDir, "manifest.json"),
      '{"version":1,"plugin":"sesh-mover"}'
    );
    writeFileSync(
      join(sourceDir, "sessions", "test.jsonl"),
      '{"type":"user"}\n'
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("createArchive (tar.gz)", () => {
    it("creates a .tar.gz archive of the export directory", async () => {
      const { createArchive } = await import("../src/archiver.js");
      const archivePath = join(tempDir, "test-export.tar.gz");
      await createArchive(sourceDir, archivePath, "gzip");
      expect(existsSync(archivePath)).toBe(true);
    });
  });

  describe("extractArchive (tar.gz)", () => {
    it("round-trips a directory through tar.gz", async () => {
      const { createArchive, extractArchive } = await import(
        "../src/archiver.js"
      );
      const archivePath = join(tempDir, "test-export.tar.gz");
      await createArchive(sourceDir, archivePath, "gzip");

      const extractDir = join(tempDir, "extracted");
      mkdirSync(extractDir);
      await extractArchive(archivePath, extractDir);
      expect(existsSync(join(extractDir, "manifest.json"))).toBe(true);
      expect(existsSync(join(extractDir, "sessions", "test.jsonl"))).toBe(
        true
      );
    });
  });

  describe("detectArchiveFormat", () => {
    it("detects tar.gz", async () => {
      const { detectArchiveFormat } = await import("../src/archiver.js");
      expect(detectArchiveFormat("export.tar.gz")).toBe("gzip");
    });

    it("detects tar.zst", async () => {
      const { detectArchiveFormat } = await import("../src/archiver.js");
      expect(detectArchiveFormat("export.tar.zst")).toBe("zstd");
    });

    it("returns null for directories", async () => {
      const { detectArchiveFormat } = await import("../src/archiver.js");
      expect(detectArchiveFormat("export-dir")).toBeNull();
    });

    // Characterization, not a wish: an encrypted bundle name is NOT a
    // recognized container, so every consumer of this function must branch on
    // `.age` BEFORE calling extractArchive (cli.ts's import action does).
    // Teaching this function a new "encrypted" return value would ripple its
    // union type into hub callers; the null is the contract.
    it("returns null for an age-encrypted bundle name", async () => {
      const { detectArchiveFormat } = await import("../src/archiver.js");
      expect(detectArchiveFormat("export.tar.gz.age")).toBeNull();
    });
  });

  describe("extractArchive refuses unrecognized formats (#96 finding 4 sibling)", () => {
    // Before the fix, a `null` format fell into the tar/gzip branch, so an
    // unknown container was "diagnosed" by whatever zlib error its first bytes
    // produced. Both tests here fail against that code: the first gets a zlib
    // "incorrect header check" instead of the format message, the second gets
    // an ENOENT. Mutation-proved in-session by reverting the `else if` to a
    // bare `else`.
    it("refuses an age-encrypted name with a format error, not a gzip error, and writes nothing", async () => {
      const { extractArchive } = await import("../src/archiver.js");
      const encPath = join(tempDir, "bundle.tar.gz.age");
      // Realistic first bytes of an age file — exactly what the old code
      // handed to gunzip.
      writeFileSync(encPath, "age-encryption.org/v1\n-> X25519 notarealstanza\n");
      const target = join(tempDir, "enc-extract-target");
      mkdirSync(target, { recursive: true });
      await expect(extractArchive(encPath, target)).rejects.toThrow(
        /Not a recognized archive/
      );
      expect(readdirSync(target)).toEqual([]);
    });

    it("refuses by NAME before any IO — a missing path still gets the format refusal, not ENOENT", async () => {
      const { extractArchive } = await import("../src/archiver.js");
      const target = join(tempDir, "noio-extract-target");
      mkdirSync(target, { recursive: true });
      await expect(
        extractArchive(join(tempDir, "does-not-exist.bin"), target)
      ).rejects.toThrow(/Not a recognized archive/);
    });

    it("names the formats it does recognize, so the refusal is actionable", async () => {
      const { extractArchive } = await import("../src/archiver.js");
      const target = join(tempDir, "named-extract-target");
      mkdirSync(target, { recursive: true });
      await expect(
        extractArchive(join(tempDir, "bundle.tar.gz.age"), target)
      ).rejects.toThrow(/\.tar\.gz.*\.tgz.*\.tar\.zst.*\.tar\.zstd/);
    });
  });

  describe("isZstdAvailable", () => {
    it("returns a boolean", async () => {
      const { isZstdAvailable } = await import("../src/archiver.js");
      const result = await isZstdAvailable();
      expect(typeof result).toBe("boolean");
    });
  });

  /**
   * The container properties every zstd backend must satisfy. Registered
   * twice below: once against the shim, where each run is proved to have
   * reached it, and once against the real binary, where the run is proved to
   * have produced a real frame. Neither alone is the coverage — the shim run
   * is deterministic and available on a machine with no zstd, the real run is
   * what a user's export actually goes through, and until #16 the second was
   * only ever happening by accident, under the first one's name.
   */
  function zstdContainerProperties(): void {
    it("round-trips a directory through tar.zst", async () => {
      const { createArchive, extractArchive } = await import("../src/archiver.js");
      const archivePath = join(tempDir, "test-export.tar.zst");
      await createArchive(sourceDir, archivePath, "zstd");
      expect(existsSync(archivePath)).toBe(true);

      const extractDir = join(tempDir, "zst-extracted");
      mkdirSync(extractDir);
      await extractArchive(archivePath, extractDir);
      expect(existsSync(join(extractDir, "manifest.json"))).toBe(true);
    });

    it("never touches a pre-existing sibling .tar during zstd extraction", async () => {
      const { createArchive, extractArchive } = await import("../src/archiver.js");
      const archivePath = join(tempDir, "test-export.tar.zst");
      await createArchive(sourceDir, archivePath, "zstd");

      // The old implementation decompressed to <archive-dir>/test-export.tar
      // and deleted it in a finally block — destroying this file.
      const preciousPath = join(tempDir, "test-export.tar");
      writeFileSync(preciousPath, "precious pre-existing tar");

      const extractDir = join(tempDir, "zst-extracted-2");
      mkdirSync(extractDir);
      await extractArchive(archivePath, extractDir);

      expect(existsSync(preciousPath)).toBe(true);
      expect(readFileSync(preciousPath, "utf-8")).toBe("precious pre-existing tar");
    });

    it("never leaves or deletes a sibling .tar during zstd creation", async () => {
      const { createArchive } = await import("../src/archiver.js");
      const preciousPath = join(tempDir, "created.tar");
      writeFileSync(preciousPath, "precious");
      await createArchive(sourceDir, join(tempDir, "created.tar.zst"), "zstd");
      expect(readFileSync(preciousPath, "utf-8")).toBe("precious");
    });
  }

  // Skipped on Windows for the reason documented on installZstdShim; the
  // real-binary block below is what runs there.
  describe.skipIf(isWindows)("zstd via shim", () => {
    let shim: ZstdShim;
    let pathHandle: PathOverrideHandle;

    beforeEach(() => {
      shim = installZstdShim(tempDir);
      pathHandle = prependPathInProcess(shim.binDir);
    });

    afterEach(() => {
      // Restore BEFORE asserting, so a failure here cannot leave the shim on
      // PATH for the real-binary block that follows.
      pathHandle.restore();
      // Every test in this block shells out to zstd at least once. An empty
      // log means a real zstd answered and the shim was decoration — the
      // silent inertness the Windows guard exists for, caught here on every
      // platform the block does run on.
      expect(shim.calls(), "no zstd invocation reached the shim").not.toEqual([]);
    });

    zstdContainerProperties();

    it("is what answered, for every invocation shape the archiver uses", async () => {
      const { createArchive, extractArchive, isZstdAvailable, zstdFrameHasContentChecksum } =
        await import("../src/archiver.js");
      expect(await isZstdAvailable()).toBe(true);
      const archivePath = join(tempDir, "who-answered.tar.zst");
      await createArchive(sourceDir, archivePath, "zstd");
      const extractDir = join(tempDir, "who-answered-out");
      mkdirSync(extractDir);
      await extractArchive(archivePath, extractDir);

      // Pinned as the exact argv sequence, not "non-empty": these three shapes
      // are the archiver's whole contract with the binary, and a fourth one
      // appearing here (or one of these changing) is a change the shim has to
      // learn about before it can keep faking it.
      const calls = shim.calls();
      expect(calls).toHaveLength(3);
      expect(calls[0]).toBe("--version");
      expect(calls[1]).toMatch(/^-f .+ -o /);
      expect(calls[1].endsWith(` -o ${archivePath}`)).toBe(true);
      expect(calls[2]).toBe(`-d --stdout ${archivePath}`);
      // And the artefact says the same from the other side: the shim's -f is
      // a plain copy, so what it "compressed" is a bare tar, not a zstd frame.
      expect(zstdFrameHasContentChecksum(archivePath)).toBeNull();
    });
  });

  /**
   * The same properties against whatever real `zstd` this machine has. This
   * is the coverage the Windows job was providing under the shim block's name
   * before #16 — kept deliberately, now on every OS with the binary, and
   * skipped visibly where none is on PATH rather than passing for want of one.
   */
  describe.skipIf(!realZstdOnPath)("zstd via the real binary on PATH", () => {
    zstdContainerProperties();

    it("writes a real zstd frame, so a leaked shim could not satisfy this block", async () => {
      const { createArchive, zstdFrameHasContentChecksum } = await import("../src/archiver.js");
      const archivePath = join(tempDir, "real.tar.zst");
      await createArchive(sourceDir, archivePath, "zstd");
      expect(zstdFrameHasContentChecksum(archivePath)).toBe(true);
    });
  });

  /**
   * Container-level error detection: what each format actually gives us, and
   * whether the two are equally loud. Measured, not assumed — the `.tar.zst`
   * path's whole guarantee turned out to rest on a zstd CLI default that
   * nothing in this codebase asserted.
   */
  describe("corruption detection in the container", () => {
    /** Everything after `at` shorn off. */
    function truncate(path: string, fraction: number): void {
      const d = readFileSync(path);
      writeFileSync(path, d.subarray(0, Math.floor(d.length * fraction)));
    }
    /** One bit flipped in the middle of the compressed body. */
    function flipMiddleByte(path: string): void {
      const d = readFileSync(path);
      d[Math.floor(d.length / 2)] ^= 0xff;
      writeFileSync(path, d);
    }
    /** A payload big enough that a mid-file flip lands in compressed data. */
    function bulkSource(): string {
      const dir = join(tempDir, "bulk");
      mkdirSync(join(dir, "sessions"), { recursive: true });
      writeFileSync(join(dir, "manifest.json"), '{"version":1,"plugin":"sesh-mover"}');
      for (let i = 0; i < 40; i++) {
        writeFileSync(
          join(dir, "sessions", `s${i}.jsonl`),
          `{"type":"user","uuid":"u${i}","text":"${"payload ".repeat(200)}"}\n`
        );
      }
      return dir;
    }

    it("gzip: BOTH a truncated and a bit-flipped .tar.gz throw out of extractArchive", async () => {
      const { createArchive, extractArchive } = await import("../src/archiver.js");
      const src = bulkSource();

      const cut = join(tempDir, "cut.tar.gz");
      await createArchive(src, cut, "gzip");
      truncate(cut, 0.6);
      await expect(
        extractArchive(cut, mkdtempSync(join(tempDir, "out-cut-")))
      ).rejects.toThrow(/unexpected end of file/i);

      const bent = join(tempDir, "bent.tar.gz");
      await createArchive(src, bent, "gzip");
      flipMiddleByte(bent);
      // Backstopped by the CRC32 in the gzip member — this is the guarantee the
      // zstd path has to match, and the reason a checksum-less .tar.zst is
      // genuinely weaker. Asserted as "throws", not on a specific zlib message:
      // tar entries carry the fixture's own mtimes, so the compressed bytes
      // differ run to run and so does which deflate invariant the flipped byte
      // happens to break first. The property under test is that damage is never
      // silent, and the CRC is what makes that true even when the stream
      // decodes.
      await expect(
        extractArchive(bent, mkdtempSync(join(tempDir, "out-bent-")))
      ).rejects.toThrow();
    });

    it("zstd: an archive we create declares a content checksum, and both damage shapes throw", async () => {
      const { createArchive, extractArchive, isZstdAvailable, zstdFrameHasContentChecksum } =
        await import("../src/archiver.js");
      if (!(await isZstdAvailable())) return; // no zstd on this runner — nothing to measure
      const src = bulkSource();

      const good = join(tempDir, "good.tar.zst");
      await createArchive(src, good, "zstd");
      // The property createZstdArchive now verifies rather than assumes.
      expect(zstdFrameHasContentChecksum(good)).toBe(true);

      const cut = join(tempDir, "cut.tar.zst");
      await createArchive(src, cut, "zstd");
      truncate(cut, 0.6);
      await expect(
        extractArchive(cut, mkdtempSync(join(tempDir, "z-out-cut-")))
      ).rejects.toThrow();

      const bent = join(tempDir, "bent.tar.zst");
      await createArchive(src, bent, "zstd");
      flipMiddleByte(bent);
      // Caught by the XXH64 frame checksum. Without it (measured with
      // `--no-check`) zstd exits 0 and writes silently different bytes.
      await expect(
        extractArchive(bent, mkdtempSync(join(tempDir, "z-out-bent-")))
      ).rejects.toThrow();
    });

    it("zstdFrameHasContentChecksum reads the frame header, and says null when it cannot tell", async () => {
      const { zstdFrameHasContentChecksum } = await import("../src/archiver.js");
      const notZstd = join(tempDir, "plain.bin");
      writeFileSync(notZstd, "this is not a zstd frame at all");
      expect(zstdFrameHasContentChecksum(notZstd)).toBeNull();

      const tooShort = join(tempDir, "short.bin");
      writeFileSync(tooShort, Buffer.from([0x28, 0xb5]));
      expect(zstdFrameHasContentChecksum(tooShort)).toBeNull();

      expect(zstdFrameHasContentChecksum(join(tempDir, "does-not-exist"))).toBeNull();

      // Frame_Header_Descriptor bit 2 is the Content_Checksum_flag.
      const magic = [0x28, 0xb5, 0x2f, 0xfd];
      const off = join(tempDir, "nocheck.zst");
      writeFileSync(off, Buffer.from([...magic, 0x00, 0x00, 0x00]));
      expect(zstdFrameHasContentChecksum(off)).toBe(false);
      const on = join(tempDir, "check.zst");
      writeFileSync(on, Buffer.from([...magic, 0x04, 0x00, 0x00]));
      expect(zstdFrameHasContentChecksum(on)).toBe(true);
    });

    // POSIX only, for the reason documented on installZstdShim: a shell-less
    // spawn on Windows resolves only .com/.exe, so this shim is never a
    // candidate there and the runner's real zstd.exe answers — which would
    // make this test assert the opposite of its name. Skipped visibly rather
    // than returned from, so the report says so. `zstdFrameHasContentChecksum`,
    // the part that is genuinely platform-dependent, is covered on every OS by
    // the test above.
    it.skipIf(isWindows)("refuses to hand back a .tar.zst that carries no frame checksum", async () => {
      // A zstd whose build/version default leaves the checksum out. Shimmed
      // rather than waited for: the archive would decompress fine and corrupt
      // silently, which is precisely what must never ship as a bundle.
      const { createArchive, ZstdNoContentChecksumError } = await import("../src/archiver.js");
      const binDir = join(tempDir, "nocheck-bin");
      mkdirSyncFs(binDir, { recursive: true });
      const shim = join(binDir, "zstd");
      writeFileSync(
        shim,
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then echo "zstd 1.5.5-nocheck"; exit 0; fi',
          // magic FD2FB528 LE + a Frame_Header_Descriptor with bit 2 CLEAR
          'if [ "$1" = "-f" ]; then printf \'\\050\\265\\057\\375\\000\' > "$4"; cat "$2" >> "$4"; exit 0; fi',
          "exit 64",
          "",
        ].join("\n")
      );
      chmodSync(shim, 0o755);
      const pathHandle = prependPathInProcess(binDir);
      try {
        const out = join(tempDir, "nocheck-export.tar.zst");
        await expect(createArchive(sourceDir, out, "zstd")).rejects.toBeInstanceOf(
          ZstdNoContentChecksumError
        );
        // And it leaves nothing behind for a caller to mistake for a bundle.
        expect(existsSync(out)).toBe(false);
      } finally {
        pathHandle.restore();
      }
    });

    it("extraction of a checksum-less .tar.zst reports it instead of refusing it", async () => {
      const { createArchive, extractArchive, isZstdAvailable } = await import(
        "../src/archiver.js"
      );
      if (!(await isZstdAvailable())) return;
      // Built with --no-check directly: this is the shape of a bundle written
      // by some other tool, or by a zstd predating our create-side guard. The
      // content is separately covered by the manifest's own hashes, so the
      // right answer is to say so, not to stand between a user and their data.
      const staging = join(tempDir, "nc-src");
      mkdirSync(join(staging, "sessions"), { recursive: true });
      writeFileSync(join(staging, "manifest.json"), '{"version":1,"plugin":"sesh-mover"}');
      writeFileSync(join(staging, "sessions", "a.jsonl"), '{"type":"user"}\n');
      const plainTar = join(tempDir, "nc.tar");
      await tar.create({ file: plainTar, cwd: tempDir }, ["nc-src"]);
      const zst = join(tempDir, "nc.tar.zst");
      execFileSync("zstd", ["-f", "--no-check", plainTar, "-o", zst], { stdio: "ignore" });

      const warnings: string[] = [];
      const out = join(tempDir, "nc-out");
      mkdirSync(out, { recursive: true });
      await extractArchive(zst, out, warnings);
      expect(existsSync(join(out, "manifest.json"))).toBe(true);
      expect(warnings.some((w) => w.includes("without a zstd frame checksum"))).toBe(true);

      // A NORMAL archive says nothing — a warning that always fires is one
      // users learn to skim.
      const quiet: string[] = [];
      const normal = join(tempDir, "normal.tar.zst");
      await createArchive(staging, normal, "zstd");
      const out2 = join(tempDir, "normal-out");
      mkdirSync(out2, { recursive: true });
      await extractArchive(normal, out2, quiet);
      expect(quiet).toEqual([]);
    });
  });

  /**
   * What a hostile archive costs to merely LOOK at. `browse` is not an opt-in
   * for this — `/sesh-mover:import` runs it to build its picker — so the price
   * of reading metadata is the price of opening a menu, eight archives at a
   * time.
   *
   * The `.tar.gz` half is already covered for free by node-tar's own
   * `MAX_DECOMPRESSION_RATIO`. These are the two places nothing was covering:
   * the zstd CLI, which happily writes whatever a frame decodes to, and the
   * manifest itself, which used to be written to disk and only then measured.
   */
  describe("bounded decompression when reading archive metadata", () => {
    /**
     * Half a gigabyte of zeros, which the real zstd turns into ~16 KB — the
     * ratio measured on the bundle that prompted #32 (~32,000:1). Streamed
     * through zstd's stdin rather than compressed from a file, for two
     * reasons: nothing 512 MB wide ever touches the disk, and the resulting
     * frame carries NO declared content size, which is exactly the shape a
     * `zstd -l` pre-check cannot bound (see the header assertions below).
     */
    const BOMB_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

    async function writeZstdBomb(path: string): Promise<void> {
      const { spawn } = await import("node:child_process");
      const child = spawn("zstd", ["-f", "-o", path], { stdio: ["pipe", "ignore", "ignore"] });
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`zstd exited ${code} building the bomb`))
        );
      });
      const chunk = Buffer.alloc(8 * 1024 * 1024);
      for (let written = 0; written < BOMB_UNCOMPRESSED_BYTES; written += chunk.length) {
        if (!child.stdin.write(chunk)) {
          await new Promise((r) => child.stdin.once("drain", r));
        }
      }
      child.stdin.end();
      await done;
    }

    /** Bytes of real file content under `dir`, tolerant of files vanishing mid-walk. */
    function treeBytes(dir: string): number {
      let total = 0;
      let entries: ReturnType<typeof readdirSync>;
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as never;
      } catch {
        return 0; // raced with the scratch dir's own cleanup
      }
      for (const e of entries as unknown as { name: string; isDirectory(): boolean }[]) {
        const p = join(dir, e.name);
        try {
          total += e.isDirectory() ? treeBytes(p) : statSync(p).size;
        } catch {
          /* same race, one file down */
        }
      }
      return total;
    }

    /**
     * Run `work` while sampling how large `dir` gets. The whole defect is a
     * transient cost — 500 MB written and then deleted by the same call — so
     * an assertion made after the call returns would measure an empty
     * directory and pass against the bug.
     */
    async function peakWhile<T>(
      dir: string,
      work: () => Promise<T>
    ): Promise<{ result: T; peak: number }> {
      let peak = 0;
      let running = true;
      const sample = (): void => {
        peak = Math.max(peak, treeBytes(dir));
      };
      const watcher = (async () => {
        while (running) {
          sample();
          await new Promise((r) => setTimeout(r, 5));
        }
        sample();
      })();
      let result: T;
      try {
        result = await work();
      } finally {
        running = false;
        await watcher;
      }
      return { result, peak };
    }

    it("states the budget as a ratio with a floor", async () => {
      const { zstdDecompressionLimit } = await import("../src/archiver.js");
      // A tiny bundle is mostly tar padding and compresses to almost nothing,
      // so the floor is what keeps the ratio from refusing a legitimate one.
      expect(zstdDecompressionLimit(200)).toBe(1024 * 1024);
      // Above the floor it is 1000x the compressed size — deliberately the
      // same number node-tar's Parser enforces on the .tar.gz path, so what
      // `browse` will and won't open does not depend on the format it meets.
      expect(zstdDecompressionLimit(16 * 1024)).toBe(16 * 1024 * 1000);
    });

    it("refuses a zstd bomb during a metadata read instead of expanding it", async () => {
      const { readManifestFromArchive, isZstdAvailable, zstdDecompressionLimit } = await import(
        "../src/archiver.js"
      );
      if (!(await isZstdAvailable())) return; // no zstd on this runner — nothing to measure

      const bomb = join(tempDir, "bomb.tar.zst");
      await writeZstdBomb(bomb);
      const compressed = statSync(bomb).size;
      // It really is a bomb: 512 MB in, this many bytes out.
      expect(compressed).toBeLessThan(64 * 1024);

      // And it declares no decompressed size at all, which is why the bound
      // cannot be read out of the frame. Frame_Header_Descriptor (RFC 8878
      // §3.1.1.1): Frame_Content_Size_flag is bits 6-7, Single_Segment_flag is
      // bit 5. Both zero means the field is simply absent — measured, `zstd -l`
      // on such a frame prints an EMPTY Uncompressed column and exits 0, so a
      // pre-check would have read a blank and let this through.
      const head = readFileSync(bomb).subarray(0, 5);
      expect(head.readUInt32LE(0)).toBe(0xfd2fb528);
      expect(head[4] >> 6).toBe(0);
      expect(head[4] & 0x20).toBe(0);

      const tmpRoot = join(tempDir, "bomb-tmp");
      mkdirSync(tmpRoot, { recursive: true });
      let tmp: TmpOverrideHandle | undefined;
      try {
        tmp = overrideTmp(tmpRoot);
        expect(tmpdir()).toBe(tmpRoot); // positive control for the peak below
        const { result, peak } = await peakWhile(tmpRoot, () => readManifestFromArchive(bomb));

        // The existing degraded shape, not a throw: browse batches these, and
        // one rejection would take a whole listing down with it.
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("unreadable");
          expect(result.detail).toMatch(/expands to more than/i);
        }
        // The point of the exercise: the disk cost was never paid.
        expect(peak).toBeLessThanOrEqual(zstdDecompressionLimit(compressed));
        expect(peak).toBeLessThan(BOMB_UNCOMPRESSED_BYTES / 8);
        // ...and nothing was left behind holding what little was written.
        expect(readdirSync(tmpRoot)).toEqual([]);
      } finally {
        tmp?.restore();
      }
    });

    it("bounds the same decompression when the archive is explicitly unpacked", async () => {
      const { extractArchive, isZstdAvailable, zstdDecompressionLimit } = await import(
        "../src/archiver.js"
      );
      if (!(await isZstdAvailable())) return;
      // Import is a deliberate "unpack this", so it is lower-stakes than the
      // browse path — but it shares one decompressZstd with it, and the bound
      // is a ratio, so a real bundle never notices. Leaving this half unbounded
      // would mean two zstd invocations and only one of them guarded.
      const bomb = join(tempDir, "extract-bomb.tar.zst");
      await writeZstdBomb(bomb);
      const compressed = statSync(bomb).size;

      const tmpRoot = join(tempDir, "extract-bomb-tmp");
      mkdirSync(tmpRoot, { recursive: true });
      const out = join(tempDir, "extract-bomb-out");
      mkdirSync(out, { recursive: true });
      let tmp: TmpOverrideHandle | undefined;
      try {
        tmp = overrideTmp(tmpRoot);
        const { peak } = await peakWhile(tmpRoot, async () => {
          await expect(extractArchive(bomb, out)).rejects.toThrow(/expands to more than/i);
        });
        expect(peak).toBeLessThanOrEqual(zstdDecompressionLimit(compressed));
        expect(readdirSync(out)).toEqual([]);
        expect(readdirSync(tmpRoot)).toEqual([]);
      } finally {
        tmp?.restore();
      }
    });

    it("refuses an implausibly large manifest from its tar header, before writing it", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      // Format-independent, so this runs on a machine with no zstd: the
      // .tar.gz path is bounded in the aggregate by node-tar, but a manifest
      // inside that budget was still extracted to disk in full and only THEN
      // measured with statSync. A tar entry's declared size is not a hint —
      // it is exactly how many bytes the parser will hand over — so it can be
      // refused from the listing pass instead.
      const staging = join(tempDir, "fat-manifest");
      mkdirSync(staging, { recursive: true });
      const fat = {
        version: 1,
        plugin: "sesh-mover",
        sessions: [],
        padding: "x".repeat(2 * 1024 * 1024),
      };
      writeFileSync(join(staging, "manifest.json"), JSON.stringify(fat));
      const archive = join(tempDir, "fat-manifest.tar.gz");
      await createArchive(staging, archive, "gzip");

      const tmpRoot = join(tempDir, "fat-tmp");
      mkdirSync(tmpRoot, { recursive: true });
      let tmp: TmpOverrideHandle | undefined;
      try {
        tmp = overrideTmp(tmpRoot);
        const { result, peak } = await peakWhile(tmpRoot, () => readManifestFromArchive(archive));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("unreadable");
          expect(result.detail).toMatch(/implausibly large/i);
        }
        expect(peak).toBeLessThan(1024 * 1024);
      } finally {
        tmp?.restore();
      }
    });
  });

  describe("pre-extraction validation", () => {
    it("rejects a tar containing parent-traversal entries before writing anything", async () => {
      const { extractArchive } = await import("../src/archiver.js");
      // Craft a malicious tar: entry path "../escaped.txt"
      const outer = join(tempDir, "mal");
      const inner = join(outer, "inner");
      mkdirSync(inner, { recursive: true });
      writeFileSync(join(outer, "escaped.txt"), "boom");
      const malPath = join(tempDir, "malicious.tar.gz");
      await tar.create(
        { gzip: true, file: malPath, cwd: inner, preservePaths: true },
        ["../escaped.txt"]
      );

      const extractDir = join(tempDir, "mal-extract");
      mkdirSync(extractDir);
      await expect(extractArchive(malPath, extractDir)).rejects.toThrow(/unsafe archive entries/i);
      // Nothing extracted at all
      const { readdirSync } = await import("node:fs");
      expect(readdirSync(extractDir)).toHaveLength(0);
    });

    it("rejects a tar containing symlink entries", async () => {
      const { extractArchive } = await import("../src/archiver.js");
      const linkSrc = join(tempDir, "linksrc");
      mkdirSync(linkSrc, { recursive: true });
      writeFileSync(join(linkSrc, "ok.txt"), "fine");
      symlinkSync("/etc", join(linkSrc, "evil-link"));
      const linkTar = join(tempDir, "link.tar.gz");
      await tar.create({ gzip: true, file: linkTar, cwd: tempDir }, ["linksrc"]);

      const extractDir = join(tempDir, "link-extract");
      mkdirSync(extractDir);
      await expect(extractArchive(linkTar, extractDir)).rejects.toThrow(/unsafe archive entries/i);
    });
  });

  describe("readManifestFromArchive", () => {
    it("reads the manifest out of a .tar.gz without unpacking session content", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        // Build a realistic bundle staging dir: manifest.json + sessions/<id>.jsonl
        const staging = join(dir, "my-export");
        mkdirSync(join(staging, "sessions"), { recursive: true });
        const manifest = {
          version: 1, plugin: "sesh-mover", exportedAt: "2026-07-25T18:30:48.718Z",
          sourcePlatform: "wsl2", sourceProjectPath: "/mnt/e/GitHub/x/y",
          sourceConfigDir: "/home/u/.claude", sourceClaudeVersion: "2.1.81",
          sessionScope: "current", includedLayers: ["jsonl"],
          sessions: [{
            sessionId: "550e8400-e29b-41d4-a716-446655440000", slug: "s", summary: "sum",
            lastActiveAt: "2026-07-25T18:00:00Z", messageCount: 42,
            gitBranch: "main", entrypoint: "cli", integrityHash: "sha256:abc",
          }],
        };
        writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
        writeFileSync(join(staging, "sessions", "550e8400-e29b-41d4-a716-446655440000.jsonl"), '{"uuid":"a"}\n');
        const archive = join(dir, "my-export.tar.gz");
        await createArchive(staging, archive, "gzip");

        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.manifest.sourcePlatform).toBe("wsl2");
        expect(r.manifest.sourceProjectPath).toBe("/mnt/e/GitHub/x/y");
        expect(r.manifest.exportedAt).toBe("2026-07-25T18:30:48.718Z");
        expect(r.manifest.sessions).toHaveLength(1);
        expect(r.manifest.sessions[0].messageCount).toBe(42);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("ignores a nested manifest.json and only reads the bundle-root one", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        const staging = join(dir, "nested-export");
        mkdirSync(join(staging, "sessions", "deep"), { recursive: true });
        const base = {
          version: 1, plugin: "sesh-mover", exportedAt: "2026-07-25T18:30:48.718Z",
          sourceConfigDir: "/c", sourceClaudeVersion: "2.1.81",
          sessionScope: "current", includedLayers: ["jsonl"], sessions: [],
        };
        writeFileSync(
          join(staging, "manifest.json"),
          JSON.stringify({ ...base, sourcePlatform: "wsl2", sourceProjectPath: "/root/one" })
        );
        writeFileSync(
          join(staging, "sessions", "deep", "manifest.json"),
          JSON.stringify({ ...base, sourcePlatform: "win32", sourceProjectPath: "C:\\decoy" })
        );
        const archive = join(dir, "nested-export.tar.gz");
        await createArchive(staging, archive, "gzip");

        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.manifest.sourcePlatform).toBe("wsl2");
        expect(r.manifest.sourceProjectPath).toBe("/root/one");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("reports unreadable for a corrupt archive instead of throwing", async () => {
      const { readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        const bogus = join(dir, "bogus.tar.gz");
        writeFileSync(bogus, "definitely not a tar archive");
        const r = await readManifestFromArchive(bogus);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(["unreadable", "no-manifest"]).toContain(r.reason);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("reports no-manifest for an archive that has none", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        const staging = join(dir, "empty-export");
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "readme.txt"), "no manifest here\n");
        const archive = join(dir, "empty-export.tar.gz");
        await createArchive(staging, archive, "gzip");
        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("no-manifest");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("reports unreadable for a name that isn't a recognized archive", async () => {
      const { readManifestFromArchive } = await import("../src/archiver.js");
      const r = await readManifestFromArchive(join(tempDir, "not-an-archive"));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("unreadable");
    });

    it("rejects a manifest carrying an unsafe session id (0.3.2 chokepoint)", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        const staging = join(dir, "hostile");
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "manifest.json"), JSON.stringify({
          version: 1, plugin: "sesh-mover", exportedAt: "t", sourcePlatform: "linux",
          sourceProjectPath: "/x", sourceConfigDir: "/y", sourceClaudeVersion: "1",
          sessionScope: "current", includedLayers: [],
          sessions: [{ sessionId: "../../../etc/passwd", slug: "s", summary: "",
            lastActiveAt: "t", messageCount: 1, gitBranch: "m", entrypoint: "cli", integrityHash: "sha256:x" }],
        }));
        const archive = join(dir, "hostile.tar.gz");
        await createArchive(staging, archive, "gzip");
        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe("unsafe-manifest");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("degrades a wrong-shaped manifest instead of reporting a fabricated session count", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        // `sessions` is a string, not an array. Without a shape guard this
        // parses fine, survives assertSafeManifestIds (iterating a string
        // yields chars, whose .sessionId is undefined), and browse then
        // reports sessionCount: 3 — "abc".length — as if it were real.
        const staging = join(dir, "shapeless");
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "manifest.json"), JSON.stringify({
          version: 1, plugin: "sesh-mover", exportedAt: "t", sourcePlatform: "linux",
          sourceProjectPath: "/x", sourceConfigDir: "/y", sourceClaudeVersion: "1",
          sessionScope: "current", includedLayers: [], sessions: "abc",
        }));
        const archive = join(dir, "shapeless.tar.gz");
        await createArchive(staging, archive, "gzip");
        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason).toBe("unreadable");
          expect(r.detail).toMatch(/sesh-mover bundle manifest/i);
        }

        // Same for a JSON document that simply isn't a bundle manifest.
        const other = join(dir, "notours");
        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, "manifest.json"), JSON.stringify({ some: "other tool" }));
        const otherArchive = join(dir, "notours.tar.gz");
        await createArchive(other, otherArchive, "gzip");
        const r2 = await readManifestFromArchive(otherArchive);
        expect(r2.ok).toBe(false);
        if (!r2.ok) expect(r2.reason).toBe("unreadable");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("reads a .tar.zst manifest when zstd is available, else reports no-zstd", async () => {
      const { createArchive, readManifestFromArchive, isZstdAvailable } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      try {
        const archive = join(dir, "z-export.tar.zst");
        if (await isZstdAvailable()) {
          const staging = join(dir, "z-export");
          mkdirSync(join(staging, "sessions"), { recursive: true });
          writeFileSync(join(staging, "manifest.json"), JSON.stringify({
            version: 1, plugin: "sesh-mover", exportedAt: "2026-07-25T18:30:48.718Z",
            sourcePlatform: "wsl2", sourceProjectPath: "/mnt/e/GitHub/x/y",
            sourceConfigDir: "/home/u/.claude", sourceClaudeVersion: "2.1.81",
            sessionScope: "current", includedLayers: ["jsonl"], sessions: [],
          }));
          writeFileSync(join(staging, "sessions", "a.jsonl"), '{"uuid":"a"}\n');
          // createArchive("zstd") shells out to zstd unconditionally — the
          // gzip fallback lives in cli.ts, not here — so only call it when
          // zstd really exists.
          await createArchive(staging, archive, "zstd");
          const r = await readManifestFromArchive(archive);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.manifest.sourcePlatform).toBe("wsl2");
          expect(r.manifest.sourceProjectPath).toBe("/mnt/e/GitHub/x/y");
        } else {
          writeFileSync(archive, "opaque zstd bytes we cannot decode");
          const r = await readManifestFromArchive(archive);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.reason).toBe("no-zstd");
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it("contains a scratch-dir allocation failure as a typed result instead of throwing", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      // overrideTmp, not a bare TMPDIR assignment: os.tmpdir() reads TEMP/TMP
      // on Windows and ignores TMPDIR entirely, so a one-variable override
      // leaves the temp root perfectly usable there and this test asserts
      // ok === false against a read that quietly succeeded.
      let tmp: TmpOverrideHandle | undefined;
      try {
        const staging = join(dir, "fine-export");
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "manifest.json"), JSON.stringify({
          version: 1, plugin: "sesh-mover", exportedAt: "2026-07-25T18:30:48.718Z",
          sourcePlatform: "wsl2", sourceProjectPath: "/mnt/e/x",
          sourceConfigDir: "/c", sourceClaudeVersion: "2.1.81",
          sessionScope: "current", includedLayers: ["jsonl"], sessions: [],
        }));
        const archive = join(dir, "fine-export.tar.gz");
        await createArchive(staging, archive, "gzip");

        // A real resource failure, not a corrupt archive: the process temp
        // root doesn't exist, so mkdtempSync throws ENOENT. That used to
        // escape as a rejection because the allocation sat outside the try —
        // which, under Promise.all, failed the caller's ENTIRE listing.
        tmp = overrideTmp(join(dir, "no-such-temp-root"));
        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason).toBe("unreadable");
          expect(r.detail).toMatch(/ENOENT|no such file/i);
        }

        // ...and the very next call succeeds once the temp root is usable
        // again: the failure is per-call, not sticky.
        tmp.restore();
        tmp = undefined;
        const again = await readManifestFromArchive(archive);
        expect(again.ok).toBe(true);
      } finally {
        tmp?.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("leaves no scratch dir behind on success or failure", async () => {
      const { createArchive, readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      // Must override TEMP/TMP as well as TMPDIR: on Windows a TMPDIR-only
      // override sends the reads to the real system temp dir, and scanning
      // our own untouched tmpRoot for leftovers would pass vacuously.
      let tmp: TmpOverrideHandle | undefined;
      try {
        const staging = join(dir, "clean-export");
        mkdirSync(staging, { recursive: true });
        writeFileSync(join(staging, "manifest.json"), JSON.stringify({
          version: 1, plugin: "sesh-mover", exportedAt: "t", sourcePlatform: "linux",
          sourceProjectPath: "/x", sourceConfigDir: "/y", sourceClaudeVersion: "1",
          sessionScope: "current", includedLayers: [], sessions: [],
        }));
        const good = join(dir, "clean-export.tar.gz");
        await createArchive(staging, good, "gzip");
        const bad = join(dir, "corrupt.tar.gz");
        writeFileSync(bad, "not a tar");

        const tmpRoot = join(dir, "tmproot");
        mkdirSync(tmpRoot, { recursive: true });
        tmp = overrideTmp(tmpRoot);
        // Positive control for the assertion below: prove the reads actually
        // allocate inside tmpRoot on THIS platform before concluding anything
        // from it being empty afterwards.
        expect(tmpdir()).toBe(tmpRoot);

        expect((await readManifestFromArchive(good)).ok).toBe(true);
        expect((await readManifestFromArchive(bad)).ok).toBe(false);

        const leaked = readdirSync(tmpRoot).filter((n) => n.startsWith("sesh-manifest-"));
        expect(leaked).toEqual([]);
      } finally {
        tmp?.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports no-zstd for a .tar.zst when zstd is off PATH", async () => {
      const { readManifestFromArchive } = await import("../src/archiver.js");
      const dir = mkdtempSync(join(tmpdir(), "sesh-rma-"));
      // Deterministic coverage of the no-zstd branch even on machines that
      // do have zstd installed.
      const pathHandle = overridePath(join(dir, "no-such-bin"));
      try {
        const archive = join(dir, "z-export.tar.zst");
        writeFileSync(archive, "opaque zstd bytes");
        const r = await readManifestFromArchive(archive);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.reason).toBe("no-zstd");
          expect(r.detail).toMatch(/zstd/i);
        }
      } finally {
        pathHandle.restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
