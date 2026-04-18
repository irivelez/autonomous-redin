import "dotenv/config";
import { AppSheetClient } from "../clients/appsheet.js";

const appsheet = new AppSheetClient({
  appId: process.env.APPSHEET_APP_ID!,
  accessKey: process.env.APPSHEET_ACCESS_KEY!,
});

async function main() {
  const candidates = ["Arquitectos", "ARQUITECTOS", "arquitectos", "Arquitecto", "Architects"];
  for (const name of candidates) {
    try {
      const rows = await appsheet.find<Record<string, string>>(name);
      console.log(`--- ${name}: rows=${rows.length}`);
      if (rows.length > 0) {
        console.log("columns:", Object.keys(rows[0]));
        console.log("first row:", JSON.stringify(rows[0], null, 2));
        if (rows.length > 1) console.log("second row:", JSON.stringify(rows[1], null, 2));
        return;
      }
    } catch (err) {
      console.log(`--- ${name}: ERROR ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
