/**
 * The coordinator: ports the workflow-script.js topology onto owned coordination.
 * Comprehension (orient ×2 → reconcile) → Review (perspectives, K-round loop) →
 * Synthesis → Verification. Uses createAgentSession subagents (subagent.ts), a
 * concurrency pool, per-agent-type models, and the live monitor.
 */

import type { Assets, Manifest } from "./assets.ts";
import { PERSPECTIVES } from "./assets.ts";
import type { ModelConfig, Role } from "./models.ts";
import { resolveModel } from "./models.ts";
import type { Monitor } from "./monitor.ts";
import { pool } from "./pool.ts";
import { runSubagent } from "./subagent.ts";

// biome-ignore lint/suspicious/noExplicitAny: JSON payloads / opaque Model + rt
type Any = any;

const MAX_SUBMIT_ATTEMPTS = 3;

export interface RepoInput {
	repo: string;
	slug: string;
	bundle: string;
	path: string;
}

export interface ReviewInput {
	charge: string;
	repos: RepoInput[];
	manifest: Manifest;
	assets: Assets;
	modelConfig: ModelConfig;
	rt: Any;
	hostModel: Any;
	monitor: Monitor;
	notes: string[]; // model-resolution / coverage notes, appended in place
}

function sanitizeCharge(charge: string): string {
	return charge.replace(/[\r\n]+/g, " ").replace(/---/g, "—").replace(/```/g, "'''").replace(/`/g, "'").trim();
}

function schemaBlock(schema: Any): string {
	return (
		"\n\nYou MUST deliver your result by calling the submit_result tool with an object conforming to this JSON Schema. " +
		"Do NOT print the JSON in your reply — your turn ends only when submit_result accepts your object. " +
		"If it returns validation errors, fix the object and call submit_result again:\n" +
		`\`\`\`json\n${JSON.stringify(schema)}\n\`\`\``
	);
}

function catalogNote(manifest: Manifest, kinds?: string[]): string {
	const items = kinds ? manifest.context.filter((c) => kinds.includes(c.kind)) : manifest.context;
	if (!items.length) return "";
	return (
		"Reference material (read the paths relevant to your task; do not assume their contents):\n" +
		items.map((c) => `- [${c.kind}] ${c.id} — ${c.title}: ${c.path}`).join("\n") +
		"\n\n"
	);
}

export async function runReview(input: ReviewInput): Promise<Any> {
	const { assets, manifest, monitor, rt, hostModel, modelConfig, notes } = input;
	const cfg = assets.config;
	const charge = sanitizeCharge(input.charge);
	const cwd = input.repos[0]?.path ?? process.cwd();
	const concurrency = cfg.workflow.concurrency ?? 6;
	const roundTimeout = cfg.workflow.roundTimeoutMs ?? 60000;
	const longTimeout = roundTimeout * 3; // orient/reconcile/synthesis get more room than a single reviewer round
	const K = cfg.workflow.maxRounds ?? 3;
	const checkCancel = () => {
		if (monitor.cancelled) throw new Error("review cancelled by user");
	};

	const model = (role: Role) => {
		const r = resolveModel(role, modelConfig, rt, hostModel);
		if (r.note) notes.push(`${role}: ${r.note}`);
		return r.model;
	};
	const bundleContext = input.repos.map((r) => `Repo: ${r.repo}, bundle (read this): ${r.bundle}, local path: ${r.path}`).join("\n");
	const orientContext = catalogNote(manifest);

	// ---- Comprehension ----
	monitor.phase = "comprehension";
	const orientModel = model("orienteer");
	const orientA = monitor.register("orient-a", "orienteer");
	const orientB = monitor.register("orient-b", "orienteer");
	const [oa, ob] = await pool(
		[
			{ a: orientA, persona: assets.personas.orienteerA, dir: "Trace how the change delivers the charge (outside-in)." },
			{ a: orientB, persona: assets.personas.orienteerB, dir: "Reconstruct what the change does, then reconcile against the charge (inside-out)." },
		],
		concurrency,
		(t) =>
			runSubagent({
				activity: t.a,
				monitor,
				rt,
				model: orientModel,
				cwd,
				systemPrompt: t.persona,
				userPrompt: `Charge: ${charge}\n\n${orientContext}Change set:\n${bundleContext}\n\n${t.dir}${schemaBlock(assets.schemas.orientation)}`,
				schema: assets.schemas.orientation,
				maxAttempts: MAX_SUBMIT_ATTEMPTS,
				timeoutMs: longTimeout,
			}),
	);
	checkCancel();
	// Fail-fast: comprehension can't proceed if BOTH orienteers failed.
	if (!oa && !ob) {
		throw new Error(`Comprehension failed — both orienteers failed (A: ${orientA.fail ?? "?"}; B: ${orientB.fail ?? "?"}).`);
	}
	const orientationA = oa ?? { model: "(orienteer A failed)", clear_alignment: [], unclear_alignment: [] };
	const orientationB = ob ?? { model: "(orienteer B failed)", clear_alignment: [], unclear_alignment: [] };

	// ---- Reconcile ----
	const recon = monitor.register("reconciler", "reconciler");
	const seamMap = await runSubagent({
		activity: recon,
		monitor,
		rt,
		model: model("reconciler"),
		cwd,
		systemPrompt: assets.personas.reconciler,
		userPrompt:
			`Charge: ${charge}\n\nSeam bounds: ${cfg.reconciler.minSeams}-${cfg.reconciler.maxSeams} seams.\n\n` +
			`Orienteer A (claim→code):\n${JSON.stringify(orientationA)}\n\nOrienteer B (code→claim):\n${JSON.stringify(orientationB)}\n\n` +
			`Merge these into a unified orientation and seam map.${schemaBlock(assets.schemas.seamMap)}`,
		schema: assets.schemas.seamMap,
		maxAttempts: MAX_SUBMIT_ATTEMPTS,
		timeoutMs: longTimeout,
	});
	checkCancel();
	if (!seamMap) throw new Error(`Comprehension failed — reconciler produced no seam map (${recon.fail ?? "?"}).`);

	// ---- Review: K-round loop per perspective, perspectives in parallel ----
	checkCancel();
	monitor.phase = "review";
	const reviewResults = await pool(PERSPECTIVES as unknown as string[], concurrency, async (perspective) => {
		const a = monitor.register(perspective, perspective, K);
		const reviewerModel = model("reviewer");
		const system = `${assets.personas.commonRules}\n\n---\n\n${assets.personas.reviewers[perspective]}`;
		let findingsSoFar: Any[] = [];
		let result: Any = null;
		for (let round = 1; round <= K; round++) {
			if (monitor.cancelled) return { perspective, findings: findingsSoFar, spillover: true, moreExploration: false, note: "cancelled" };
			a.round = round;
			const isLast = round === K;
			let adrContext = "";
			if (perspective === "adr") {
				const adrItems = manifest.context.filter((c) => c.kind === "adr");
				adrContext = adrItems.length
					? `ADR context: ${adrItems.length} accepted ADR(s) staged below; read each path.\n\n${catalogNote(manifest, ["adr"])}`
					: "ADR context: No ADRs provided.\n\n";
			}
			const userPrompt =
				`Charge: ${charge}\n\nMax findings: ${cfg.reviewer.maxFindings}\n\n${adrContext}` +
				`Orientation:\n${seamMap.merged_orientation}\n\nSeam map:\n${JSON.stringify(seamMap.seams)}\n\n` +
				`Round ${round} of ${K}${isLast ? " (FINAL — must produce write-up)" : ""}\n\n` +
				`Change set:\n${bundleContext}\n\n` +
				(findingsSoFar.length ? `Findings so far:\n${JSON.stringify(findingsSoFar)}\n\n` : "") +
				`Review from the ${perspective} perspective. Focus on high-priority seams.${schemaBlock(assets.schemas.reviewer)}`;
			result = await runSubagent({
				activity: a,
				monitor,
				rt,
				model: reviewerModel,
				cwd,
				systemPrompt: system,
				userPrompt,
				schema: assets.schemas.reviewer,
				maxAttempts: MAX_SUBMIT_ATTEMPTS,
				timeoutMs: longTimeout,
			});
			if (!result) {
				return { perspective, findings: findingsSoFar, spillover: true, moreExploration: false, note: `incomplete (round ${round}): ${a.fail ?? "failed"}` };
			}
			findingsSoFar = result.findings ?? [];
			if (!result.moreExploration || isLast) return result;
		}
		return result;
	});

	// surface any reviewer that did not complete cleanly (reason → coverage notes)
	for (const p of PERSPECTIVES) {
		const a = monitor.registry.get(p);
		if (a && a.state !== "done") notes.push(`reviewer ${p}: ${a.fail ?? a.state}`);
	}

	// ---- Synthesis ----
	checkCancel();
	monitor.phase = "synthesis";
	const synth = monitor.register("synthesizer", "synthesizer");
	const synthesis = await runSubagent({
		activity: synth,
		monitor,
		rt,
		model: model("synthesizer"),
		cwd,
		systemPrompt: assets.personas.synthesizer,
		userPrompt:
			`Charge: ${charge}\n\nFollow-up threshold: ≥${cfg.synthesis.followUpThreshold} Major/Blocker findings triggers a recommendation.\n\n` +
			`Orientation:\n${seamMap.merged_orientation}\n\nSeam map:\n${JSON.stringify(seamMap.seams)}\n\n` +
			`Reviewer outputs:\n${JSON.stringify(reviewResults)}\n\n` +
			`Synthesize: consolidate findings (preserve priorities), produce a charge verdict, account for every seam ` +
			`(cleared/finding/under-explored), recommend follow-up if triggered.${schemaBlock(assets.schemas.synthesis)}`,
		schema: assets.schemas.synthesis,
		maxAttempts: MAX_SUBMIT_ATTEMPTS,
		timeoutMs: longTimeout,
	});
	if (!synthesis) throw new Error(`Synthesis failed — no report produced (${synth.fail ?? "?"}).`);

	// ---- Verification: confirm Blocker/Major findings in parallel ----
	checkCancel();
	monitor.phase = "verification";
	const toVerify: Any[] = (synthesis.consolidated_findings ?? []).filter((f: Any) => f.severity === "Blocker" || f.severity === "Major");
	const verifyModel = model("verifier");
	const verdicts = await pool(toVerify, concurrency, (finding, idx) => {
		const a = monitor.register(`verify:${idx}`, "verifier");
		return runSubagent({
			activity: a,
			monitor,
			rt,
			model: verifyModel,
			cwd,
			systemPrompt: assets.personas.verifier,
			userPrompt: `Change set:\n${bundleContext}\n\nFinding to verify:\n${JSON.stringify(finding, null, 2)}\n\nVerify this finding by reading the actual code at the cited location.${schemaBlock(assets.schemas.verifier)}`,
			schema: assets.schemas.verifier,
			maxAttempts: MAX_SUBMIT_ATTEMPTS,
			timeoutMs: roundTimeout,
		});
	});

	const verified: Any[] = [];
	const dismissed: Any[] = [];
	toVerify.forEach((finding, idx) => {
		const v = verdicts[idx];
		if (!v) verified.push({ ...finding, confidence: "low", verification: "unverified" });
		else if (v.outcome === "dismiss") dismissed.push({ ...finding, verification: "dismissed", dismissal_reason: v.explanation });
		else if (v.outcome === "correct") verified.push({ ...finding, ...v.corrections, verification: "corrected" });
		else verified.push({ ...finding, verification: "confirmed" });
	});
	const minorAndNits = (synthesis.consolidated_findings ?? []).filter((f: Any) => f.severity !== "Blocker" && f.severity !== "Major");

	monitor.phase = "done";
	return {
		...synthesis,
		consolidated_findings: [...verified, ...minorAndNits],
		dismissed_findings: dismissed,
		verification_stats: {
			verified: toVerify.length,
			confirmed: verified.filter((f) => f.verification === "confirmed").length,
			corrected: verified.filter((f) => f.verification === "corrected").length,
			dismissed: dismissed.length,
			unverified: verified.filter((f) => f.verification === "unverified").length,
		},
		coverage_notes: notes,
	};
}
