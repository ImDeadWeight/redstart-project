/**
 * Stateless helpers for shaping tool JSON — normalizing input schemas into the
 * form OpenAI-compatible tool definitions expect, and parsing incoming tool-call
 * arguments. Extracted verbatim from mcpStore (mcp.svelte.ts); pure, no store
 * state.
 */

/**
 * Normalize a JSON-Schema `properties` tree so every property has an explicit
 * `type` (inferred from `default` when missing) and nested objects/arrays are
 * recursively normalized. Some MCP servers omit `type`, which trips strict
 * OpenAI tool-schema validation.
 */
export function normalizeSchemaProperties(
	schema: Record<string, unknown>
): Record<string, unknown> {
	if (!schema || typeof schema !== 'object') {
		return schema;
	}

	const normalized = { ...schema };
	if (normalized.properties && typeof normalized.properties === 'object') {
		const props = normalized.properties as Record<string, Record<string, unknown>>;
		const normalizedProps: Record<string, Record<string, unknown>> = {};
		for (const [key, prop] of Object.entries(props)) {
			if (!prop || typeof prop !== 'object') {
				normalizedProps[key] = prop;
				continue;
			}
			const normalizedProp = { ...prop };
			if (!normalizedProp.type && normalizedProp.default !== undefined) {
				const defaultVal = normalizedProp.default;
				if (typeof defaultVal === 'string') normalizedProp.type = 'string';
				else if (typeof defaultVal === 'number')
					normalizedProp.type = Number.isInteger(defaultVal) ? 'integer' : 'number';
				else if (typeof defaultVal === 'boolean') normalizedProp.type = 'boolean';
				else if (Array.isArray(defaultVal)) normalizedProp.type = 'array';
				else if (typeof defaultVal === 'object' && defaultVal !== null)
					normalizedProp.type = 'object';
			}
			if (normalizedProp.properties)
				Object.assign(
					normalizedProp,
					normalizeSchemaProperties(normalizedProp as Record<string, unknown>)
				);
			if (normalizedProp.items && typeof normalizedProp.items === 'object')
				normalizedProp.items = normalizeSchemaProperties(
					normalizedProp.items as Record<string, unknown>
				);
			normalizedProps[key] = normalizedProp;
		}
		normalized.properties = normalizedProps;
	}

	return normalized;
}

/**
 * Parse tool-call arguments (a JSON string or an already-parsed object) into a
 * plain argument record. Throws on malformed JSON or a non-object shape.
 */
export function parseToolArguments(
	args: string | Record<string, unknown>
): Record<string, unknown> {
	if (typeof args === 'string') {
		const trimmed = args.trim();
		if (trimmed === '') {
			return {};
		}

		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
				throw new Error(
					`Tool arguments must be an object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
				);

			return parsed as Record<string, unknown>;
		} catch (error) {
			throw new Error(`Failed to parse tool arguments as JSON: ${(error as Error).message}`);
		}
	}

	if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
		return args;
	}

	throw new Error(`Invalid tool arguments type: ${typeof args}`);
}
