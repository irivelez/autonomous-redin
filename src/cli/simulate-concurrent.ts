/**
 * Concurrency simulation.
 *
 * Fires N fake architect sessions against the real pipeline (AppSheet →
 * ops bundle → Gemini) in parallel. Bypasses Telegram entirely — we hit
 * the same `interpretWithLLM` call path the bot uses, with real Arquitecto
 * identities drawn from the Arquitecto table so role detection matches prod.
 *
 * What this tests:
 *   - Shared ops-bundle cache under concurrent cold-cache load (single-flight)
 *   - Session isolation: each simulated user gets their own reply
 *   - End-to-end latency distribution
 *   - AppSheet/Gemini stability under N parallel calls
 *
 * Usage:
 *   npx tsx src/cli/simulate-concurrent.ts [N]
 *   N defaults to 3, max 20.
 */
import "dotenv/config";
import { AppSheetClient } from "../clients/appsheet.js";
import { ArchitectLookup, type Arquitecto } from "../clients/architect-lookup.js";
import { buildOpsBundle, renderBundleForPrompt, invalidateOpsCache } from "../llm/context-bundle.js";
import { interpretWithLLM, isLLMConfigured, type IntentResult } from "../llm/intent.js";
import { extractOTNumber } from "../llm/context.js";

const PROMPTS: string[] = [
  "dime las OTs facturadas este mes",
  "qué OTs tengo estancadas en coordinar más de 10 días",
  "top 5 OTs por valor estimado en ejecución",
  "rentabilidad acumulada este trimestre",
  "qué OTs están vencidas en SLA de Inter Rapidísimo",
  "cuántas OTs activas hay por cliente",
  "cuáles OTs de Tatiana están por aprobar",
  "resumen de cotizaciones sin respuesta",
  "cuál es el ticket promedio facturado este mes",
  "dame las 5 OTs más viejas sin cerrar",
  "qué clientes tienen OTs canceladas recientemente",
  "rentabilidad por arquitecto este mes",
  "cuál OT tiene el mayor valor en Cali",
  "qué OTs deberíamos facturar ya",
  "cuántos días promedio de ejecución a pago",
  "hay OTs con rentabilidad negativa",
  "qué OTs llevan más de 30 días en ejecución",
  "cuál es el estado de la OT más reciente",
  "resumen de Casa Limpia",
  "OTs creadas en los últimos 7 días",
];

interface RunResult {
  idx: number;
  architect: string;
  prompt: string;
  latencyMs: number;
  intent: IntentResult["intent"];
  replyPreview: string;
  error?: string;
}

async function runOne(
  idx: number,
  appsheet: AppSheetClient,
  arq: Arquitecto,
  prompt: string
): Promise<RunResult> {
  const start = Date.now();
  try {
    const otNumber = extractOTNumber(prompt);
    const bundle = await buildOpsBundle(appsheet, otNumber);
    const opsContext = renderBundleForPrompt(bundle);
    const result = await interpretWithLLM({
      message: prompt,
      hasPhotos: false,
      senderName: arq.Arquitecto,
      senderPhone: arq.Telefono,
      senderRole: "architect",
      opsContext,
    });
    return {
      idx,
      architect: arq.Arquitecto,
      prompt,
      latencyMs: Date.now() - start,
      intent: result.intent,
      replyPreview: result.reply.substring(0, 80).replace(/\s+/g, " "),
    };
  } catch (err) {
    return {
      idx,
      architect: arq.Arquitecto,
      prompt,
      latencyMs: Date.now() - start,
      intent: "unknown",
      replyPreview: "",
      error: (err as Error).message,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main(): Promise<void> {
  const N = Math.min(20, Math.max(1, parseInt(process.argv[2] || "3", 10)));

  console.log("═══════════════════════════════════════");
  console.log(`  CONCURRENT SESSIONS SIMULATION (N=${N})`);
  console.log("═══════════════════════════════════════");

  if (!isLLMConfigured()) {
    console.error("FAIL: GEMINI_API_KEY not set.");
    process.exit(1);
  }

  const appsheet = new AppSheetClient({
    appId: process.env.APPSHEET_APP_ID!,
    accessKey: process.env.APPSHEET_ACCESS_KEY!,
  });
  const lookup = new ArchitectLookup(appsheet);

  const architects = await lookup.all();
  if (architects.length === 0) {
    console.error("FAIL: No architects in Arquitecto table.");
    process.exit(1);
  }
  console.log(`Arquitectos available: ${architects.length}`);
  console.log(`Prompts available: ${PROMPTS.length}`);

  // Force cold cache so we exercise the single-flight path — the realistic
  // worst case when 20 users arrive together after a deploy.
  invalidateOpsCache();
  console.log("Ops cache invalidated (cold start simulation).\n");

  const sessions = Array.from({ length: N }, (_, i) => ({
    idx: i + 1,
    arq: architects[i % architects.length],
    prompt: PROMPTS[i % PROMPTS.length],
  }));

  for (const s of sessions) {
    console.log(`  session ${s.idx}: ${s.arq.Arquitecto} → "${s.prompt}"`);
  }
  console.log("\nFiring all sessions in parallel...\n");

  const totalStart = Date.now();
  const results = await Promise.all(sessions.map((s) => runOne(s.idx, appsheet, s.arq, s.prompt)));
  const totalElapsed = Date.now() - totalStart;

  results.sort((a, b) => a.idx - b.idx);
  for (const r of results) {
    const tag = r.error ? `❌ ${r.error}` : `${r.intent}`;
    console.log(
      `  ${String(r.idx).padStart(2)} | ${r.architect.padEnd(20)} | ${r.latencyMs
        .toString()
        .padStart(6)}ms | ${tag.padEnd(22)} | ${r.replyPreview}`
    );
  }

  const ok = results.filter((r) => !r.error);
  const fails = results.filter((r) => r.error);
  const lats = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const mean = lats.length > 0 ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;

  console.log("\n─── summary ───");
  console.log(`  sessions: ${N}   ok: ${ok.length}   failed: ${fails.length}`);
  console.log(`  wall time (all parallel): ${totalElapsed}ms`);
  if (lats.length > 0) {
    console.log(
      `  per-session latency: min=${lats[0]}ms  mean=${mean}ms  p50=${percentile(lats, 50)}ms  p95=${percentile(lats, 95)}ms  max=${lats[lats.length - 1]}ms`
    );
    console.log(
      `  serial would be ~${Math.round(lats.reduce((a, b) => a + b, 0))}ms — parallel speedup: ${(
        lats.reduce((a, b) => a + b, 0) / totalElapsed
      ).toFixed(1)}x`
    );
  }

  // Uniqueness check: every session should get a distinct reply tied to its prompt
  const unique = new Set(ok.map((r) => r.replyPreview));
  console.log(`  unique replies: ${unique.size}/${ok.length} (isolation sanity)`);

  if (fails.length > 0) {
    console.log("\n❌ Some sessions failed. See errors above.");
    process.exit(2);
  }
  console.log("\n✅ All sessions processed independently.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
