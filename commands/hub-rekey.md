---
name: hub-rekey
description: Re-address this machine's own encrypted hub bundles to every machine registered on the hub now
---

You are running the sesh-mover hub rekey command. It answers one question: **a machine joined the hub and cannot read anything older than itself — how does it get the history?**

An encrypted bundle is addressed to a fixed set of machines at the moment it is written, so a machine that joins later receives every *later* push and none of the earlier ones. This command has each machine re-address **its own** bundles to the hub's roster as it stands now. It decrypts nothing: it replaces each file's header and copies the payload untouched, so it is cheap even on a large hub.

Follow these steps:

1. Run it **on the machine whose history is missing** — not on the machine that cannot read it. This is the part users get backwards. Machine A re-wraps A's bundles; nobody can re-wrap anybody else's, because a machine only ever writes its own files on the hub and only its own key opens them.
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub rekey --project-path "<cwd>" --source-config-dir "<config-dir>"
   ```
   It is **per project and per machine**. Rekeying the whole hub is running it once per project on every machine that ever pushed. There is no flag: the recipient set is the hub's roster and there is nothing to choose.

2. It is safe to run at any time and safe to run twice. Running it again is running it once — nothing accumulates, and a run that fails part-way is fixed by running it again.

3. Report the four lists that come back. They are disjoint and each answers a different question:
   - `rewrapped` — hub-relative files whose header was replaced. Their **names did not change**, so no index anywhere needed rewriting.
   - `skipped` — files left exactly as they were. `reason: "plaintext"` is the only one: a bundle pushed before the hub was sealed stays plaintext, because making it ciphertext renames it (every index records the name) and has to delete the original. Say plainly that those bundles are still readable by anyone with read access to the hub directory.
   - `failed` — files this machine could not open. **Read `reason` before saying anything about them:** `no-matching-identity` means these are this machine's own bundles encrypted to a key it no longer holds (a replaced or regenerated `~/.sesh-mover/identity.age`), and **nothing recovers them** — see step 5. The others (`ciphertext-rejected`, `transfer`, `no-identity`) are damage or an I/O problem, and re-running after fixing the cause picks them up.
   - `narrowed` — files that came out addressed to **fewer** machines than they went in. That is a loss of access for whoever was dropped, and which machines those were cannot be recovered from the file — only how many. The usual cause is a `machines/<id>.json` removed or damaged since the file was written. Fixing the roster and running this again re-includes them.

4. Relay every `warnings` entry verbatim, and never soften this one: **a re-wrap grants access and can never take it away.** A machine that already opened one of these files still holds the file key, which does not change. Removing a machine from the roster and rekeying does **not** lock it out of bytes it has already read.

5. **The residual, and it must be named rather than worked around: a decommissioned machine can never re-wrap its bundles.** If the machine that pushed a thread no longer exists, its history stays unreadable to every machine that joined after it left, permanently, and no command in this plugin changes that — there is no authority that could. The same is true for a machine that lost or replaced its key: a re-wrap has to unwrap the file key first, so it cannot recover what it can no longer open. What survives in both cases is the *sessions*, because a push copies and never deletes the source: if the transcripts are still in that machine's Claude projects directory, `sesh-mover push --full` re-sends them whole as new bundles addressed to today's roster.

6. Refusals. Branch on `reason`, never on the prose:
   - `unlinked` — this directory is linked to no hub project. Push it first (`--create-project` or `--project-id`).
   - `lock-busy` — another hub operation for this project is running. Wait or retry; `holderPid` and `ageSeconds` say what is holding it.
   - `hub-unreachable` — the configured hub path is not readable from here. `hubState` says which of `no-directory` / `not-a-hub` / `unresponsive`.
   - `encryption-refused` — with `refusal: "self-unkeyed"`, this machine cannot read its own identity key, so it would be writing headers it could not open; with `refusal: "no-recipients"`, no registered machine publishes a usable key at all. **Neither is overridable and there is no flag to offer.** Nothing was written in either case.
   - Note what is deliberately **not** a refusal: a registered machine that publishes no usable key. A push refuses over that, because a push writes its bundle once; this command discloses it and continues, because it can simply be run again once that machine checks in. Do not present it as an error.
