const GENERIC_SLUGS = new Set(["new-session", "untitled", ""]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUMMARY_LENGTH = 100;

export function extractSummary(
  slug: string,
  entries: Array<Record<string, unknown>>
): string {
  // Try slug first
  if (slug && !GENERIC_SLUGS.has(slug) && !UUID_PATTERN.test(slug)) {
    return slug;
  }

  // Try first user message (string content)
  for (const entry of entries) {
    if (entry.type === "user") {
      const msg = entry.message as Record<string, unknown>;
      if (typeof msg.content === "string" && msg.content.trim()) {
        return truncate(msg.content.trim());
      }
    }
  }

  // Try first assistant text response
  for (const entry of entries) {
    if (entry.type === "assistant") {
      const msg = entry.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            return truncate(b.text.trim());
          }
        }
      }
    }
  }

  return "(no summary available)";
}

export function extractFirstExchanges(
  entries: Array<Record<string, unknown>>,
  maxExchanges: number
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const entry of entries) {
    if (entry.type === "user" || entry.type === "assistant") {
      result.push(entry);
      if (result.length >= maxExchanges) break;
    }
  }

  return result;
}

function truncate(text: string): string {
  if (text.length <= MAX_SUMMARY_LENGTH) return text;
  return text.slice(0, MAX_SUMMARY_LENGTH) + "...";
}
