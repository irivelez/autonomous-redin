/**
 * Standalone verification: simulate a real architect message end-to-end.
 * Runs: AppSheet fetch -> ops bundle -> Gemini call -> printed result.
 * Use with `railway run npx tsx src/cli/verify-llm.ts "your question"` to
 * exercise the same env vars production uses.
 */
import "dotenv/config";
import { AppSheetClient } from "../clients/appsheet.js";
import { buildOpsBundle, renderBundleForPrompt } from "../llm/context-bundle.js";
import { interpretWithLLM, isLLMConfigured } from "../llm/intent.js";
import { extractOTNumber } from "../llm/context.js";

async function main() {
  const message = process.argv[2] || "indícame por favor las OTs vencidas de Tatiana Arias";

  console.log("═══════════════════════════════════════");
  console.log("  LLM VERIFICATION RUN                  ");
  console.log("═══════════════════════════════════════");
  console.log(`Message: """${message}"""`);
  console.log(`GEMINI_API_KEY set: ${isLLMConfigured()}`);
  console.log(`APPSHEET_APP_ID set: ${!!process.env.APPSHEET_APP_ID}`);
  console.log("");

  if (!isLLMConfigured()) {
    console.error("FAIL: GEMINI_API_KEY not in env. Run with: railway run npx tsx src/cli/verify-llm.ts");
    process.exit(1);
  }

  const appsheet = new AppSheetClient({
    appId: process.env.APPSHEET_APP_ID!,
    accessKey: process.env.APPSHEET_ACCESS_KEY!,
  });

  console.log("[1/3] Building ops bundle from AppSheet...");
  const t0 = Date.now();
  const otNumber = extractOTNumber(message);
  const bundle = await buildOpsBundle(appsheet, otNumber);
  const t1 = Date.now();
  console.log(`     ✓ done in ${t1 - t0}ms`);
  console.log(`     Active OTs: ${bundle.totals.allActive}`);
  console.log(`     Critical alerts: ${bundle.critical.length}`);
  console.log(`     Inter Rapidísimo active: ${bundle.totals.interOTsActive}`);
  console.log(`     By architect:`, bundle.byArchitect);
  console.log("");

  const opsContext = renderBundleForPrompt(bundle);
  console.log("[2/3] Rendered context size:", opsContext.length, "chars (~", Math.round(opsContext.length / 4), "tokens)");
  console.log("");

  console.log("[3/3] Calling Gemini 2.5 Flash...");
  const t2 = Date.now();
  try {
    const result = await interpretWithLLM({
      message,
      hasPhotos: false,
      senderName: "TEST_USER",
      senderPhone: "+57000",
      senderRole: "architect",
      opsContext,
    });
    const t3 = Date.now();
    console.log(`     ✓ done in ${t3 - t2}ms`);
    console.log("");
    console.log("═══════════════════════════════════════");
    console.log("  GEMINI RESPONSE                       ");
    console.log("═══════════════════════════════════════");
    console.log("intent:           ", result.intent);
    console.log("ot_number:        ", result.ot_number);
    console.log("urgency:          ", result.urgency);
    console.log("needs_human:      ", result.needs_human);
    console.log("confidence:       ", result.confidence);
    console.log("summary:          ", result.summary);
    console.log("");
    console.log("─── REPLY (what the architect would receive) ───");
    console.log(result.reply);
    console.log("");
    console.log("─── SUGGESTED ACTIONS ───");
    for (const a of result.suggested_actions) console.log("  •", a);
    console.log("");
    console.log("✅ FULL PIPELINE WORKING");
  } catch (err) {
    console.error(`     ✗ FAILED in ${Date.now() - t2}ms`);
    console.error("Error:", (err as Error).message);
    console.error((err as Error).stack);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
