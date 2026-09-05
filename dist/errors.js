/**
 * Reading a thrown value safely (#102).
 *
 * ## The defect this exists to remove
 *
 * `catch (e) { … (e as Error).message … }` is a lie the type system cannot
 * catch, because `catch` binds `unknown` and the cast asserts what nobody
 * checked. A rejection reason is whatever the failing code passed to `reject`
 * or `throw`, and `throw null`, `reject("boom")`, an `Error` subclass whose
 * `message` was reassigned, a cross-realm `Error`, and an object with a
 * throwing `message` getter are all legal. On the first of those the cast is a
 * TypeError — thrown from inside a `catch`, which is exactly where code has
 * least expectation of one and where a contract not to throw usually lives.
 *
 * Found while fixing #96 finding 5, which was one instance of it in
 * `hub/bundle-io.ts`. The shape appeared at ~45 further sites, several on
 * contracts where a throw is not cosmetic: both hook endpoints, which must
 * ALWAYS exit 0 per Claude Code's hook protocol, and `pull-fetch.ts`'s stage
 * aborts, whose module contract is that every untrusted-input call returns a
 * typed abort rather than throwing.
 *
 * ## Why ONE copy, when the issue argued both ways
 *
 * #102 recorded a real counter-argument: a single helper every catch reaches
 * for could become the place a genuine diagnosis gets flattened. It does not
 * apply, and the reason is worth stating so the question is not reopened by
 * feel. **This function decides nothing.** It extracts text and classifies
 * nothing — `classifyBundleFailure` still branches on `AgeError` and its
 * `code`, `readIdentityFile` still splits `io` from `malformed`, and every
 * caller keeps whatever discrimination it had. What is shared is the one step
 * that has exactly one correct answer for everyone: get the string out without
 * trusting the value to have one.
 *
 * So the "exactly ONE copy" rule applies here for its usual reason. Two
 * spellings of this drift, and a second copy is how a site ends up with the
 * unguarded version again.
 *
 * ## What it does not do
 *
 * It cannot diagnose. A reason that will not even render says nothing about
 * WHY an operation failed, and a caller that needs to distinguish causes must
 * do so on the value — its class, its `code` — never by matching this string.
 * Matching on message text is forbidden in this codebase
 * (`skills/session-porter/SKILL.md`) and this function is not a way around it.
 */
/**
 * The text of a thrown or rejected value, for any value at all.
 *
 * Three guards, and each covers a case the others do not:
 *
 * 1. **Duck-typed `message`, not `instanceof Error`.** A cross-realm `Error`
 *    (from another context/worker) fails `instanceof` while carrying the
 *    diagnosis worth keeping whole. Optional chaining is what makes `null` and
 *    `undefined` safe rather than a TypeError.
 * 2. **`String(e)` rather than a template literal** for the fallback. A
 *    template literal throws on a symbol; `String()` does not.
 * 3. **The whole extraction inside `try`.** A property read and a `String()`
 *    both run code the value's author chose — a throwing getter, a throwing
 *    `toString`. A promise not to throw cannot trust its own extraction.
 */
export function errorMessage(e) {
    try {
        const m = e?.message;
        return typeof m === "string" ? m : String(e);
    }
    catch {
        return "(error could not be rendered)";
    }
}
//# sourceMappingURL=errors.js.map