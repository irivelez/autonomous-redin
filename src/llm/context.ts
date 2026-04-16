import { AppSheetClient, TABLES, type OrdenTrabajo } from "../clients/appsheet.js";

const OT_NUMBER_PATTERN = /(?:ot|orden|#)\s*(\d+)/i;

let cache: { ots: OrdenTrabajo[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000; // 1 minute — stale data is fine for grounding, fresh data costs an API call per message

export function extractOTNumber(text: string): string | null {
  const m = text.match(OT_NUMBER_PATTERN);
  return m ? m[1] : null;
}

/**
 * Fetch the OT row by number from AppSheet, with a short in-memory cache to
 * avoid a full table scan on every WhatsApp message during a busy period.
 * Returns null if not found or if AppSheet errors (degraded mode — LLM still
 * runs, just without ground truth).
 */
export async function fetchOTContext(
  appsheet: AppSheetClient,
  otNumber: string
): Promise<OrdenTrabajo | null> {
  try {
    const now = Date.now();
    if (!cache || now - cache.fetchedAt > CACHE_TTL_MS) {
      const all = await appsheet.find<OrdenTrabajo>(TABLES.ORDENES);
      cache = { ots: all, fetchedAt: now };
    }
    return cache.ots.find((ot) => ot.Numero_Orden === otNumber) || null;
  } catch (err) {
    console.error(`[Context] Error fetching OT ${otNumber}:`, err);
    return null;
  }
}

export function invalidateContextCache(): void {
  cache = null;
}
