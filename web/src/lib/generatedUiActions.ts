export type GeneratedUiScalar = string | number | boolean | null;

export type GeneratedUiFieldSnapshot = {
  value: string;
  required: boolean;
};

export type GeneratedUiInputBindings = Record<string, unknown>;

export type ResolveGeneratedUiInputResult =
  | { ok: true; input: Record<string, GeneratedUiScalar> }
  | { ok: false; error: string };

/** Resolve a generated button's explicit payload mapping against local inputs. */
export function resolveGeneratedUiInput(
  bindings: GeneratedUiInputBindings | undefined,
  fields: ReadonlyMap<string, GeneratedUiFieldSnapshot>,
): ResolveGeneratedUiInputResult {
  const input: Record<string, GeneratedUiScalar> = {};
  for (const [payloadField, binding] of Object.entries(bindings ?? {})) {
    if (typeof binding === "string" && binding.startsWith("$form.")) {
      const fieldName = binding.slice("$form.".length);
      const field = fields.get(fieldName);
      if (!field) {
        return {
          ok: false,
          error: `This action references an unavailable input: ${fieldName || "(empty)"}.`,
        };
      }
      if (field.required && field.value.trim() === "") {
        return { ok: false, error: `${fieldName} is required.` };
      }
      input[payloadField] = field.value;
      continue;
    }
    if (typeof binding === "string" && binding.startsWith("$")) {
      return { ok: false, error: `Unsupported generated UI binding: ${binding}.` };
    }
    if (
      binding === null ||
      typeof binding === "string" ||
      typeof binding === "number" ||
      typeof binding === "boolean"
    ) {
      input[payloadField] = binding;
      continue;
    }
    return {
      ok: false,
      error: `Input mapping for ${payloadField} must resolve to a scalar value.`,
    };
  }
  return { ok: true, input };
}

export function normalizeGeneratedAutomationId(raw: unknown): bigint | null {
  try {
    if (typeof raw === "bigint" && raw > 0n) return raw;
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) {
      return BigInt(raw);
    }
    if (typeof raw === "string" && /^\d+$/.test(raw) && BigInt(raw) > 0n) {
      return BigInt(raw);
    }
  } catch {
    // Invalid IDs fail closed.
  }
  return null;
}

