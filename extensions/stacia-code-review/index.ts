/**
 * stacia-code-review — custom coordinator extension.
 *
 * The model runs the scope/charge conversation, then calls the `code_review`
 * tool with structured args. The tool owns the whole run: allocate the run dir,
 * build bundles + stage ADRs (via code-review-workdir.py), fan out read-only
 * subagents through the coordinator, paint the live monitor, and write the
 * report. Press f8 during a run to drill into agents and kill them.
 */

import * as fs from "node:fs";
import { type ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { addContext, buildBundle, initRun, loadAssets, type Manifest, writeFindings, writeReport } from "./assets.ts";
import { type RepoInput, runReview } from "./coordinator.ts";
import { loadModelConfig } from "./models.ts";
import { Monitor } from "./monitor.ts";

// biome-ignore lint/suspicious/noExplicitAny: SDK ctx / JSON payloads
type Any = any;

const RepoParam = Type.Object({
	path: Type.String({ description: "Absolute local path to the git repo" }),
	source: Type.String({ description: "Change set: pr:<id> | range:<base>...<head> | worktree | worktree:staged" }),
});
const AdrParam = Type.Object({
	id: Type.String({ description: "ADR id (used as filename), e.g. 0001" }),
	title: Type.String({ description: "ADR title" }),
	path: Type.String({ description: "Absolute local path to the accepted ADR markdown file" }),
});
const Params = Type.Object({
	charge: Type.String({ description: "What the change claims to accomplish (REQUIRED; never inferred from the diff)." }),
	repos: Type.Array(RepoParam, { description: "Repos + change set specs to review." }),
	adrs: Type.Optional(Type.Array(AdrParam, { description: "Accepted ADRs to stage as review context." })),
});

function renderReport(charge: string, s: Any): string {
	const bySev = (sev: string) => (s.consolidated_findings ?? []).filter((f: Any) => f.severity === sev);
	const findingMd = (f: Any) =>
		`- **${f.severity}** (${f.confidence ?? "?"}${f.verification ? `, ${f.verification}` : ""}) ` +
		`\`${f.location?.file ?? "?"}:${f.location?.line ?? "?"}\`${f.corroborated_by ? ` — corroborated by ${f.corroborated_by.join(", ")}` : ""}\n` +
		`  - ${f.finding}\n  - _why:_ ${f.rationale}${f.suggestion ? `\n  - _fix:_ ${f.suggestion}` : ""}`;
	const lines: string[] = [];
	lines.push(`# Code Review\n`);
	lines.push(`**Charge:** ${charge}\n`);
	lines.push(`**Verdict:** ${s.verdict ?? "?"} — ${s.verdict_rationale ?? ""}\n`);
	if (s.summary) lines.push(`> ${s.summary}\n`);
	const top = [...bySev("Blocker"), ...bySev("Major")];
	lines.push(`## Top Priorities (${top.length})\n`);
	lines.push(top.length ? top.map(findingMd).join("\n") : "_None._");
	lines.push(`\n## All Findings\n`);
	for (const sev of ["Blocker", "Major", "Minor", "Nit"]) {
		const fs2 = bySev(sev);
		if (fs2.length) lines.push(`### ${sev} (${fs2.length})\n${fs2.map(findingMd).join("\n")}\n`);
	}
	const underExplored = (s.seam_accounting ?? []).filter((x: Any) => x.state === "under-explored");
	lines.push(`## Coverage Caveats\n`);
	const caveats = [...(s.caveats ?? []), ...underExplored.map((x: Any) => `Seam ${x.seam_id} under-explored${x.note ? `: ${x.note}` : ""}`), ...(s.coverage_notes ?? [])];
	lines.push(caveats.length ? caveats.map((c: string) => `- ${c}`).join("\n") : "_None._");
	if (s.follow_up_recommended) lines.push(`\n## Follow-up Recommended\n${s.follow_up_reason ?? ""}`);
	if (s.dismissed_findings?.length) lines.push(`\n## Dismissed (${s.dismissed_findings.length})\n` + s.dismissed_findings.map((f: Any) => `- \`${f.location?.file}:${f.location?.line}\` — ${f.finding} (_${f.dismissal_reason}_)`).join("\n"));
	return `${lines.join("\n")}\n`;
}

interface ReviewParams {
	charge: string;
	repos: Array<{ path: string; source: string }>;
	adrs?: Array<{ id: string; title: string; path: string }>;
}

export default function staciaCodeReview(pi: ExtensionAPI) {
	let active: Monitor | null = null;

	// Shared review core used by BOTH the code_review tool and the
	// /stacia-code-review command. Returns the synthesis + written report path.
	async function performReview(ctx: Any, params: ReviewParams, signal?: AbortSignal) {
		if (!params.charge?.trim()) throw new Error("a charge is required (what the change claims to accomplish)");
		if (!params.repos?.length) throw new Error("at least one repo is required");
		if (!ctx.model) throw new Error("no active model");

		const assets = loadAssets();
		const repoIds = params.repos.map((r) => r.path.replace(/\/+$/, "").split("/").pop() || "repo");
		const manifest: Manifest = await initRun(assets.helper, repoIds);
		const repos: RepoInput[] = [];
		for (let i = 0; i < params.repos.length; i++) {
			const m = manifest.repos[i];
			await buildBundle(assets.helper, manifest.run_dir, m.slug, params.repos[i].path, params.repos[i].source, signal);
			repos.push({ repo: m.repo, slug: m.slug, bundle: m.bundle, path: params.repos[i].path });
		}
		for (const adr of params.adrs ?? []) {
			const body = fs.readFileSync(adr.path, "utf8");
			const staged = await addContext(assets.helper, manifest.run_dir, "adr", adr.id, adr.title, body);
			manifest.context.push({ id: adr.id, kind: "adr", title: adr.title, path: staged });
		}

		const monitor = new Monitor();
		active = monitor;
		monitor.start(ctx);
		const onAbort = () => {
			for (const a of monitor.registry.values()) {
				if (a.state === "running" || a.state === "queued") {
					a.state = "killed";
					a.session?.abort?.();
				}
			}
		};
		signal?.addEventListener?.("abort", onAbort);

		const notes: string[] = [];
		try {
			const rt = await ModelRuntime.create();
			const modelConfig = loadModelConfig(ctx.cwd, ctx.isProjectTrusted?.() ?? false);
			const synthesis = await runReview({ charge: params.charge, repos, manifest, assets, modelConfig, rt, hostModel: ctx.model, monitor, notes });
			await writeFindings(assets.helper, manifest.run_dir, "synthesis", JSON.stringify(synthesis, null, 2));
			const report = await writeReport(assets.helper, manifest.run_dir, renderReport(params.charge, synthesis));
			const findings = synthesis.consolidated_findings ?? [];
			const counts = ["Blocker", "Major", "Minor", "Nit"].map((s) => `${findings.filter((f: Any) => f.severity === s).length} ${s}`).join(" · ");
			return { synthesis, counts, report, run_dir: manifest.run_dir };
		} finally {
			signal?.removeEventListener?.("abort", onAbort);
			monitor.stop(ctx);
			active = null;
		}
	}

	pi.registerShortcut("f8", {
		description: "code-review: drill into running agents",
		handler: async (ctx) => {
			if (!active) {
				ctx.ui.notify("code-review: no run in progress", "warning");
				return;
			}
			await active.openOverlay(ctx);
		},
	});

	// Interactive scope-gathering for the /stacia-code-review command.
	async function gatherParams(ctx: Any, argStr: string): Promise<ReviewParams | null> {
		const charge = (argStr?.trim() || (await ctx.ui.input("Charge — what does this change claim to accomplish?", "")) || "").trim();
		if (!charge) {
			ctx.ui.notify("code review: a charge is required", "warning");
			return null;
		}
		const repoPath = (await ctx.ui.input("Repo path", ctx.cwd)) || ctx.cwd;
		const kind = await ctx.ui.select("Change set", ["Uncommitted (worktree)", "Staged only", "Pull request", "Branch range"]);
		if (!kind) return null;
		let source = "worktree";
		if (kind === "Staged only") source = "worktree:staged";
		else if (kind === "Pull request") {
			const id = await ctx.ui.input("PR number or URL", "");
			if (!id) return null;
			source = `pr:${id}`;
		} else if (kind === "Branch range") {
			const rng = await ctx.ui.input("Range base...head", "origin/main...HEAD");
			if (!rng) return null;
			source = `range:${rng}`;
		}
		return { charge, repos: [{ path: repoPath, source }], adrs: [] };
	}

	pi.registerCommand("stacia-code-review", {
		description: "Run a multi-perspective code review of a change set (prompts for scope + charge)",
		handler: async (argStr: string, ctx: Any) => {
			try {
				const params = await gatherParams(ctx, argStr);
				if (!params) return;
				ctx.ui.notify("code review: starting… (press f8 to drill in, esc to cancel)", "info");
				const controller = new AbortController();
				const { synthesis, counts, report, run_dir } = await performReview(ctx, params, controller.signal);
				ctx.ui.notify(`code review: ${synthesis.verdict} — ${counts}`, "info");
				ctx.ui.notify(`report: ${report.split("\n")[0]}  (run ${run_dir})`, "info");
			} catch (e) {
				ctx.ui.notify(`code review failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "code_review",
		label: "Code Review",
		description:
			"Run a bounded, read-only, multi-perspective code review of a change set. Requires a charge (what the change claims to accomplish). Gather scope + charge conversationally first, then call this once.",
		promptSnippet: "Run a multi-perspective code review of a change set (requires a stated charge)",
		promptGuidelines: [
			"Use code_review only after you have a stated charge and the repos + change-set specs; never infer the charge from the diff.",
		],
		parameters: Params,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { synthesis, counts, report, run_dir } = await performReview(ctx, params as ReviewParams, signal);
			const text = `Review complete — verdict: **${synthesis.verdict}**. ${counts}. Report: ${report.split("\n")[0]} (run dir ${run_dir}).`;
			return { content: [{ type: "text", text }], details: { verdict: synthesis.verdict, counts, report, run_dir, synthesis } };
		},
		renderResult(result: Any, _opts: Any, theme: Any) {
			const d = result.details ?? {};
			if (!d.verdict) {
				const t = result.content?.[0];
				return new Text(t?.type === "text" ? t.text : "done", 0, 0);
			}
			const color = d.verdict === "met" ? "success" : d.verdict === "partial" ? "warning" : "error";
			const lines = [
				theme.fg(color, theme.bold(`Code review: ${d.verdict}`)),
				theme.fg("muted", d.counts ?? ""),
				theme.fg("dim", `report: ${(d.report ?? "").split("\n")[0]}`),
			];
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
