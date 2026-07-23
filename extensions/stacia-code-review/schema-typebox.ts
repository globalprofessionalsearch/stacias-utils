/**
 * Convert our JSON Schemas (the single source of truth) into typebox schemas so
 * the submit_result tool advertises the real expected shape to the model — the
 * fields, types, enums, and required-ness are visible in the tool signature.
 * This is what makes the model reliably CALL submit_result with the right object
 * (the spike proved the pattern with explicit typed params; a generic bag does
 * not work). Supports the subset our schemas use.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";

// biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON schema
type Json = any;

export function toTypebox(s: Json): TSchema {
	if (!s || typeof s !== "object") return Type.Unknown();
	const opts = s.description ? { description: String(s.description) } : {};
	const t = Array.isArray(s.type) ? s.type[0] : s.type;

	if (Array.isArray(s.enum) && (t === "string" || t === undefined)) {
		return StringEnum(s.enum as string[]);
	}

	switch (t) {
		case "object": {
			const required: string[] = Array.isArray(s.required) ? s.required : [];
			const props: Record<string, TSchema> = {};
			for (const [k, sub] of Object.entries(s.properties ?? {})) {
				const tb = toTypebox(sub);
				props[k] = required.includes(k) ? tb : Type.Optional(tb);
			}
			return Type.Object(props, opts);
		}
		case "array": {
			const arrOpts: Json = { ...opts };
			if (typeof s.minItems === "number") arrOpts.minItems = s.minItems;
			if (typeof s.maxItems === "number") arrOpts.maxItems = s.maxItems;
			return Type.Array(s.items ? toTypebox(s.items) : Type.Unknown(), arrOpts);
		}
		case "integer":
			return Type.Integer(opts);
		case "number":
			return Type.Number(opts);
		case "boolean":
			return Type.Boolean(opts);
		case "string":
			return Type.String(opts);
		default:
			return Type.Unknown();
	}
}
