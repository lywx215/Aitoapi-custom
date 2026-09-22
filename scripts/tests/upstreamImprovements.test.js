const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FormatConverter = require("../../src/core/FormatConverter");
const ConfigLoader = require("../../src/utils/ConfigLoader");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_AI_STUDIO_APP_URL = "https://ai.studio/apps/d31dbffc-6199-4f09-9da5-45de7684ab8a";

const makeLogger = () => {
    const entries = [];
    return {
        debug: message => entries.push(["debug", message]),
        entries,
        error: message => entries.push(["error", message]),
        info: message => entries.push(["info", message]),
        warn: message => entries.push(["warn", message]),
    };
};

const testNativeResponseSchemaNormalization = () => {
    const converter = new FormatConverter(makeLogger(), { config: {} });
    const body = {
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                items: [
                    { type: "string" },
                    {
                        properties: {
                            enabled: { type: "boolean" },
                        },
                        type: "object",
                    },
                ],
                properties: {
                    count: { type: "integer" },
                    labels: { items: { type: "string" }, type: "array" },
                },
                type: "object",
            },
        },
    };

    assert.strictEqual(converter.normalizeGeminiResponseSchema(body), body);
    assert.strictEqual(body.generationConfig.responseSchema.type, "OBJECT");
    assert.strictEqual(body.generationConfig.responseSchema.properties.count.type, "INTEGER");
    assert.strictEqual(body.generationConfig.responseSchema.properties.labels.type, "ARRAY");
    assert.strictEqual(body.generationConfig.responseSchema.properties.labels.items.type, "STRING");
    assert.strictEqual(body.generationConfig.responseSchema.items[0].type, "STRING");
    assert.strictEqual(body.generationConfig.responseSchema.items[1].type, "OBJECT");
    assert.strictEqual(body.generationConfig.responseSchema.items[1].properties.enabled.type, "BOOLEAN");

    const withoutSchema = { generationConfig: { temperature: 0 } };
    assert.strictEqual(converter.normalizeGeminiResponseSchema(withoutSchema), withoutSchema);
};

const loadRequestProcessor = () => {
    const buildPath = path.join(ROOT, "scripts", "client", "build.js");
    const source = fs
        .readFileSync(buildPath, "utf8")
        .replace(/\ninitializeProxySystem\(\);\s*$/, "\nglobalThis.RequestProcessor = RequestProcessor;\n");
    const context = {
        AbortController,
        atob,
        Blob,
        clearTimeout,
        console,
        document: {
            body: { appendChild() {}, innerHTML: "" },
            createElement: () => ({ textContent: "" }),
        },
        EventTarget,
        Map,
        Set,
        setTimeout,
        Uint8Array,
        URL,
        URLSearchParams,
        window: {},
    };
    vm.runInNewContext(source, context, { filename: buildPath });
    return context.RequestProcessor;
};

const testSpecialModelStructuredOutputRemoval = () => {
    const RequestProcessor = loadRequestProcessor();
    const processor = new RequestProcessor();
    const makeRequest = (pathName, extraConfig = {}) => {
        const config = processor._buildRequestConfig({
            body: JSON.stringify({
                generationConfig: {
                    responseFormat: { type: "json_schema" },
                    responseJsonSchema: { type: "object" },
                    responseMimeType: "application/json",
                    responseSchema: { type: "OBJECT" },
                    temperature: 0.2,
                    ...extraConfig,
                },
            }),
            headers: {},
            method: "POST",
            path: pathName,
        });
        return JSON.parse(config.body);
    };

    const embeddingBody = makeRequest("/v1beta/models/gemini-embedding-2:embedContent", {
        responseModalities: ["TEXT"],
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(embeddingBody.generationConfig)), { temperature: 0.2 });

    const ttsBody = makeRequest("/v1beta/models/gemini-tts:generateContent");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ttsBody.generationConfig)), {
        responseModalities: ["AUDIO"],
        temperature: 0.2,
    });

    const imageBody = makeRequest("/v1beta/models/gemini-3.1-flash-lite-image:generateContent", {
        responseModalities: ["IMAGE"],
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(imageBody.generationConfig)), {
        responseModalities: ["IMAGE"],
        temperature: 0.2,
    });

    const regularBody = makeRequest("/v1beta/models/gemini-3.8-flash:generateContent");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(regularBody.generationConfig)), {
        responseFormat: { type: "json_schema" },
        responseJsonSchema: { type: "object" },
        responseMimeType: "application/json",
        responseSchema: { type: "OBJECT" },
        temperature: 0.2,
    });
};

const withAiStudioAppUrl = (value, callback) => {
    const previous = process.env.AI_STUDIO_APP_URL;
    if (value === undefined) {
        delete process.env.AI_STUDIO_APP_URL;
    } else {
        process.env.AI_STUDIO_APP_URL = value;
    }

    try {
        callback();
    } finally {
        if (previous === undefined) {
            delete process.env.AI_STUDIO_APP_URL;
        } else {
            process.env.AI_STUDIO_APP_URL = previous;
        }
    }
};

const loadConfig = value => {
    let result;
    let logger;
    withAiStudioAppUrl(value, () => {
        logger = makeLogger();
        result = new ConfigLoader(logger).loadConfiguration();
    });
    return { config: result, logger };
};

const testAiStudioAppConfiguration = () => {
    const defaultResult = loadConfig(undefined);
    assert.strictEqual(defaultResult.config.aiStudioAppUrl, DEFAULT_AI_STUDIO_APP_URL);

    const customResult = loadConfig(" https://ai.studio/apps/custom-app-id/ ");
    assert.strictEqual(customResult.config.aiStudioAppUrl, "https://ai.studio/apps/custom-app-id");

    const invalidResult = loadConfig("https://example.com/apps/not-allowed?x=1");
    assert.strictEqual(invalidResult.config.aiStudioAppUrl, DEFAULT_AI_STUDIO_APP_URL);
    assert(
        invalidResult.logger.entries.some(
            ([level, message]) => level === "warn" && message.includes("Invalid AI_STUDIO_APP_URL")
        )
    );

    const browserManagerSource = fs.readFileSync(path.join(ROOT, "src", "core", "BrowserManager.js"), "utf8");
    assert(
        browserManagerSource.includes("this.targetUrl = config.aiStudioAppUrl;"),
        "BrowserManager must consume ConfigLoader's AI Studio app URL"
    );
};

const testRequestHandlerWiring = () => {
    const source = fs.readFileSync(path.join(ROOT, "src", "core", "RequestHandler.js"), "utf8");
    assert(
        source.includes("this.formatConverter.normalizeGeminiResponseSchema(bodyObj);"),
        "native Gemini requests must normalize responseSchema before forwarding"
    );
};

testNativeResponseSchemaNormalization();
testSpecialModelStructuredOutputRemoval();
testAiStudioAppConfiguration();
testRequestHandlerWiring();

console.log("upstreamImprovements: all scenarios passed");
