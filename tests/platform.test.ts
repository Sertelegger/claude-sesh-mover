import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  describe("encodeProjectPath", () => {
    it("encodes Unix path to directory name", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      expect(encodeProjectPath("/Users/sascha/Projects/foo")).toBe(
        "-Users-sascha-Projects-foo"
      );
    });

    it("encodes root path", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      expect(encodeProjectPath("/Users/sascha")).toBe("-Users-sascha");
    });

    it("encodes Windows path with drive letter", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      expect(encodeProjectPath("C:\\Users\\sascha\\Projects\\foo")).toBe(
        "C-Users-sascha-Projects-foo"
      );
    });

    it("encodes paths with hyphens (one-way, lossy)", async () => {
      const { encodeProjectPath } = await import("../src/platform.js");
      // This is intentionally lossy — hyphens in path components merge with separators
      expect(encodeProjectPath("/Users/sascha/Projects/tzun-sdk")).toBe(
        "-Users-sascha-Projects-tzun-sdk"
      );
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
