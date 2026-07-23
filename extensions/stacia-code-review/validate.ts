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
			errs.push(`${path}: expected ${types.join("|")}, got ${typeOf(value)}`);
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

/** Inject config-driven bounds into schema objects (mutates copies at load). */
export function injectBounds(
	schemas: { seamMap: Json; reviewer: Json },
	cfg: { reconciler: { minSeams: number; maxSeams: number }; reviewer: { maxFindings: number } },
): void {
	const seams = schemas.seamMap?.properties?.seams;
	if (seams) {
		seams.minItems = cfg.reconciler.minSeams;
		seams.maxItems = cfg.reconciler.maxSeams;
	}
	const findings = schemas.reviewer?.properties?.findings;
	if (findings) findings.maxItems = cfg.reviewer.maxFindings;
}
