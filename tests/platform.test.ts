import { describe, it, expect, beforeEach } from "vitest";
import type { Platform } from "../src/types.js";

// We'll test the exported functions after creating them
// For now, define the test structure

describe("platform detection", () => {
  describe("detectPlatform", () => {
    it("returns darwin on macOS", async () => {
      const { detectPlatform } = await import("../src/platform.js");
      // On the current machine (macOS), this should return darwin
      if (process.platform === "darwin") {
        expect(detectPlatform()).toBe("darwin");
      }
    });

    it("returns win32 on Windows", async () => {
      const { detectPlatform } = await import("../src/platform.js");
      if (process.platform === "win32") {
        expect(detectPlatform()).toBe("win32");
      }
    });

    it("returns a valid Platform value", async () => {
      const { detectPlatform } = await import("../src/platform.js");
      const result = detectPlatform();
      expect(["darwin", "linux", "wsl1", "wsl2", "win32"]).toContain(result);
    });
  });

  describe("translatePath", () => {
    let translatePath: typeof import("../src/platform.js").translatePath;

    beforeEach(async () => {
      const mod = await import("../src/platform.js");
      translatePath = mod.translatePath;
    });

    it("translates WSL home path to Windows path", () => {
      const result = translatePath(
        "/home/sascha/Projects/foo",
        "wsl2",
        "win32",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("C:\\Users\\sascha\\Projects\\foo");
    });

    it("translates darwin /Users home path to Windows path", () => {
      const result = translatePath(
        "/Users/sascha/Projects/foo",
        "darwin",
        "win32",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("C:\\Users\\sascha\\Projects\\foo");
    });

    it("translates WSL /mnt/d/ path to Windows D:\\ path", () => {
      const result = translatePath(
        "/mnt/d/repos/project",
        "wsl2",
        "win32",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("D:\\repos\\project");
    });

    it("translates Windows path to WSL path", () => {
      const result = translatePath(
        "C:\\Users\\sascha\\Projects\\foo",
        "win32",
        "wsl2",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("/home/sascha/Projects/foo");
    });

    it("translates Windows D:\\ path to WSL /mnt/d/ path", () => {
      const result = translatePath(
        "D:\\repos\\project",
        "win32",
        "wsl2",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("/mnt/d/repos/project");
    });

    it("handles username mapping between platforms", () => {
      const result = translatePath(
        "/home/sascha/Projects/foo",
        "wsl2",
        "win32",
        { sourceUser: "sascha", targetUser: "saschadev" }
      );
      expect(result).toBe("C:\\Users\\saschadev\\Projects\\foo");
    });

    it("translates same-platform path substitution", () => {
      const result = translatePath(
        "/Users/sascha/old-project",
        "darwin",
        "darwin",
        {
          sourceUser: "sascha",
          targetUser: "sascha",
          sourceProjectPath: "/Users/sascha/old-project",
          targetProjectPath: "/Users/sascha/Projects/new-project",
        }
      );
      expect(result).toBe("/Users/sascha/Projects/new-project");
    });

    it("handles same-platform with different usernames", () => {
      const result = translatePath(
        "/home/olduser/project",
        "linux",
        "linux",
        {
          sourceUser: "olduser",
          targetUser: "newuser",
          sourceProjectPath: "/home/olduser/project",
          targetProjectPath: "/home/newuser/project",
        }
      );
      expect(result).toBe("/home/newuser/project");
    });

    it("translates WSL /tmp/ to Windows temp path", () => {
      const result = translatePath(
        "/tmp/somefile",
        "wsl2",
        "win32",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe(
        "C:\\Users\\sascha\\AppData\\Local\\Temp\\somefile"
      );
    });

    it("returns path unchanged when no translation applies", () => {
      const result = translatePath(
        "/usr/local/bin/tool",
        "linux",
        "linux",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("/usr/local/bin/tool");
    });
  });

  /**
   * #126 — these pin sesh-mover's encoder against CLAUDE CODE's, not against
   * itself. The four cases that lived here until 0.12.0 were all paths where
   * the old rule and Claude Code's agree, which is exactly why a divergence
   * affecting every path containing `.`, `_` or a space shipped and stayed.
   * Keep at least one case per character class below, and keep the live check.
   */
  describe("encodeProjectPath", () => {
    it("encodes a plain Unix path", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      expect(encodeProjectPath("/Users/sascha/Projects/foo")).toBe("-Users-sascha-Projects-foo");
      expect(encodeProjectPath("/Users/sascha")).toBe("-Users-sascha");
    });

    /**
     * The class the old encoder got wrong. Each of these produced a directory
     * Claude Code never reads, while `import` reported success.
     */
    it("replaces EVERY non-alphanumeric, not just the separator", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      // A dot — the case found on disk: `/home/dev/.claude-mem/observer-sessions`
      // really does live under a DOUBLE dash.
      expect(encodeProjectPath("/home/dev/.claude-mem/observer-sessions")).toBe(
        "-home-dev--claude-mem-observer-sessions"
      );
      expect(encodeProjectPath("/home/dev/repos/my_project")).toBe("-home-dev-repos-my-project");
      expect(encodeProjectPath("/home/dev/repos/site.com")).toBe("-home-dev-repos-site-com");
      expect(encodeProjectPath("/home/dev/repos/my project")).toBe("-home-dev-repos-my-project");
      expect(encodeProjectPath("/home/dev/repos/v1.2.3")).toBe("-home-dev-repos-v1-2-3");
    });

    /**
     * BOTH the drive colon and the separator become dashes — `C--Users-…`, not
     * `C-Users-…`. The rule is read verbatim out of the linux-x64 embedded JS;
     * what string reaches the encoder on win32 is not directly observable from
     * here, which is what the live check below is for.
     */
    it("encodes a Windows drive path with both the colon and the separator", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      expect(encodeProjectPath("C:\\Users\\sascha\\Projects\\foo")).toBe(
        "C--Users-sascha-Projects-foo"
      );
    });

    it("is one-way: a hyphen in a component is indistinguishable from a separator", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      expect(encodeProjectPath("/Users/sascha/Projects/tzun-sdk")).toBe(
        "-Users-sascha-Projects-tzun-sdk"
      );
    });

    /**
     * Over 200 characters, Claude Code truncates and appends a base36 hash OF
     * THE RAW PATH. Three ways to get this subtly wrong, each pinned here.
     */
    it("caps at 200 characters and appends the hash of the RAW path", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      const long = "/home/dev/repos/" + "a".repeat(200) + "/deep";
      const out = encodeProjectPath(long);
      expect(out.length).toBe(207); // 200 + "-" + 6-char suffix
      expect(out.slice(0, 200)).toBe(long.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200));
      // Hashing the SANITIZED string instead of the raw one is the natural
      // mistake and silently changes the suffix on every capped path.
      expect(out.endsWith("-cleylq")).toBe(true);
    });

    /**
     * The hash can land on exactly INT32_MIN, whose `Math.abs` leaves int32.
     * Re-coercing with `| 0` hands back the negative and the name grows a stray
     * dash — `-zik0zk` instead of `zik0zk`. Reachable, not theoretical.
     */
    it("does not re-coerce Math.abs, so an INT32_MIN hash has no stray dash", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      const v = "/home/dev/repos/" + "deep/".repeat(40) + "begaknul";
      const out = encodeProjectPath(v);
      expect(out.endsWith("-zik0zk")).toBe(true);
      expect(out.endsWith("--zik0zk")).toBe(false);
    });

    /**
     * THE CHECK THAT WOULD HAVE CAUGHT US. Everything above is sesh-mover
     * agreeing with a rule someone read out of a bundle; this is sesh-mover
     * agreeing with directories Claude Code actually created.
     *
     * Keyed on the FIRST conversation entry's `cwd`, because that is what
     * Claude Code keys the directory on — a mid-session `cd` changes later
     * entries' `cwd` and encodes to a different name. Skips cleanly when there
     * is no config dir to read, so it is a no-op in CI containers.
     */
    it("reproduces the directory names Claude Code actually created on this machine", async (ctx) => {
      const { encodeProjectPath } = await import("../src/platform.js");
      const { readdirSync, readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");

      const roots = [".claude", ".claude-nv", ".claude-nfg"]
        .map((d) => join(homedir(), d, "projects"))
        .filter((d) => existsSync(d));
      if (roots.length === 0) {
        // SKIP, not silently pass. A CI runner has no Claude config dir, so an
        // early `return` here made this the most important assertion in the
        // file report green without checking anything — and on the Windows job
        // that is the ONLY thing that could settle whether the encoder sees a
        // native path. A vacuous pass reading as a verification is exactly the
        // failure this repo's "a green suite is not evidence" rule names.
        ctx.skip();
        return;
      }

      let checked = 0;
      const mismatches: string[] = [];
      for (const root of roots) {
        for (const dir of readdirSync(root)) {
          const files = readdirSync(join(root, dir)).filter((f) => f.endsWith(".jsonl"));
          if (files.length === 0) continue;
          let cwd: string | null = null;
          for (const line of readFileSync(join(root, dir, files[0]), "utf-8").split("\n").slice(0, 60)) {
            if (!line.trim()) continue;
            try {
              const o = JSON.parse(line) as { cwd?: unknown; uuid?: unknown };
              if (typeof o.uuid === "string" && o.uuid !== "" && typeof o.cwd === "string") {
                cwd = o.cwd;
                break;
              }
            } catch {
              /* a torn or non-JSON line proves nothing about the encoder */
            }
          }
          if (cwd === null) continue;
          checked++;
          if (encodeProjectPath(cwd) !== dir) mismatches.push(`${cwd} -> ${encodeProjectPath(cwd)} (on disk: ${dir})`);
        }
      }
      expect(mismatches, `checked ${checked} real project directories`).toEqual([]);
    });
  });

  describe("path encoding is one-way", () => {
    it("no decodeProjectPath exists — encoding is lossy for hyphenated paths", async () => {
      const platform = await import("../src/platform.js");
      expect("decodeProjectPath" in platform).toBe(false);
    });
  });

  describe("translatePath with special characters", () => {
    let translatePath: typeof import("../src/platform.js").translatePath;

    beforeEach(async () => {
      const mod = await import("../src/platform.js");
      translatePath = mod.translatePath;
    });

    it("handles paths with spaces", () => {
      const result = translatePath(
        "/home/sascha/My Projects/foo bar",
        "wsl2",
        "win32",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("C:\\Users\\sascha\\My Projects\\foo bar");
    });

    it("handles Windows Program Files path", () => {
      const result = translatePath(
        "C:\\Program Files (x86)\\MyApp",
        "win32",
        "wsl2",
        { sourceUser: "sascha", targetUser: "sascha" }
      );
      expect(result).toBe("/mnt/c/Program Files (x86)/MyApp");
    });
  });

  describe("resolveConfigDir", () => {
    it("uses explicit flag over env var", async () => {
      const { resolveConfigDir } = await import("../src/platform.js");
      const result = resolveConfigDir("/explicit/path", "/env/path");
      expect(result).toBe("/explicit/path");
    });

    it("uses env var when no explicit flag", async () => {
      const { resolveConfigDir } = await import("../src/platform.js");
      const result = resolveConfigDir(undefined, "/env/path");
      expect(result).toBe("/env/path");
    });

    it("falls back to ~/.claude when nothing specified", async () => {
      const { resolveConfigDir } = await import("../src/platform.js");
      const saved = process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CLAUDE_CONFIG_DIR;
      try {
        const result = resolveConfigDir(undefined, undefined);
        expect(result).toMatch(/\.claude$/);
      } finally {
        if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
      }
    });
  });
});
