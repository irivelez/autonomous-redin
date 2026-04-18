/**
 * Colombia-timezone-safe date helpers.
 *
 * AppSheet returns timestamps as "MM/DD/YYYY HH:MM:SS" in Colombia local time
 * (no TZ suffix). Feeding those through `new Date(s)` interprets them in the
 * SERVER'S local timezone, which drifts the day whenever the server isn't in
 * UTC-5 (Railway runs in UTC, dev Macs run in PDT/PST). That produced off-by-
 * one-day answers when users asked about "hoy" vs "este mes".
 *
 * These helpers parse the string's date portion directly, no Date involved.
 */

const BOGOTA_TZ = "America/Bogota";

/**
 * Parse an AppSheet "MM/DD/YYYY [HH:MM:SS]" string → ISO "YYYY-MM-DD".
 * Returns "" for empty/invalid input. Timezone-agnostic: we only take the
 * calendar-date part, which already encodes Colombia local time.
 */
export function appsheetDateToISO(raw: string): string {
  if (!raw) return "";
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return "";
  const mm = m[1].padStart(2, "0");
  const dd = m[2].padStart(2, "0");
  const yyyy = m[3];
  return `${yyyy}-${mm}-${dd}`;
}

/** Today's date in Bogotá, as ISO "YYYY-MM-DD". */
export function todayInBogota(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOGOTA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "00";
  const d = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${y}-${m}-${d}`;
}

/** Current month in Bogotá, as ISO "YYYY-MM". */
export function monthInBogota(now: Date = new Date()): string {
  return todayInBogota(now).slice(0, 7);
}
