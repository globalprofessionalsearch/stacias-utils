/**
 * Self-contained JSON-Schema validator — the "least dependency" schema check
 * used by BOTH the agent-side submit_result gate and the coordinator's
 * re-validation. Covers the subset our schemas actually use: type, required,
 * enum, properties (recurse), items (recurse), minItems/maxItems.
 *
 * Returns [] when valid, or a list of human-readable error strings (fed back to
 * the agent so it can self-correct).
 */

// biome-ignore lint/suspicious/noExplicitAny: schema + value are arbitrary JSON
type Json = any;

function typeOf(v: Json): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	if (Number.isInteger(v)) return "integer";
	return typeof v; // string | number | boolean | object | undefined
}

function typeMatches(v: Json, t: string): boolean {
	const actual = typeOf(v);
	if (t === "number") return actual === "number" || actual === "integer";
	if (t === "integer") return actual === "integer";
	return actual === t;
}

export function validate(value: Json, schema: Json, path = "$"): string[] {
	const errs: string[] = [];
	if (!schema || typeof schema !== "object") return errs;

	if (schema.type) {
		const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((t) => typeMatches(value, t))) {
			let hint = "";
			if (types.includes("object") && schema.properties) {
				const keys = Object.keys(schema.properties);
				hint = ` — expected an object with properties {${keys.join(", ")}}`;
			}
			errs.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}${hint}`);
			return errs; // type wrong → downstream checks are noise
		}
	}

	if (schema.enum && !schema.enum.includes(value)) {
		errs.push(`${path}: "${value}" not in [${schema.enum.join(", ")}]`);
	}

	if (typeOf(value) === "object" && (schema.properties || schema.required)) {
		for (const req of schema.required ?? []) {
			if (value[req] === undefined) errs.push(`${path}: missing required "${req}"`);
		}
		for (const [key, sub] of Object.entries(schema.properties ?? {})) {
			if (value[key] !== undefined) errs.push(...validate(value[key], sub, `${path}.${key}`));
		}
	}

	if (typeOf(value) === "array") {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			errs.push(`${path}: needs ≥ ${schema.minItems} items, got ${value.length}`);
		}
		if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
			errs.push(`${path}: allows ≤ ${schema.maxItems} items, got ${value.length}`);
		}
		if (schema.items) {
			value.forEach((item: Json, i: number) => errs.push(...validate(item, schema.items, `${path}[${i}]`)));
		}
	}

	return errs;
}

/**
 * A bound stated in prose, for the schema's `description`.
 *
 * `minItems`/`maxItems` stay the machine-checked contract; this is the same
 * bound said in words so the model reads it as an instruction rather than as
 * a keyword it has to notice. Kept to one fixed sentence shape so
 * `describeBound` can recognise and replace its own prior output.
 */
function boundSentence(min: number | undefined, max: number): string {
	if (min === undefined) return `Return at most ${max} items.`;
	if (min === max) return `Return exactly ${max} items.`;
	return `Return between ${min} and ${max} items.`;
}

/** Matches any sentence `boundSentence` could have produced, at end of string. */
const BOUND_SENTENCE = /\s*Return (?:at most \d+|exactly \d+|between \d+ and \d+) items\.$/;

/**
 * Restate an array bound in `node.description`, replacing (not stacking) any
 * bound sentence a previous call left there.
 *
 * Why prose as well as keywords: `injectBounds` is the only place the config's
 * `minSeams`/`maxSeams`/`maxFindings` reach the model, and a bound the model
 * never internalises is a bound paid for in retries. The keywords remain the
 * enforcement mechanism — `validate()` above, and the SDK's own Ajv pass — but
 * prose is the part that survives any schema sanitisation between us and the
 * model, and it is what makes `minSeams: 3` read as "a floor that forces
 * diligence" rather than as a number to be clipped to.
 */
function describeBound(node: Json, sentence: string): void {
	const base = String(node.description ?? "")
		.replace(BOUND_SENTENCE, "")
		.trimEnd();
	node.description = base ? `${base} ${sentence}` : sentence;
}

/**
 * Inject config-driven bounds into schema objects (mutates copies at load).
 *
 * Writes each bound twice — as `minItems`/`maxItems`, and as a sentence in the
 * neighbouring `description`. Idempotent: re-running with a different config
 * replaces the previous sentence rather than appending a second one.
 */
export function injectBounds(
	schemas: { seamMap: Json; reviewer: Json },
	cfg: { reconciler: { minSeams: number; maxSeams: number }; reviewer: { maxFindings: number } },
): void {
	const seams = schemas.seamMap?.properties?.seams;
	if (seams) {
		seams.minItems = cfg.reconciler.minSeams;
		seams.maxItems = cfg.reconciler.maxSeams;
		describeBound(seams, boundSentence(cfg.reconciler.minSeams, cfg.reconciler.maxSeams));
	}
	const findings = schemas.reviewer?.properties?.findings;
	if (findings) {
		findings.maxItems = cfg.reviewer.maxFindings;
		describeBound(findings, boundSentence(undefined, cfg.reviewer.maxFindings));
	}
}
