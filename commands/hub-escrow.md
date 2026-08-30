---
name: hub-escrow
description: Write, report or forget a passphrase-wrapped escrow of this machine's own hub identity key
---

You are running the sesh-mover hub escrow command. It answers one question: **this machine's disk died and its `~/.sesh-mover/identity.age` went with it — how does anyone ever read the bundles it pushed?** An escrow is a passphrase-wrapped copy of *this machine's own* identity key, written to a path the user names. It is **off by default**, it changes nothing about how bundles are written or read, and a user who never asks for one never meets it.

It is deliberately **not** a hub verb in the usual sense: it does not require a configured hub, because it is about a machine's key rather than about a hub. The hub path is looked up only so the `--out` check can refuse a destination inside it.

Follow these steps:

1. **Never ask the user for the passphrase in this conversation, and never run the enable yourself with a passphrase in the command line.** This is a prohibition, not a preference. A passphrase typed into a Claude Code session is written into that session's JSONL, which the default-on SessionEnd auto-push then uploads to the hub — encrypted to a key that very passphrase unwraps. `browse --prune` delegating its prompt to this layer is **not** a precedent for it: that prompt collects nothing secret. So when the user wants to enable an escrow, **print this line and have them run it in their own shell**, and stop:
   ```
   read -rs SESH_ESCROW && printf '%s' "$SESH_ESCROW" | sesh-mover hub escrow --enable --passphrase-stdin --out <path>
   ```
   There is no flag and no config key for the passphrase, and that is by design: a flag lands in shell history, a config file sits in plaintext beside the thing it protects, and an environment variable leaks through `/proc/<pid>/environ` **and** is inherited by every subprocess this plugin spawns — including the `git` it runs on user data, since `gitChildEnv()` scrubs `GIT_*` and would pass anything else straight through to git, its credential helper and its hooks. Stdin, once, and nothing else.

2. Read the current state. This is safe at any time, collects no passphrase, and writes nothing:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub escrow --project-path "<cwd>" --source-config-dir "<config-dir>"
   ```

3. **Say all of this before the user creates one.** Each is something they will otherwise assume the opposite of, and none of it may be softened here or anywhere else.
   - **The passphrase unwraps this machine's identity, which unwraps every hub bundle addressed to this machine — past and future — forever, for anyone who learns it.**
   - **A leak cannot be revoked.** `hub rekey` re-addresses bundles to a new roster but never changes a file key, so every bundle a leaked key could already read stays readable by it permanently. There is no command in this plugin, and none in `age`, that takes that back.
   - **RECOVERY ONLY.** Restoring the escrow on a rebuilt machine restores **that machine's own** identity, so no key moves anywhere and the per-machine design is intact. Using it to give a **different** machine access does move a key: it collapses two machines into one identity, so revoking either means revoking both, and per-machine revocation is the whole reason the identities are per-machine. If what the user actually wants is for a new machine to read old history, that is **`/sesh-mover:hub-rekey`**, which backfills access without moving a key — offer it by name.
   - **It gives up the design's "no private key is ever transported" property**, and that is the whole of the trade. It buys one thing in return: key loss stops being permanent.
   - Nothing is uploaded and nothing on the hub changes. The escrow is a local file, and keeping it safe becomes entirely the user's problem.

4. Choose `--out` with them, and be honest about what the check does. The destination is refused outright — nothing is written — when it is inside the configured hub directory, inside a sesh-mover project (or the project this command ran for), inside a git work tree, under a directory that looks like a cloud-sync folder, when the containing directory does not exist, or when a file is already there. The parent directory is `realpath`'d first, so a symlink pointing into a repository cannot slip past. **There is no override flag and you must not go looking for one** — a false positive is worked around by writing somewhere else and moving the file by hand, which is what keeps the refusal meaningful.

   **State the limit every time you mention the check, and never imply it away:** it matches directory **names**, sync-client marker files, git work trees, sesh-mover projects and the configured hub directory — and nothing else. It **cannot** tell that the user's home directory, or any parent of it, is itself a synced folder, a network mount, a backup target or a shared volume. It is a guard against the obvious mistake, not a guarantee. The `limits` array carries this on **every** result, success and refusal alike, deliberately: a refusal that fires makes the check look more capable than it is, which is exactly the moment a user concludes the next destination must be safe. Relay it on successes too.

5. Also tell them what the passphrase itself has to be, because these are refusals rather than corrections: exactly **one trailing newline is stripped** (so `printf '%s'` and `echo` produce the same key, and it matches what `age` does with what is typed at its own prompt); a line break **in the middle** is refused, because it could never be typed back at that prompt and the escrow would be unrecoverable by the one tool recovery has; an **empty** passphrase is refused, since that is not a weak escrow but a public one; and stdin being a **terminal** is refused rather than read, because reading would echo the passphrase into the scrollback.

6. Read the result of a status or an enable. The fields, and what each is an answer to:
   - `action` — `status`, `enabled` or `disabled`.
   - `enabled` — an escrow is **recorded** on this machine. `false` is the default state and not a problem.
   - `escrowPath` — where the escrow was written. A path the user typed.
   - `recipient` — the **public** half (`age1…`) the escrowed identity corresponds to. No field in this result ever carries the passphrase or any secret key material.
   - `createdAt`, `workFactorLogN` — when it was made, and at what scrypt work factor (18 unless a test set otherwise).
   - `filePresent` — a file exists at `escrowPath` right now.
   - `fileLooksLikeEscrow` — that file **begins like** a passphrase-addressed age file. A **shape check only**: it cannot tell whether the escrow still opens, which needs the passphrase, and no read-only path collects one. Never report it as "your escrow works".
   - `current` — the escrow is for the identity this machine holds **now**; `null` when there is no escrow or no readable identity to compare against. A `false` here is the one thing a user cannot see by looking at the file: restoring it would restore the *old* identity.
   - `recovery` — the exact `age` commands that use this escrow, with the real paths already filled in. Prefer relaying these over retyping the forms in step 7: they are spelled once in the code so the CLI and this file cannot drift into telling a user two different things at the moment they cannot check.
   - `warnings` — relay verbatim, all of them.
   - `limits` — step 4. Relay on every result.

7. Tell them how recovery actually works, and note that it needs **nothing from this plugin** — that is the point of the wire format being age's, and it is why a recovery step is not a `sesh-mover` command:
   ```
   age -d -i <escrow file> <bundle>.tar.gz.age > <bundle>.tar.gz     # read a bundle directly
   age -d <escrow file> > ~/.sesh-mover/identity.age && chmod 600 ~/.sesh-mover/identity.age   # restore this machine's identity
   ```
   `age` accepts a passphrase-encrypted file as an identity file, so the first form prompts for the passphrase and decrypts in one step. Key loss and plugin loss must not be the same event as session loss.

8. Turning it off:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub escrow --disable --project-path "<cwd>" --source-config-dir "<config-dir>"
   ```
   **This forgets the record. It does not delete the escrow file, and that is deliberate** — the path was recorded once, and the file sitting there now may not be the one this plugin wrote. Say plainly that the file is still at the reported path and still unwraps this machine's identity for anyone with the passphrase, and that deleting it is theirs to do, deliberately. `--enable` and `--disable` are mutually exclusive.

9. Refusals. Branch on `reason`/`refusal`, never on the prose:
   - `reason: "escrow-refused"` — understood and declined; **nothing was written**. The `refusal` sub-discriminator says which:
     - `no-identity` — this machine has no identity to escrow (`absent`: it is minted the first time the machine registers on a hub, so run `hub init` or one push or pull first), or its identity file cannot be read. Escrowing is a copy: copying an unreadable key would produce an unreadable escrow, and nothing here overwrites or replaces that file.
     - `no-out` — `--out` was missing. There is no default, on purpose: a default would put a passphrase-wrapped private key somewhere the user did not choose, and the point of an escrow is that it lives where this machine's own disk failure does not reach.
     - `unsafe-out` — the destination was refused. `unsafeOut.rule` is which one (`no-parent-directory`, `exists`, `inside-hub`, `inside-project`, `inside-git-work-tree`, `looks-synced`) and `unsafeOut.path` is the resolved path. Relay the `suggestion`, and restate the limit from step 4 — a refusal is the moment that matters most.
     - `passphrase` — `--passphrase-stdin` was not passed, stdin was a terminal, the passphrase was empty, or it contained a line break. **Do not respond by asking for the passphrase here.** Re-print the shell line from step 1.
     - `not-enabled` — `--disable` with no escrow recorded. Nothing to turn off.
   - `reason: "escrow-verify-failed"` — the escrow was written, was read back through the real reader, did not match, and **was removed**. This is an internal failure rather than a refusal, and it has its own class because it is the one failure that would otherwise reach the user during a recovery as "my passphrase doesn't work", at the single moment there is no other copy of the key. Report `error` and `suggestion` and offer to try again; do not tell the user they have an escrow.

10. Two things not to overstate. The read-back check proves the file this machine just wrote decrypts to the identity it copied — it does **not** prove correctness against `age` itself, because a defect symmetric in this plugin's own code survives a self-round-trip; that is what the differential tests against the real `age` binary are for. And **nothing on the bundle path changed**: `push`, `pull`, `rekey`, `retire` and `reindex` do not know this file exists, and **no bundle is ever addressed to a passphrase** — the age spec forbids mixing a passphrase stanza with recipient stanzas, and both sides of the implementation enforce that, so a mixed bundle cannot be produced here and would not be accepted here.

**Exit codes:** keep branching on the parsed JSON, not on `$?` — every branch above is decided from the body. `0` a status report, a successful enable, or a successful disable. `1` a bad invocation (`--enable` together with `--disable`), an unexpected failure, or the `escrow-verify-failed` case — the escrow was written, did not read back, and was removed. `2` every `escrow-refused` refusal: understood, declined, nothing written. This verb never returns the retryable class `3` — it does not need the hub to be reachable. See "Exit Codes" in the skill doc for the full four-class table.

**Invocation:** `${CLAUDE_PLUGIN_ROOT}` is set by Claude Code inside plugin command execution — use it as-is in the bash invocations above; do not search the plugin cache. The flag set documented in this file (`--enable`, `--disable`, `--out`, `--passphrase-stdin`, `--project-path`, `--source-config-dir`) is authoritative — do not run the CLI with `--help` or with no arguments to discover its surface. The one invocation you must **not** run yourself is the `--enable` one: it is printed for the user to run in their own shell, for the reason in step 1.
