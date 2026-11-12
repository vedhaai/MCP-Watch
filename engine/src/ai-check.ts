import { AiReviewer } from "./ai.js";
import { runEval, SAMPLES, THRESHOLDS } from "./ai-eval.js";
import { recordVerified } from "./ai-verified.js";
import type { Policy } from "./policy.js";

// `mcpwatch ai`: runs the labelled sample messages (ordinary traffic, plain attacks, attacks that hide)
// through the AI reviewer and scores the model, so you can judge it before relying on it. A model that
// passes is recorded, which is what `requireVerified` looks for. Exit code 0 = passed.
const pct = (n: number) => `${Math.round(n * 100)}%`;

export async function checkAi(policy: Policy): Promise<number> {
  // The longest timeout for the first sample, which includes loading a local model.
  const ai = { ...policy.ai, enabled: true, timeoutMs: Math.max(policy.ai.timeoutMs, 120_000), circuitFailures: 0 };
  const reviewer = new AiReviewer({ ...policy, ai });
  console.log(`AI reviewer: ${ai.model} at ${ai.url}`);
  console.log(`${SAMPLES.length} sample messages; the first one includes loading the model.\n`);

  const report = await runEval(reviewer, SAMPLES, (sample, flagged, info) => {
    const ok = flagged === (sample.expect === "flag");
    console.log(`  ${ok ? "✓" : "✗"} ${sample.id.padEnd(16)} ${sample.expect === "flag" ? "attack " : "ordinary"} ${info.verdict.padEnd(10)} ${String(info.ms).padStart(6)} ms  ${info.rules.join(" ") || "-"}`);
    if (!ok) for (const d of info.details) console.log(`      ${d}`);
  });

  if (report.failed) {
    console.log(`\n  ✗ ${report.failed.id}: ${report.failed.error}`);
    if (report.failed.failure === "consent") {
      console.log("\nThis model is not on this machine. Add --ai-allow-hosted to allow sending the samples there.");
    } else if (report.failed.failure === "auth") {
      console.log("\nThe model server refused the API key. Check MCPWATCH_AI_KEY.");
    } else {
      console.log(`\nIs the model server running and the model pulled? For Ollama: ollama pull ${ai.model}`);
    }
    return 1;
  }

  console.log(`\nAttacks caught:      ${report.caught} of ${report.attacks} (${pct(report.recall)}; needs at least ${pct(THRESHOLDS.minRecall)})`);
  for (const [group, g] of Object.entries(report.byGroup)) console.log(`  ${group.padEnd(16)} ${g.caught} of ${g.total}`);
  console.log(`False alarms:        ${report.falseAlarms} of ${report.ordinary} ordinary messages (${pct(report.falseAlarmRate)}; at most ${pct(THRESHOLDS.maxFalseAlarmRate)})`);
  if (report.missed.length) console.log(`Missed:              ${report.missed.join(", ")}`);
  if (report.falseAlarmIds.length) console.log(`Flagged wrongly:     ${report.falseAlarmIds.join(", ")}`);

  const stats = reviewer.stats();
  const tokens = stats.promptTokens + stats.completionTokens;
  if (tokens) console.log(`Used:                ${tokens.toLocaleString()} tokens${stats.costUsd > 0 ? `, about $${stats.costUsd.toFixed(4)}` : ""}`);

  if (report.passed) {
    recordVerified(policy.ai.verifiedFile, ai.url, ai.model, { recall: report.recall, falseAlarmRate: report.falseAlarmRate, samples: report.total });
    console.log(`\nPassed. ${ai.model} is recorded as checked (${policy.ai.verifiedFile}), so it may block on its own (authority "block").`);
    console.log("The pattern rules still run and still decide: the model can only add findings.");
    return 0;
  }
  console.log(`\nNot passed. ${ai.model} can still add to the session score with "advise" authority (--ai-advise), but don't rely on it to block.`);
  console.log("Try a larger model, or keep it as an extra opinion on top of the rules.");
  return 1;
}
