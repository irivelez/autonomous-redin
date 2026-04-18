import { AppSheetClient } from "./appsheet.js";
import { normalizePhone } from "./user-registry.js";

export interface Arquitecto {
  "Row ID": string;
  Arquitecto: string;
  Email: string;
  Telefono: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

export class ArchitectLookup {
  private appsheet: AppSheetClient;
  private cache: { rows: Arquitecto[]; at: number } | null = null;
  private inflight: Promise<Arquitecto[]> | null = null;

  constructor(appsheet: AppSheetClient) {
    this.appsheet = appsheet;
  }

  async all(): Promise<Arquitecto[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < CACHE_TTL_MS) return this.cache.rows;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      try {
        const rows = await this.appsheet.find<Arquitecto>("Arquitecto");
        this.cache = { rows, at: Date.now() };
        return rows;
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  async findByPhone(phone: string): Promise<Arquitecto | null> {
    const target = normalizePhone(phone);
    const rows = await this.all();
    return rows.find((r) => normalizePhone(r.Telefono) === target) ?? null;
  }

  invalidate(): void {
    this.cache = null;
  }
}
