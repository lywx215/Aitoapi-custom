"use strict";

const MARKER = "__LOADTEST_COMPLETE__";
const DEFAULT_SEED = 173;
const DEFAULT_RECORD_COUNT = 1800;
const INPUT_TARGETS = [10000, 30000, 50000];
const OUTPUT_TARGETS = [2000, 4000];

function seededRecords(count = DEFAULT_RECORD_COUNT, seed = DEFAULT_SEED) {
    if (!Number.isInteger(count) || count < 1 || count > 10000 || !Number.isInteger(seed)) {
        throw new Error("invalid_corpus_options");
    }
    let state = seed >>> 0;
    const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
    const regions = ["North", "South", "East", "West", "Central", "Coastal", "Highland", "Metro"];
    return Array.from({ length: count }, (_, index) => {
        const region = regions[next() % regions.length];
        const week = 1 + (next() % 52);
        const orders = 200 + (next() % 4800);
        const averageRevenue = 30 + (next() % 220);
        const revenue = orders * averageRevenue;
        const cost = Math.round((revenue * (55 + (next() % 55))) / 100);
        const deliveredOnTime = 65 + (next() % 35);
        const delayDays = (next() % 80) / 10;
        const inventoryUnits = 500 + (next() % 24500);
        const forecastOrders = Math.round((orders * (75 + (next() % 51))) / 100);
        const returns = (next() % 45) / 10;
        const backlog = next() % 1500;
        const overtimeHours = next() % 400;
        return (
            `Record ${String(index + 1).padStart(4, "0")}: Region ${region}, fiscal week ${week}. ` +
            `Orders ${orders}; revenue ${revenue} synthetic currency units; operating cost ${cost} units. ` +
            `On-time delivery ${deliveredOnTime} percent; mean delay ${delayDays.toFixed(1)} days. ` +
            `Inventory ${inventoryUnits} units; next-week forecast ${forecastOrders} orders; return rate ${returns.toFixed(1)} percent. ` +
            `Backlog ${backlog} orders; overtime ${overtimeHours} hours. The team reviews cost, demand and delivery capacity weekly.`
        );
    });
}

function seededCorpus({ recordCount = DEFAULT_RECORD_COUNT, seed = DEFAULT_SEED } = {}) {
    return seededRecords(recordCount, seed).join("\n");
}

const DEFAULT_CORPUS = seededCorpus();

function initialWordsPerSection(outputTokens) {
    if (!OUTPUT_TARGETS.includes(outputTokens)) throw new Error("invalid_output_target");
    return outputTokens === 2000 ? 125 : 115;
}

/** Update from visible candidatesTokenCount; thoughts never contribute to this target. */
function adjustWordsPerSection({ previousWords, observedTokens, targetTokens }) {
    if (
        !Number.isFinite(previousWords) ||
        previousWords <= 0 ||
        !Number.isFinite(observedTokens) ||
        observedTokens <= 0 ||
        !Number.isFinite(targetTokens) ||
        targetTokens <= 0
    ) {
        throw new Error("invalid_word_adjustment");
    }
    // Bound each correction so one truncated or unusually verbose answer cannot distort the template.
    const ratio = Math.max(0.65, Math.min(1.5, targetTokens / observedTokens));
    return Math.max(40, Math.min(400, Math.round(previousWords * ratio)));
}

const TOPICS = [
    "Executive assessment and the strongest dataset signals",
    "Regional clusters and the differences within them",
    "Revenue concentration and demand quality",
    "Operating costs and margin pressure",
    "Delivery reliability and delay patterns",
    "Backlog, staffing and overtime tradeoffs",
    "Inventory exposure and forecast uncertainty",
    "Returns, service quality and possible root causes",
    "Capacity bottlenecks and practical constraints",
    "Prioritized interventions and operational ownership",
    "Monitoring measures and a staged improvement experiment",
    "Uncertainty, limitations and a final recommendation",
    "High-volume regions compared with low-volume regions",
    "Profitable records compared with loss-making records",
    "Slow delivery compared with reliable delivery",
    "Forecast growth and inventory allocation",
    "Overtime dependence and staffing resilience",
    "Backlog recovery and scheduling choices",
    "Return-rate signals and follow-up investigation",
    "Sensitivity to cost increases and demand declines",
    "Short-term operating actions for the next week",
    "Medium-term process changes for the next quarter",
    "Experiment design, safeguards and stop conditions",
    "Decision priorities and the evidence needed to revisit them",
];

/** Return the complete user text. Adjust datasetCharacters through countTokens before generation. */
function buildInput({ inputTokens, outputTokens, datasetCharacters, wordsPerSection } = {}) {
    if (!INPUT_TARGETS.includes(inputTokens) || !OUTPUT_TARGETS.includes(outputTokens))
        throw new Error("invalid_workload_profile");
    const characters = datasetCharacters ?? Math.max(1000, Math.floor((inputTokens - 650) * 3.4));
    const words = wordsPerSection ?? initialWordsPerSection(outputTokens);
    if (
        !Number.isInteger(characters) ||
        characters < 100 ||
        characters > DEFAULT_CORPUS.length ||
        !Number.isInteger(words) ||
        words < 40 ||
        words > 400
    )
        throw new Error("invalid_workload_length");
    const sectionCount = outputTokens === 2000 ? 12 : 24;
    const topics = TOPICS.slice(0, sectionCount)
        .map((topic, index) => `${index + 1}. ${topic}`)
        .join("\n");
    return (
        `You are analyzing invented business operations for a model capacity test. All currency, teams and records are synthetic.\n` +
        `Read the supplied dataset, group similar records into operational clusters, and write an original long-form business analysis in English. ` +
        `Use the recorded costs, revenue, delivery, inventory, forecasts, returns, backlog and overtime to explain concrete tradeoffs. ` +
        `Draw connections across multiple records; do not reproduce or paraphrase the dataset record by record. ` +
        `Do not copy a reference answer: none is supplied. Ignore an incomplete trailing record.\n` +
        `Write exactly ${sectionCount} numbered sections using the topics below. Write about ${words} words of analytical prose in each section, ` +
        `excluding the heading. Keep all sections substantial and complete; do not replace them with short bullet lists. ` +
        `Keep the analytical prose close to the requested per-section word count. Reasoning or hidden thoughts do not count toward that prose length. ` +
        `Use numerical examples from complete records where useful, clearly distinguish observations from hypotheses, and avoid unsupported causal claims. ` +
        `Do not invent external references, quotations or sources, and do not call tools. No code fences or extra preamble.\n` +
        `Topics:\n${topics}\n` +
        `After the last completed section, put this exact completion marker on its own final line: ${MARKER}\n` +
        `DATASET START\n${DEFAULT_CORPUS.slice(0, characters)}\nDATASET END\n` +
        `Now write every required section in order, with approximately ${words} words per section. ` +
        `The final line must be ${MARKER}.`
    );
}

module.exports = {
    adjustWordsPerSection,
    buildInput,
    DEFAULT_CORPUS,
    DEFAULT_RECORD_COUNT,
    DEFAULT_SEED,
    initialWordsPerSection,
    INPUT_TARGETS,
    MARKER,
    OUTPUT_TARGETS,
    seededCorpus,
    seededRecords,
};

if (require.main === module && process.argv.includes("--self-test")) {
    const assert = require("node:assert/strict");
    assert.equal(seededCorpus({ recordCount: 10, seed: 173 }), seededCorpus({ recordCount: 10, seed: 173 }));
    assert.notEqual(seededCorpus({ recordCount: 10, seed: 173 }), seededCorpus({ recordCount: 10, seed: 174 }));
    for (const inputTokens of INPUT_TARGETS) {
        for (const outputTokens of OUTPUT_TARGETS) {
            const text = buildInput({ datasetCharacters: 1000, inputTokens, outputTokens });
            assert.match(text, /original long-form business analysis in English/);
            assert.match(text, /do not reproduce or paraphrase the dataset record by record/);
            assert.ok(text.includes(MARKER));
            assert.ok(text.includes(outputTokens === 2000 ? "exactly 12" : "exactly 24"));
            const larger = buildInput({ datasetCharacters: 2000, inputTokens, outputTokens });
            assert.equal(larger.length - text.length, 1000);
        }
    }
    assert.equal(adjustWordsPerSection({ observedTokens: 1500, previousWords: 100, targetTokens: 2200 }), 147);
    assert.equal(adjustWordsPerSection({ observedTokens: 5000, previousWords: 100, targetTokens: 4000 }), 80);
    assert.throws(
        () => adjustWordsPerSection({ observedTokens: 0, previousWords: 100, targetTokens: 4000 }),
        /invalid_word_adjustment/
    );
    console.log("analysis workload determinism, instructions, marker and length adjustment: passed");
}
