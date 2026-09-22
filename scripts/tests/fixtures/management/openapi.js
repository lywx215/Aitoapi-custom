const assert = require("node:assert/strict");
const spec = require("../../../../docs/management-api-openapi.json");

// Validate the subset of OpenAPI 3 schemas used by this repository against
// actual HTTP JSON. This is response conformance evidence, not a meta-validator.
function validate(value, schema, label = "response") {
    if (schema.$ref)
        schema = schema.$ref
            .slice(2)
            .split("/")
            .reduce((item, key) => item[key], spec);
    if (value === null && schema.nullable) return;
    if (schema.oneOf) {
        const matches = schema.oneOf.filter(option => {
            try {
                validate(value, option, label);
                return true;
            } catch {
                return false;
            }
        });
        assert.equal(matches.length, 1, `${label} must match exactly one schema`);
        return;
    }
    if (schema.enum) assert.ok(schema.enum.includes(value), `${label} not in enum: ${value}`);
    switch (schema.type) {
        case "object":
            assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
            for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `${label}.${key} required`);
            for (const [key, child] of Object.entries(value)) {
                if (schema.properties?.[key]) validate(child, schema.properties[key], `${label}.${key}`);
                else assert.notEqual(schema.additionalProperties, false, `${label}.${key} is undocumented`);
            }
            return;
        case "array":
            assert.ok(Array.isArray(value), `${label} is not an array`);
            for (const [index, child] of value.entries()) validate(child, schema.items, `${label}[${index}]`);
            if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${label} exceeds maxItems`);
            if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${label} below minItems`);
            return;
        case "integer":
            assert.ok(Number.isInteger(value), `${label} is not an integer`);
            break;
        case "number":
            assert.equal(typeof value, "number", label);
            break;
        case "boolean":
            assert.equal(typeof value, "boolean", label);
            return;
        case "string":
            assert.equal(typeof value, "string", label);
            if (schema.pattern) assert.match(value, new RegExp(schema.pattern), label);
            if (schema.maxLength !== undefined) assert.ok(value.length <= schema.maxLength, label);
            if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, label);
            if (schema.format === "date-time") assert.ok(Number.isFinite(Date.parse(value)), label);
            return;
        default:
            return;
    }
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, label);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, label);
}

function validateHttp(method, rawPath, response) {
    const endpoint = rawPath.split("?")[0];
    if (!endpoint.startsWith("/api/manage/v1") && !endpoint.startsWith("/api/management-keys")) return;
    if (response.status >= 400) {
        validate(response.body, { $ref: "#/components/schemas/ErrorEnvelope" }, `${method} ${rawPath}`);
        return;
    }
    const matched = spec.paths[endpoint]
        ? [endpoint, spec.paths[endpoint]]
        : Object.entries(spec.paths).find(([route]) =>
              new RegExp(`^${route.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(endpoint)
          );
    assert.ok(matched, `Missing documented endpoint ${endpoint}`);
    const operation = matched[1][method.toLowerCase()];
    assert.ok(operation, `Missing documented method ${method} ${endpoint}`);
    let shape = operation.responses[response.status];
    assert.ok(shape, `Undocumented status ${response.status} ${endpoint}`);
    if (shape.$ref)
        shape = shape.$ref
            .slice(2)
            .split("/")
            .reduce((item, key) => item[key], spec);
    validate(response.body, shape.content["application/json"].schema, `${method} ${rawPath}`);
}

module.exports = { validateHttp };
