/**
 * Client-side validation for `ComponentNode.props` against a
 * `ComponentTypeDefinition.prop_schema`.
 *
 * The substrate stores `props` as opaque JSON and stores `prop_schema` as
 * opaque JSON Schema — server-side enforcement is post-v1 per
 * `docs/PEAR_COMPONENT_NODE_SCHEMA.md` § Prop-schema validation. This module
 * is the client-side authority that fills the gap: every renderer / editor /
 * AI authoring surface should pipe candidate `props` through
 * `validateComponentProps` before calling `insert_component` or
 * `update_component_props` so malformed props don't propagate.
 *
 * Intentionally a small dependency-free subset of JSON Schema. Covers
 * everything the v1 built-in registry (`prop_schemas` module in
 * `pear/server/spacetimedb/src/pages/components.rs`) actually uses:
 *
 * - `type: "object" | "string" | "number" | "integer" | "boolean" | "array"`
 * - `properties: { [key]: schema }` (on objects)
 * - `required: string[]` (on objects)
 * - `enum: any[]` (on any leaf)
 * - `minimum`, `maximum` (on number/integer)
 * - `items: schema` (on arrays)
 *
 * Unsupported keywords are silently ignored — the validator only enforces
 * what it understands. This matches the v1 "best-effort" stance and avoids
 * tripping on tier-5 extension schemas that use richer JSON Schema features
 * we haven't taught the validator yet.
 *
 * When/if the server-side validator lands, this module's behavior should be
 * the contract that the WASM-side validator matches.
 */

export type JsonSchema = {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	required?: string[];
	enum?: unknown[];
	minimum?: number;
	maximum?: number;
	items?: JsonSchema;
	// Unknown keywords are tolerated and ignored.
	[key: string]: unknown;
};

export type ValidationError = {
	/** Dotted path to the offending value, e.g. `props.action.url` or `props`. */
	path: string;
	/** Human-readable message. */
	message: string;
};

export type ValidationResult =
	| { valid: true }
	| { valid: false; errors: ValidationError[] };

/**
 * Validate a component's props blob against its registry-declared schema.
 *
 * Inputs can be either pre-parsed objects or JSON strings — the validator
 * handles both for ergonomic use from React (where props are already an
 * object) and from raw substrate data (where props/prop_schema are stored
 * as JSON strings on the ComponentNode and ComponentTypeDefinition rows).
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, errors }` on
 * failure with all errors collected so the caller can show every problem
 * at once rather than one at a time.
 */
export function validateComponentProps(
	props: unknown | string,
	prop_schema: JsonSchema | string,
): ValidationResult {
	const parsedProps = typeof props === "string" ? safeParse(props) : props;
	const parsedSchema =
		typeof prop_schema === "string" ? safeParse(prop_schema) : prop_schema;

	if (parsedProps instanceof Error) {
		return {
			valid: false,
			errors: [{ path: "props", message: `not valid JSON: ${parsedProps.message}` }],
		};
	}
	if (parsedSchema instanceof Error) {
		return {
			valid: false,
			errors: [
				{
					path: "prop_schema",
					message: `not valid JSON: ${parsedSchema.message}`,
				},
			],
		};
	}

	const errors: ValidationError[] = [];
	validate(parsedProps, parsedSchema as JsonSchema, "props", errors);
	return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function safeParse(s: string): unknown | Error {
	try {
		return JSON.parse(s);
	} catch (e) {
		return e instanceof Error ? e : new Error(String(e));
	}
}

function validate(
	value: unknown,
	schema: JsonSchema,
	path: string,
	errors: ValidationError[],
): void {
	// `enum` is checked first — if a value is in the enum we accept it
	// regardless of other constraints, matching JSON Schema semantics.
	if (Array.isArray(schema.enum)) {
		const matched = schema.enum.some((expected) => deepEqual(expected, value));
		if (!matched) {
			errors.push({
				path,
				message: `value ${JSON.stringify(value)} is not in enum ${JSON.stringify(schema.enum)}`,
			});
			return;
		}
		// enum match short-circuits other type/range checks.
		return;
	}

	const schemaType = schema.type;
	if (schemaType !== undefined) {
		const allowedTypes = Array.isArray(schemaType) ? schemaType : [schemaType];
		const actualType = jsonType(value);
		const numericTypes = new Set(["number", "integer"]);
		const compatible = allowedTypes.some((t) => {
			if (t === actualType) return true;
			// JSON Schema treats integer as a subset of number — an integer
			// satisfies a `number` constraint, and a whole-number JS number
			// satisfies an `integer` constraint.
			if (t === "number" && actualType === "integer") return true;
			if (
				t === "integer" &&
				actualType === "number" &&
				Number.isInteger(value as number)
			)
				return true;
			return false;
		});
		if (!compatible) {
			errors.push({
				path,
				message: `expected type ${allowedTypes.join(" | ")}, got ${actualType}`,
			});
			return;
		}
	}

	if (typeof value === "number") {
		if (typeof schema.minimum === "number" && value < schema.minimum) {
			errors.push({
				path,
				message: `${value} is below minimum ${schema.minimum}`,
			});
		}
		if (typeof schema.maximum === "number" && value > schema.maximum) {
			errors.push({
				path,
				message: `${value} is above maximum ${schema.maximum}`,
			});
		}
	}

	if (jsonType(value) === "object" && schema.properties) {
		const obj = value as Record<string, unknown>;
		if (Array.isArray(schema.required)) {
			for (const key of schema.required) {
				if (!(key in obj)) {
					errors.push({
						path: `${path}.${key}`,
						message: `required property missing`,
					});
				}
			}
		}
		for (const [key, child_schema] of Object.entries(schema.properties)) {
			if (key in obj) {
				validate(obj[key], child_schema, `${path}.${key}`, errors);
			}
		}
	}

	if (jsonType(value) === "array" && schema.items) {
		const arr = value as unknown[];
		for (let i = 0; i < arr.length; i++) {
			validate(arr[i], schema.items, `${path}[${i}]`, errors);
		}
	}
}

/**
 * JSON Schema's `type` taxonomy is slightly different from `typeof`:
 * `null` is its own type, `array` is distinct from `object`, and integers
 * are distinguished from non-integer numbers.
 */
function jsonType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (typeof value === "number") {
		return Number.isInteger(value) ? "integer" : "number";
	}
	return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((x, i) => deepEqual(x, b[i]));
	}
	if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
		const ka = Object.keys(a as object);
		const kb = Object.keys(b as object);
		if (ka.length !== kb.length) return false;
		return ka.every((k) =>
			deepEqual(
				(a as Record<string, unknown>)[k],
				(b as Record<string, unknown>)[k],
			),
		);
	}
	return false;
}
