---
name: hub-trust
description: Show each machine's signing-key fingerprint, and confirm one out of band
---

You are running the sesh-mover hub trust command. It reports which machines' signing keys this machine has pinned, and lets the user **confirm** one by comparing a fingerprint. It writes nothing on the hub and takes no lock — the only thing it can change is this machine's own local pin file.

Understand what this is for before you explain it, because the value is entirely in one distinction:

- **Pinned on first use (`tofu`)** means this machine trusted the hub once, when it first saw a signed bundle from that machine. After that, a different key for that machine refuses a pull. But the first sighting trusted whatever the hub said.
- **Confirmed (`confirmed`)** means a human compared the fingerprint against the same fingerprint shown on the other machine, over a channel that is not the hub. **This is the only step in signing that does not take the hub's word for a key**, because anyone who can write to the hub can also publish a signing key of their own.

Both kinds of pin are kept under the **hub identity this machine joined** (the `hubId` recorded in `~/.sesh-mover/joined-hubs.json` when it ran `hub init` there, or — after upgrading — on its first hub command other than `hub status` or `whereis`, which never record it). That one fact did come from the hub, once — like a first pin. After that, a hub whose `hub.json` names a different identity makes every hub command here that reads a pin or writes the hub refuse with `reason: "hub-identity-changed"`, this one included, rather than quietly looking pins up under the new identity and finding none.

Neither is an error, and `tofu` is the default. Do not present it as a problem to fix.

Follow these steps:

1. **To report**, run:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub trust [--project-path "<dir>"]
   ```
   Show the machines as a table: name (or id), fingerprint, and pin state. Say plainly which are confirmed and which are first-use. If any machine has `signingPublicKey: null`, say it has published no key yet — it has not pushed since signing shipped, or its key file was unreadable when it last checked in — and that one push or pull from it publishes one.

2. **If any machine has `conflict: true`, lead with that.** The hub is publishing a key that differs from what is pinned here, which means pulling that machine's bundles will refuse until it is resolved. Say clearly what it does and does not mean: it is **not proof of an attack** — a machine that lost its key and re-minted looks exactly the same from here — which is precisely why nothing resolves it automatically. The resolution is step 3, performed deliberately.

3. **To confirm a key**, the user must first get the fingerprint from the other machine. Tell them to run `/sesh-mover:hub-trust` (or `sesh-mover hub trust`) **on that machine** and read the fingerprint from there — over a channel that is not this hub. A phone call, a message, walking to the other desk. Reading it off the hub would confirm the hub against itself and prove nothing.

   Then:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" hub trust --machine "<id>" --fingerprint "<fp>"
   ```

   **Never invent or guess a fingerprint, and never read one out of the hub to feed back in.** The command refuses a mismatch on purpose; helping the user get past that refusal would destroy the only property the ceremony has.

4. Branch on the result:
   - `success: true` with `confirmed` — the pin is now `confirmed`. Say which machine and that the key is now trusted independently of the hub.
   - `success: true` without `confirmed` — a report. Relay `warnings` verbatim; they say how many machines are unconfirmed and how many conflict.
   - `refusal: "fingerprint-mismatch"` — **the important one.** The fingerprint given does not match what the hub publishes. Relay the suggestion in full and do **not** offer to retry with a different value or to look the fingerprint up. If the two genuinely differ, either that machine re-minted its key or something is publishing a key it does not hold, and the user needs to find out which before confirming anything.
   - `refusal: "no-key-published"` — nothing to confirm yet; one push or pull from that machine publishes its key.
   - `refusal: "no-such-machine"` — run the report form first to list real machine ids; do not guess one.
   - `refusal: "pin-write-failed"` — the fingerprint matched but the pin could not be saved. Report the detail; until it saves, this machine keeps treating the key as unconfirmed.
   - `reason: "hub-unreachable"` — nothing was read; report `hubState` and the suggestion.
   - `reason: "hub-identity-changed"` — the hub's `hub.json` names a different identity from the one this machine joined at that path, so no pin was read and none was written. Relay `error` and `suggestion` in full. Both readings are real — the hub was re-created or switched on purpose, or someone rewrote `hub.json` — and the second is precisely an attempt to make this machine's pins stop applying. **Never offer `hub init --accept-new-hub-id` yourself**; follow `/sesh-mover:hub-init`'s "The hub identity" rules.

5. If the user asks whether they need to do this at all: **no.** Pinning happens automatically on first use and gives real protection against a key changing later. Confirming closes the remaining gap for a KEY — an attacker who was already in place before this machine ever pulled. It does not remove the one-time trust in the hub's identity described above; nothing does, and a later change to that identity makes every hub command that reads a pin or writes the hub refuse, rather than resetting the pins. Say that plainly and let them decide; a single-owner fleet may reasonably skip it.

**One thing to state whenever signing comes up and never soften:** a signature proves which machine wrote a bundle. It says nothing about whether the contents are safe. A valid signature from a machine that has been compromised authenticates hostile content perfectly — so the consent gates around importing project files do not go away because a bundle is signed.
