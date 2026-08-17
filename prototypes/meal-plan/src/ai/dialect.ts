/**
 * Schema dialect adapters.
 *
 * The canonical schema in `schema.ts` is authored in Gemini's dialect, which is
 * the more permissive of the two. Anthropic's structured outputs accept a
 * narrower subset, so the same schema has to be translated rather than shared
 * verbatim:
 *
 *   nullable   Gemini  type: ["string", "null"]
 *              Claude  anyOf: [{type:"string"}, {type:"null"}]
 *   bounds     Gemini  minimum / maximum / minItems / maxItems supported
 *              Claude  unsupported — must be stripped, then enforced in code
 *
 * The stripped bounds are not lost: `validate.ts` re-checks them on the parsed
 * plan, so both providers end up held to the same standard. The schema is a
 * fast path, never the guarantee.
 */

type Json = Record<string, unknown>;

const UNSUPPORTED_BY_ANTHROPIC = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
] as const;

/** Deep-clone a JSON schema, applying `transform` to every object node. */
function mapSchema(node: unknown, transform: (n: Json) => Json): unknown {
  if (Array.isArray(node)) return node.map((n) => mapSchema(n, transform));
  if (node === null || typeof node !== "object") return node;

  const mapped: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    mapped[key] = mapSchema(value, transform);
  }
  return transform(mapped);
}

/**
 * Convert the canonical schema into the subset Anthropic accepts.
 * Idempotent, so running it twice is harmless.
 */
export function toAnthropicDialect(schema: Json): Json {
  return mapSchema(schema, (node) => {
    const out: Json = { ...node };

    for (const key of UNSUPPORTED_BY_ANTHROPIC) delete out[key];

    // type: ["string", "null"]  ->  anyOf: [{type:"string"}, {type:"null"}]
    if (Array.isArray(out.type)) {
      const types = out.type as string[];
      const rest = { ...out };
      delete rest.type;
      delete rest.description;
      return {
        anyOf: types.map((t) => ({ type: t, ...rest })),
        ...(out.description ? { description: out.description } : {}),
      };
    }
    return out;
  }) as Json;
}

/** Gemini takes the canonical schema unchanged; this exists to name that. */
export function toGeminiDialect(schema: Json): Json {
  return schema;
}
