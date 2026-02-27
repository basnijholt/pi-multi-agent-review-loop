/**
 * PR Review — /pr-review and /pr-review-loop commands
 *
 * /pr-review      — Single review+debate cycle (background, non-blocking)
 * /pr-review-loop — Iterative review/fix/review loop until clean
 *
 * Both run entirely in the background using RPC sub-agents.
 * After debate, the "winning" reviewer (the one whose points were more
 * often agreed upon) writes the consensus and applies fixes. It already
 * has full context: the diff, files it read, and the entire debate.
 *
 * Config (env vars):
 *   PR_REVIEW_MODEL_A      — reviewer A model (default: anthropic/claude-opus-4-6)
 *   PR_REVIEW_MODEL_B      — reviewer B model (default: openai/gpt-5.3-codex)
 *   PR_REVIEW_THINKING_A   — thinking level for A (default: high)
 *   PR_REVIEW_THINKING_B   — thinking level for B (default: xhigh)
 *   PR_REVIEW_MAX_ROUNDS   — max debate rounds per cycle (default: 3)
 *   PR_REVIEW_MAX_CYCLES   — max review/fix cycles (default: 5)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	type SubAgent,
	type ThinkingLevel,
	spawnRpcAgent,
	rpcPromptAndWait,
	killAgent,
	renderAgentLines,
} from "pi-subagents/rpc.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_A = "anthropic/claude-opus-4-6";
const DEFAULT_MODEL_B = "openai/gpt-5.3-codex";
const DEFAULT_THINKING_A: ThinkingLevel = "high";
const DEFAULT_THINKING_B: ThinkingLevel = "xhigh";
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_MAX_CYCLES = 5;
const WIDGET_KEY = "pr-review";
const WIDGET_THROTTLE_MS = 250;

const REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer performing a zero-tolerance review. Every issue is a blocker. Your verdict must be APPROVE or CHANGES REQUIRED — never approve with caveats. Be specific with file paths, line numbers, and code snippets.

Check:
- Code cleanliness, DRY, code reuse, organization, consistency
- Simplicity (KISS/YAGNI), no pointless wrappers, functional style
- Imports at top (no inline imports)
- Tests, edge cases, error handling
- Documentation (README, CHANGELOG, docstrings) for user-facing changes — missing doc updates are a blocker

You have full access to the codebase via your tools — use bash, read, grep, find as needed to understand context.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReviewConfig {
	modelA: string;
	modelB: string;
	thinkingA: ThinkingLevel;
	thinkingB: ThinkingLevel;
	maxRounds: number;
	mergeBase: string;
}

interface ConsensusReport {
	raw: string;
	verdict: "APPROVE" | "CHANGES REQUIRED";
	criticalCount: number;
	warningCount: number;
	dismissedItems: string[];
}

/** Result of a review cycle. The winner is kept alive for potential fix work. */
interface CycleResult {
	consensus: ConsensusReport;
	winner: SubAgent;
	loser: SubAgent;
	winnerName: string;
}

interface CycleHistory {
	cycle: number;
	consensus: ConsensusReport;
	fixerName: string | undefined;
	fixCommit: string | undefined;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let activeAgents: SubAgent[] = [];
	let phase = "";
	let cycleInfo = "";
	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let lastWidgetUpdate = 0;

	// -- Widget ---------------------------------------------------------------

	function renderWidget(ctx: ExtensionContext) {
		if (activeAgents.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const header = cycleInfo
			? `PR Review ${cycleInfo} — ${phase}`
			: `PR Review — ${phase}`;
		const lines = [
			theme.fg("accent", header),
			...renderAgentLines(activeAgents, theme),
		];
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}

	function throttledRenderWidget(ctx: ExtensionContext) {
		const now = Date.now();
		if (now - lastWidgetUpdate < WIDGET_THROTTLE_MS) return;
		lastWidgetUpdate = now;
		renderWidget(ctx);
	}

	function startWidgetTimer(ctx: ExtensionContext) {
		stopWidgetTimer();
		widgetTimer = setInterval(() => renderWidget(ctx), 2000);
	}

	function stopWidgetTimer() {
		if (widgetTimer) {
			clearInterval(widgetTimer);
			widgetTimer = undefined;
		}
	}

	// -- Shared helpers -------------------------------------------------------

	function getConfig(): ReviewConfig & { maxCycles: number } {
		return {
			modelA: process.env.PR_REVIEW_MODEL_A || DEFAULT_MODEL_A,
			modelB: process.env.PR_REVIEW_MODEL_B || DEFAULT_MODEL_B,
			thinkingA: (process.env.PR_REVIEW_THINKING_A || DEFAULT_THINKING_A) as ThinkingLevel,
			thinkingB: (process.env.PR_REVIEW_THINKING_B || DEFAULT_THINKING_B) as ThinkingLevel,
			maxRounds: parseInt(process.env.PR_REVIEW_MAX_ROUNDS || String(DEFAULT_MAX_ROUNDS), 10) || DEFAULT_MAX_ROUNDS,
			maxCycles: parseInt(process.env.PR_REVIEW_MAX_CYCLES || String(DEFAULT_MAX_CYCLES), 10) || DEFAULT_MAX_CYCLES,
			mergeBase: "", // filled in by command handler
		};
	}

	async function spawnAndWait(
		name: string, model: string, thinking: ThinkingLevel, systemPrompt: string, cwd: string,
	): Promise<SubAgent> {
		const agent = spawnRpcAgent(name, model, thinking, systemPrompt, cwd);
		await new Promise((r) => setTimeout(r, 2000));
		if (agent.proc.exitCode !== null) {
			throw new Error(`${name} failed to start: ${agent.stderr}`);
		}
		return agent;
	}

	/**
	 * Run a single review+debate cycle.
	 *
	 * Returns the consensus report AND both agents. The winner (the reviewer
	 * whose points were more often agreed upon) is kept alive — caller decides
	 * whether to use it for fixes or kill it. The loser is returned but the
	 * caller should kill it.
	 */
	async function runReviewCycle(
		ctx: ExtensionContext,
		config: ReviewConfig,
		dismissedItems: string[],
	): Promise<CycleResult> {
		const onProgress = () => throttledRenderWidget(ctx);

		// Spawn fresh reviewers (no context from prior cycles = no bias)
		phase = "spawning reviewers";
		renderWidget(ctx);
		const agentA = await spawnAndWait("reviewer-a", config.modelA, config.thinkingA, REVIEW_SYSTEM_PROMPT, ctx.cwd);
		const agentB = await spawnAndWait("reviewer-b", config.modelB, config.thinkingB, REVIEW_SYSTEM_PROMPT, ctx.cwd);
		activeAgents = [agentA, agentB];
		renderWidget(ctx);

		const dismissedClause = dismissedItems.length > 0
			? `\n\nIMPORTANT: The following items were raised and dismissed as non-issues in earlier review cycles. Do NOT re-raise them:\n${dismissedItems.map((item, i) => `${i + 1}. ${item}`).join("\n")}\n`
			: "";

		const reviewPrompt = `Run \`git diff ${config.mergeBase}\` via bash to get the PR diff. Review it thoroughly — read any files you need for full context. Categorize every finding as **Critical**, **Warning**, or **Suggestion**. End with your verdict: **APPROVE** or **CHANGES REQUIRED**.${dismissedClause}`;

		// Phase 1: Parallel independent reviews (fresh, no bias)
		phase = "independent reviews (parallel)";
		renderWidget(ctx);

		const [reviewA, reviewB] = await Promise.all([
			rpcPromptAndWait(agentA, reviewPrompt, onProgress),
			rpcPromptAndWait(agentB, reviewPrompt, onProgress),
		]);

		// Phase 2: Debate rounds
		let lastResponseA = reviewA;
		let lastResponseB = reviewB;
		// Track how many times each reviewer's points were agreed upon by the opponent.
		// debateResponseB is B responding to A's points, so "Agreed" in B's response = A's point accepted.
		let agreedByB = 0; // points A raised that B agreed with
		let agreedByA = 0; // points B raised that A agreed with

		for (let round = 1; round <= config.maxRounds; round++) {
			phase = `debate round ${round}/${config.maxRounds}`;
			renderWidget(ctx);

			const dismissedClause = dismissedItems.length > 0
				? `\n\nIMPORTANT: The following items were previously discussed and dismissed as non-issues in earlier review cycles. Do not re-raise them unless you have genuinely new evidence:\n${dismissedItems.map((item, i) => `${i + 1}. ${item}`).join("\n")}\n`
				: "";

			const debatePrompt = (otherName: string, otherReview: string) =>
				`Here is ${otherName}'s review:\n\n${otherReview}\n\nRespond to each of their findings point-by-point:\n- **Agreed** — you concur\n- **Partially agreed** — with your reasoning\n- **Disagreed** — with your reasoning\n\nAlso list any findings they missed. End with your updated verdict.${dismissedClause}`;

			const [debateA, debateB] = await Promise.all([
				rpcPromptAndWait(agentA, debatePrompt("reviewer-b", lastResponseB), onProgress),
				rpcPromptAndWait(agentB, debatePrompt("reviewer-a", lastResponseA), onProgress),
			]);

			// A responding to B's points: count agreements
			agreedByA += countAgreements(debateA);
			// B responding to A's points: count agreements
			agreedByB += countAgreements(debateB);

			lastResponseA = debateA;
			lastResponseB = debateB;

			const disagreementsA = (debateA.match(/\*\*Disagreed\*\*/gi) || []).length;
			const disagreementsB = (debateB.match(/\*\*Disagreed\*\*/gi) || []).length;
			if (disagreementsA + disagreementsB === 0) {
				phase = `converged after ${round} round${round > 1 ? "s" : ""}`;
				renderWidget(ctx);
				break;
			}
		}

		// Determine winner: the reviewer whose points were more often agreed upon.
		// agreedByB = how many of A's points B accepted → A's score
		// agreedByA = how many of B's points A accepted → B's score
		const aWins = agreedByB >= agreedByA;
		const winner = aWins ? agentA : agentB;
		const loser = aWins ? agentB : agentA;
		const winnerName = aWins ? "reviewer-a" : "reviewer-b";

		// Phase 3: Winner writes the consensus (it has full context)
		phase = `${winnerName} writing consensus`;
		activeAgents = [winner];
		renderWidget(ctx);

		// Kill the loser now — no longer needed
		await killAgent(loser).catch(() => {});

		const consensusPrompt = `Based on the entire review and debate, write the final consensus report. You were the reviewer whose points were most often agreed upon, so you are writing the authoritative consensus.

Use this EXACT format:

## PR Review Consensus

### Verdict: [APPROVE or CHANGES REQUIRED]

### Critical Issues (must fix)
[numbered list, or "None"]

### Warnings (should fix)
[numbered list, or "None"]

### Suggestions (consider)
[numbered list, or "None"]

### Dismissed Non-Issues
[points that were raised but dismissed during debate, numbered list, or "None"]

### Summary
[2-3 sentence summary of the review]`;

		const raw = await rpcPromptAndWait(winner, consensusPrompt, onProgress);
		const consensus = parseConsensus(raw);

		return { consensus, winner, loser, winnerName };
	}

	// -- /pr-review -----------------------------------------------------------

	pi.registerCommand("pr-review", {
		description: "Run parallel PR review with debate (background, non-blocking)",
		handler: async (_args, ctx) => {
			if (activeAgents.length > 0) {
				ctx.ui.notify("A PR review is already running. Wait for it to finish.", "error");
				return;
			}

			const config = getConfig();
			config.mergeBase = await requireMergeBase(pi, ctx);
			if (!config.mergeBase) return;

			ctx.ui.notify(`Merge base: ${config.mergeBase.slice(0, 8)}. Starting background review...`, "info");

			(async () => {
				startWidgetTimer(ctx);
				cycleInfo = "";
				try {
					const result = await runReviewCycle(ctx, config, []);
					phase = "complete";
					renderWidget(ctx);
					pi.sendUserMessage(`The background PR review is complete. Here is the consensus report:\n\n${result.consensus.raw}`);
					// Kill the winner — not needed for single review
					await killAgent(result.winner).catch(() => {});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`PR review failed: ${msg}`, "error");
				} finally {
					await cleanupAll(ctx);
				}
			})();
		},
	});

	// -- /pr-review-loop ------------------------------------------------------

	pi.registerCommand("pr-review-loop", {
		description: "Iterative review/fix/review loop until the PR is clean (background)",
		handler: async (_args, ctx) => {
			if (activeAgents.length > 0) {
				ctx.ui.notify("A PR review is already running. Wait for it to finish.", "error");
				return;
			}

			const config = getConfig();
			config.mergeBase = await requireMergeBase(pi, ctx);
			if (!config.mergeBase) return;

			ctx.ui.notify(
				`Merge base: ${config.mergeBase.slice(0, 8)}. Starting review loop (max ${config.maxCycles} cycles)...`,
				"info",
			);

			(async () => {
				startWidgetTimer(ctx);
				const history: CycleHistory[] = [];
				let allDismissedItems: string[] = [];

				try {
					for (let cycle = 1; cycle <= config.maxCycles; cycle++) {
						cycleInfo = `[cycle ${cycle}/${config.maxCycles}]`;

						// --- Review cycle (fresh reviewers, no bias) ---
						const result = await runReviewCycle(ctx, config, allDismissedItems);

						// Accumulate dismissed items
						allDismissedItems = [...allDismissedItems, ...result.consensus.dismissedItems];

						const entry: CycleHistory = {
							cycle,
							consensus: result.consensus,
							fixerName: undefined,
							fixCommit: undefined,
						};
						history.push(entry);

						// --- Check if clean ---
						if (result.consensus.verdict === "APPROVE" && result.consensus.criticalCount === 0 && result.consensus.warningCount === 0) {
							phase = "all clean";
							renderWidget(ctx);
							await killAgent(result.winner).catch(() => {});
							activeAgents = [];
							pi.sendUserMessage(formatFinalReport(history));
							return;
						}

						// --- Winner fixes the issues (it has full context) ---
						phase = `${result.winnerName} fixing issues`;
						cycleInfo = `[cycle ${cycle}/${config.maxCycles}]`;
						activeAgents = [result.winner];
						renderWidget(ctx);

						entry.fixerName = result.winnerName;
						const onProgress = () => throttledRenderWidget(ctx);

						try {
							const fixPrompt = buildFixPrompt(result.consensus, config.mergeBase);
							await rpcPromptAndWait(result.winner, fixPrompt, onProgress);

							// Get the latest commit hash (winner should have committed)
							const commitResult = await pi.exec("git", ["rev-parse", "--short", "HEAD"], { timeout: 5000 });
							entry.fixCommit = commitResult.code === 0 ? commitResult.stdout.trim() : undefined;
						} finally {
							// Kill the winner — next cycle gets fresh reviewers
							await killAgent(result.winner).catch(() => {});
							activeAgents = [];
						}

						phase = `cycle ${cycle} complete, starting next review`;
						renderWidget(ctx);
					}

					// Max cycles reached
					phase = "max cycles reached";
					renderWidget(ctx);
					pi.sendUserMessage(formatFinalReport(history));

				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`PR review loop failed: ${msg}`, "error");
					if (history.length > 0) {
						pi.sendUserMessage(
							`PR review loop failed after ${history.length} cycle(s): ${msg}\n\nPartial report:\n\n${formatFinalReport(history)}`,
						);
					}
				} finally {
					await cleanupAll(ctx);
				}
			})();
		},
	});

	// -- Lifecycle ------------------------------------------------------------

	async function cleanupAll(ctx: ExtensionContext) {
		stopWidgetTimer();
		for (const agent of activeAgents) {
			await killAgent(agent).catch(() => {});
		}
		activeAgents = [];
		phase = "";
		cycleInfo = "";
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	pi.on("session_shutdown", async () => {
		stopWidgetTimer();
		for (const agent of activeAgents) {
			await killAgent(agent).catch(() => {});
		}
		activeAgents = [];
	});
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

async function requireMergeBase(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string> {
	ctx.ui.setStatus("pr-review", "Getting merge base...");
	const mergeBase = await getMergeBase(pi);
	ctx.ui.setStatus("pr-review", undefined);

	if (!mergeBase) {
		ctx.ui.notify("Could not find merge base. Are you on a branch with changes vs main?", "error");
		return "";
	}
	return mergeBase;
}

async function getMergeBase(pi: ExtensionAPI): Promise<string | null> {
	const result = await pi.exec("git", ["merge-base", "HEAD", "origin/main"], { timeout: 10_000 });
	if (result.code === 0 && result.stdout.trim()) return result.stdout.trim();
	const fallback = await pi.exec("git", ["merge-base", "HEAD", "main"], { timeout: 10_000 });
	if (fallback.code === 0 && fallback.stdout.trim()) return fallback.stdout.trim();
	return null;
}

/**
 * Count how many **Agreed** or **Partially agreed** markers in a debate response.
 * This tells us how many of the opponent's points this reviewer accepted.
 */
function countAgreements(debateResponse: string): number {
	const agreed = (debateResponse.match(/\*\*Agreed\*\*/gi) || []).length;
	const partial = (debateResponse.match(/\*\*Partially agreed\*\*/gi) || []).length;
	// Partial counts as half — fully agreed points weigh more
	return agreed + partial * 0.5;
}

function parseConsensus(raw: string): ConsensusReport {
	const verdict = /###\s*Verdict:\s*(APPROVE|CHANGES REQUIRED)/i.exec(raw);
	const criticalSection = raw.match(/###\s*Critical Issues[\s\S]*?(?=###|$)/i)?.[0] || "";
	const warningSection = raw.match(/###\s*Warnings[\s\S]*?(?=###|$)/i)?.[0] || "";
	const dismissedSection = raw.match(/###\s*(?:Dismissed Non-Issues|Agreed Non-Issues)[\s\S]*?(?=###|$)/i)?.[0] || "";

	const countItems = (section: string): number => {
		if (/none/i.test(section) && !/\d+\.\s/.test(section)) return 0;
		return (section.match(/^\d+\.\s/gm) || []).length;
	};

	const extractItems = (section: string): string[] => {
		if (/none/i.test(section) && !/\d+\.\s/.test(section)) return [];
		const items: string[] = [];
		for (const m of section.matchAll(/^\d+\.\s+(.+)/gm)) {
			if (m[1]) items.push(m[1].trim());
		}
		return items;
	};

	return {
		raw,
		verdict: verdict?.[1]?.toUpperCase() === "APPROVE" ? "APPROVE" : "CHANGES REQUIRED",
		criticalCount: countItems(criticalSection),
		warningCount: countItems(warningSection),
		dismissedItems: extractItems(dismissedSection),
	};
}

function buildFixPrompt(consensus: ConsensusReport, mergeBase: string): string {
	return `You just completed a code review and debate. Now fix all the Critical and Warning issues from the consensus you wrote. Do NOT fix Suggestions — those are optional.

You already have the diff and files in context from the review. If you need to re-read anything, use your tools.

After fixing all issues, run any available checks (e.g., \`npm run check\`, \`npm test\`, lint) to verify your fixes don't break anything.

Then stage ONLY the files you changed and commit with a message like:
"fix: address review findings (critical: ${consensus.criticalCount}, warnings: ${consensus.warningCount})"

Do NOT use \`git add -A\` or \`git add .\` — only add the specific files you modified.

Here are the issues to fix:

${consensus.raw}`;
}

function formatFinalReport(history: CycleHistory[]): string {
	const lines: string[] = ["# PR Review Loop Report", ""];
	const last = history[history.length - 1];

	if (last && last.consensus.verdict === "APPROVE" && last.consensus.criticalCount === 0 && last.consensus.warningCount === 0) {
		lines.push(`**Result: APPROVED after ${history.length} cycle${history.length > 1 ? "s" : ""}**`);
	} else {
		lines.push(`**Result: ${history.length} cycle${history.length > 1 ? "s" : ""} completed, issues remain**`);
	}
	lines.push("");

	for (const entry of history) {
		lines.push(`## Cycle ${entry.cycle}`);
		lines.push("");
		lines.push(`- **Verdict**: ${entry.consensus.verdict}`);
		lines.push(`- **Critical**: ${entry.consensus.criticalCount}`);
		lines.push(`- **Warnings**: ${entry.consensus.warningCount}`);
		if (entry.fixerName) {
			lines.push(`- **Fixed by**: ${entry.fixerName}`);
		}
		if (entry.fixCommit) {
			lines.push(`- **Fix commit**: ${entry.fixCommit}`);
		}
		if (entry.consensus.dismissedItems.length > 0) {
			lines.push(`- **Dismissed**: ${entry.consensus.dismissedItems.length} items`);
		}
		lines.push("");
	}

	if (last) {
		lines.push("## Final Consensus");
		lines.push("");
		lines.push(last.consensus.raw);
	}

	return lines.join("\n");
}
