/**
 * scripts/niche-check.js
 * Called every Sunday at 9am by scheduler.js
 * Evaluates current niche performance and auto-pivots if needed.
 */

require("dotenv").config();

const niche   = require("../core/niche");
const revenue = require("../core/revenue");
const { auditLog } = require("../security/vault");

async function main() {
  console.log("\n  🔍 Weekly niche health check running...\n");

  const state = (() => {
    const fs   = require("fs");
    const path = require("path");
    const f    = path.join(process.cwd(), "data", "state.json");
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  })();

  const { stats } = await revenue.runRevenueCheck();

  const result = await niche.weeklyNicheCheck(state, stats);

  if (result.status === "staying") {
    console.log(`  ✓ Niche "${result.niche}" is healthy — no changes needed`);
  } else if (result.new_niche) {
    console.log(`  🔄 Pivoted to: "${result.new_niche}" (pivot #${result.pivot_count})`);
  }

  auditLog("WEEKLY_NICHE_CHECK", result);
}

main().catch(err => {
  console.error("Niche check error:", err.message);
  process.exit(1);
});
