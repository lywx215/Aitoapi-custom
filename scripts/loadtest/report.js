const fs = require("fs");
const path = require("path");

const SLO_RATE = 0.99;
const SLO_P95_MS = 180000;

function readJsonl(file, warnings) {
    if (!fs.existsSync(file)) return [];
    const records = [];
    fs.readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, index) => {
            if (!line.trim()) return;
            try {
                records.push(JSON.parse(line));
            } catch {
                warnings.push(`${path.basename(file)} 第 ${index + 1} 行无法解析，未参与统计。`);
            }
        });
    return records;
}

function percentile(values, percent) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)];
}

function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function time(value) {
    if (typeof value === "number") return value;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function stageDuration(stage) {
    const provided = finite(stage.durationMs);
    if (provided !== null) return provided;
    const start = time(stage.startedAt);
    const end = time(stage.finishedAt);
    return start !== null && end !== null ? Math.max(0, end - start) : null;
}

function identity(record) {
    return [
        record.profileId || "unknown",
        record.mode || "unknown",
        record.phase || "unknown",
        record.concurrency || 0,
    ];
}

function completeResponse(record) {
    return (
        record.httpStatus === 200 &&
        record.eof === true &&
        record.parseOk === true &&
        !record.streamError &&
        !record.errorCode &&
        record.finishReason === "STOP" &&
        record.markerPresent === true &&
        ((record.textBytes || 0) > 0 || (typeof record.text === "string" && record.text.trim().length > 0))
    );
}

function summarize(requests, stages, serverUsage) {
    const usageById = new Map(
        serverUsage.filter(record => typeof record.requestId === "string").map(record => [record.requestId, record])
    );
    const groups = new Map();
    for (const record of [...requests, ...stages]) {
        const key = JSON.stringify(identity(record));
        if (!groups.has(key)) groups.set(key, { identity: identity(record), requests: [], stages: [] });
    }
    for (const record of requests) groups.get(JSON.stringify(identity(record))).requests.push(record);
    for (const record of stages) groups.get(JSON.stringify(identity(record))).stages.push(record);
    return [...groups.values()]
        .map(group => {
            const rows = group.requests;
            const completed = rows.filter(
                record =>
                    record.transportSuccess === true ||
                    (record.httpStatus === 200 &&
                        record.eof === true &&
                        record.parseOk === true &&
                        !record.streamError &&
                        !record.errorCode &&
                        record.finishReason === "STOP")
            ).length;
            const qualified = rows.filter(record => record.qualified === true).length;
            const responseSuccessCount = rows.filter(completeResponse).length;
            const durations = group.stages.map(stageDuration).filter(Number.isFinite);
            const durationMs = durations.reduce((sum, value) => sum + value, 0);
            const statuses = {};
            const classifications = {};
            const accountDistribution = {};
            let serverMatchedCount = 0;
            let serverMatchedWithoutAccount = 0;
            for (const record of rows) {
                const status = record.httpStatus || "no_response";
                statuses[status] = (statuses[status] || 0) + 1;
                const classification = record.classification || "unclassified";
                classifications[classification] = (classifications[classification] || 0) + 1;
                const usage = typeof record.requestId === "string" ? usageById.get(record.requestId) : undefined;
                if (usage) {
                    serverMatchedCount++;
                    const account =
                        typeof usage.accountId === "string" && usage.accountId
                            ? usage.accountId
                            : Number.isSafeInteger(usage.index)
                              ? `index:${usage.index}`
                              : null;
                    if (account) accountDistribution[account] = (accountDistribution[account] || 0) + 1;
                    else serverMatchedWithoutAccount++;
                }
            }
            const promptTokens = rows.reduce((sum, record) => sum + (finite(record.promptTokens) || 0), 0);
            const candidateTokens = rows.reduce((sum, record) => sum + (finite(record.candidateTokens) || 0), 0);
            const thoughtTokens = rows.reduce((sum, record) => sum + (finite(record.thoughtTokens) || 0), 0);
            const observed = field => rows.map(record => record[field]).filter(Number.isFinite);
            const tokenCoverage = Object.fromEntries(
                ["promptTokens", "candidateTokens", "thoughtTokens", "cachedTokens"].map(field => [
                    field,
                    { known: observed(field).length, missing: rows.length - observed(field).length },
                ])
            );
            const p95Ms = percentile(
                rows.map(record => record.totalMs),
                95
            );
            return {
                abortReasons: [...new Set(group.stages.map(stage => stage.abortReason).filter(Boolean))],
                accountDistribution,
                candidateTokens,
                candidateTokensP50: percentile(observed("candidateTokens"), 50),
                candidateTokensP95: percentile(observed("candidateTokens"), 95),
                candidateTokensPerSecond: durationMs > 0 ? (candidateTokens * 1000) / durationMs : null,
                classifications,
                concurrency: group.identity[3],
                durationMs: durations.length ? durationMs : null,
                firstTextP95Ms: percentile(
                    rows.map(record => record.firstTextMs),
                    95
                ),
                mode: group.identity[1],
                p50Ms: percentile(
                    rows.map(record => record.totalMs),
                    50
                ),
                p95Ms,
                p99Ms: percentile(
                    rows.map(record => record.totalMs),
                    99
                ),
                peakCreatedInFlight: Math.max(0, ...group.stages.map(stage => finite(stage.peakCreatedInFlight) || 0)),
                peakSentInFlight: Math.max(0, ...group.stages.map(stage => finite(stage.peakSentInFlight) || 0)),
                phase: group.identity[2],
                profileId: group.identity[0],
                promptTokens,
                promptTokensP50: percentile(observed("promptTokens"), 50),
                qualifiedCount: qualified,
                qualifiedRate: rows.length ? qualified / rows.length : null,
                queueWaitP95Ms: percentile(observed("queueMs"), 95),
                requestCount: rows.length,
                requestsPerSecond: durationMs > 0 ? (rows.length * 1000) / durationMs : null,
                responseSuccessCount,
                responseSuccessRate: rows.length ? responseSuccessCount / rows.length : null,
                serverMatchedCount,
                serverMatchedWithoutAccount,
                serverMatchRate: rows.length ? serverMatchedCount / rows.length : null,
                serverUnmatchedCount: rows.length - serverMatchedCount,
                stageCount: group.stages.length,
                statuses,
                thoughtTokens,
                tokenCoverage,
                totalMeasuredTokensPerSecond:
                    durationMs > 0 ? ((promptTokens + candidateTokens + thoughtTokens) * 1000) / durationMs : null,
                transportSuccessCount: completed,
                transportSuccessRate: rows.length ? completed / rows.length : null,
                ttfbP95Ms: percentile(
                    rows.map(record => record.ttfbMs),
                    95
                ),
                uploadP95Ms: percentile(observed("uploadMs"), 95),
            };
        })
        .sort(
            (a, b) =>
                a.profileId.localeCompare(b.profileId) ||
                a.mode.localeCompare(b.mode) ||
                a.phase.localeCompare(b.phase) ||
                a.concurrency - b.concurrency
        );
}

function stagePasses(stage) {
    return (
        stage.passed === true &&
        stage.qualifiedRate >= SLO_RATE &&
        stage.p95Ms !== null &&
        stage.p95Ms <= SLO_P95_MS &&
        stage.peakSentInFlight >= stage.concurrency &&
        !stage.abortReason
    );
}

function capacities(stages, requests) {
    const groups = new Map();
    for (const stage of stages) {
        const key = JSON.stringify([stage.profileId || "unknown", stage.mode || "unknown"]);
        if (!groups.has(key)) {
            groups.set(key, {
                abortReasons: [],
                maxAchieved: 0,
                maxTarget: 0,
                mode: stage.mode || "unknown",
                profileId: stage.profileId || "unknown",
                stable: null,
                wave: null,
            });
        }
        const group = groups.get(key);
        group.maxTarget = Math.max(group.maxTarget, stage.concurrency || 0);
        group.maxAchieved = Math.max(group.maxAchieved, stage.peakSentInFlight || 0);
        if (stage.abortReason && !group.abortReasons.includes(stage.abortReason))
            group.abortReasons.push(stage.abortReason);
        const observed = requests.filter(record => record.stageId === stage.stageId);
        const observedRate = observed.length
            ? observed.filter(record => record.qualified === true).length / observed.length
            : 0;
        const observedP95 = percentile(
            observed.map(record => record.totalMs),
            95
        );
        const completeEvidence =
            observed.length === stage.requestCount && observed.every(record => finite(record.totalMs) !== null);
        if (
            !stagePasses(stage) ||
            !completeEvidence ||
            observedRate < SLO_RATE ||
            observedP95 === null ||
            observedP95 > SLO_P95_MS
        )
            continue;
        if (stage.phase === "sustain") {
            if (stageDuration(stage) >= 600000 && stage.requestCount >= Math.max(300, 3 * stage.concurrency)) {
                group.stable = Math.max(group.stable || 0, stage.concurrency);
            }
        } else if (stage.phase !== "calibration" && stage.phase !== "debug") {
            group.wave = Math.max(group.wave || 0, stage.concurrency);
        }
    }
    return [...groups.values()].sort((a, b) => a.profileId.localeCompare(b.profileId) || a.mode.localeCompare(b.mode));
}

function csvCell(value) {
    if (value === null || value === undefined) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function display(value, digits = 2) {
    return Number.isFinite(value) ? value.toFixed(digits) : "缺失";
}

function percentage(value) {
    return Number.isFinite(value) ? `${display(value * 100)}%` : "缺失";
}

function markdown(value) {
    return String(value === undefined || value === null ? "缺失" : value)
        .replace(/\|/g, "\\|")
        .replace(/[\r\n]+/g, " ");
}

function environmentSummary(environment) {
    const keys = new Set();
    function collect(value, prefix = "") {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
            const full = prefix ? `${prefix}.${key}` : key;
            if (
                child !== null &&
                child !== undefined &&
                /cpu|memory|mem|uptime|context|ready|restart|oom|eventLoop|network/i.test(full)
            )
                keys.add(full);
            if (child && typeof child === "object") collect(child, full);
        }
    }
    environment.forEach(record => collect(record));
    return [...keys].sort();
}

function readJson(file, warnings) {
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        warnings.push(`${path.basename(file)} 无法解析，相关证据缺失。`);
        return {};
    }
}

function platformEvidence(outputDir, warnings) {
    const files = fs.existsSync(outputDir)
        ? fs
              .readdirSync(outputDir)
              .filter(file => /platform|metric|cpu|memory|resource/i.test(file) && /\.jsonl?$/.test(file))
        : [];
    let samples = 0;
    const series = [];
    const missing = new Set();
    let runtimeLogEntries = null;
    function visit(value, prefix) {
        if (Array.isArray(value)) {
            if (/points|values|samples/i.test(prefix)) {
                const valid = value.filter(point => {
                    if (finite(point) !== null) return true;
                    if (Array.isArray(point)) return finite(point[1]) !== null;
                    return finite(point?.value) !== null || finite(point?.y) !== null;
                }).length;
                samples += valid;
                series.push(`${prefix}=${valid}有效点`);
            }
            value.forEach((child, index) => {
                if (child && typeof child === "object") visit(child, `${prefix}[${index}]`);
            });
            return;
        }
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
            const full = `${prefix}.${key}`;
            if (
                finite(child) !== null &&
                /cpu|memory|ram|mem/i.test(full) &&
                /usage|used|percent|bytes/i.test(full) &&
                !/limit|count|allocated|requested|max/i.test(full)
            )
                samples++;
            if (child && typeof child === "object") visit(child, full);
        }
    }
    files.forEach(file => {
        const source = path.join(outputDir, file);
        const records = file.endsWith(".jsonl") ? readJsonl(source, warnings) : [readJson(source, warnings)];
        records.forEach(record => {
            visit(record, file);
            if (Array.isArray(record?.missing))
                record.missing.filter(item => typeof item === "string").forEach(item => missing.add(item));
            if (finite(record?.logs?.rawEntryCount) !== null)
                runtimeLogEntries = Math.max(runtimeLogEntries || 0, record.logs.rawEntryCount);
        });
    });
    return { files, missing: [...missing].sort(), runtimeLogEntries, samples, series: [...new Set(series)] };
}

function buildReport(outputDir) {
    const warnings = [];
    const requests = readJsonl(path.join(outputDir, "requests.jsonl"), warnings);
    const stages = readJsonl(path.join(outputDir, "stages.jsonl"), warnings);
    const environment = readJsonl(path.join(outputDir, "environment.jsonl"), warnings);
    const serverUsage = readJsonl(path.join(outputDir, "server-usage.jsonl"), warnings);
    const network = readJsonl(path.join(outputDir, "client-network.jsonl"), warnings);
    const inflight = readJsonl(path.join(outputDir, "inflight.jsonl"), warnings);
    const profiles = fs.existsSync(path.join(outputDir, "profiles.json"))
        ? readJson(path.join(outputDir, "profiles.json"), warnings)
        : [];
    const workload =
        Array.isArray(profiles) && profiles.length > 0 && profiles.every(profile => profile.workload === "analysis")
            ? "analysis"
            : "verbatim";
    const baseline = readJson(path.join(outputDir, "baseline.json"), warnings);
    const successMetric = baseline.successMetric || "tokens";
    const deployment = readJson(path.join(outputDir, "deployment-before.json"), warnings);
    const commit =
        baseline.commit || baseline.deploymentCommit || baseline.deployedCommit || deployment.deployment?.commit;
    const platform = platformEvidence(outputDir, warnings);
    const closedStageIds = new Set(stages.map(stage => stage.stageId).filter(Boolean));
    const completedStageSamples = requests.filter(record => closedStageIds.has(record.stageId));
    const partialGroups = new Map();
    for (const record of requests) {
        if (closedStageIds.has(record.stageId)) continue;
        const stageId = record.stageId || "missing_stage_id";
        if (!partialGroups.has(stageId)) partialGroups.set(stageId, []);
        partialGroups.get(stageId).push(record);
    }
    const partialStageSamples = [...partialGroups].flatMap(([stageId, records]) =>
        summarize(records, [], serverUsage).map(summary => ({
            ...summary,
            evidenceStatus: "partial_stage",
            originalPhase: summary.phase,
            phase: "partial",
            stageId,
            unknownRequestCount: null,
        }))
    );
    const partialStageSampleCount = partialStageSamples.reduce((count, row) => count + row.requestCount, 0);
    const summaries = summarize(completedStageSamples, stages, serverUsage);
    const capacity = capacities(stages, completedStageSamples);
    const headers = [
        "profileId",
        "mode",
        "phase",
        "concurrency",
        "requestCount",
        "stageCount",
        "transportSuccessCount",
        "transportSuccessRate",
        "qualifiedCount",
        "qualifiedRate",
        "p50Ms",
        "p95Ms",
        "p99Ms",
        "firstTextP95Ms",
        "ttfbP95Ms",
        "durationMs",
        "requestsPerSecond",
        "promptTokens",
        "candidateTokens",
        "thoughtTokens",
        "candidateTokensPerSecond",
        "totalMeasuredTokensPerSecond",
        "peakSentInFlight",
        "peakCreatedInFlight",
        "statuses",
        "classifications",
        "abortReasons",
        "serverMatchedCount",
        "serverUnmatchedCount",
        "serverMatchedWithoutAccount",
        "serverMatchRate",
        "accountDistribution",
        "responseSuccessCount",
        "responseSuccessRate",
        "tokenCoverage",
        "promptTokensP50",
        "candidateTokensP50",
        "candidateTokensP95",
        "queueWaitP95Ms",
        "uploadP95Ms",
        "stageId",
        "originalPhase",
        "evidenceStatus",
        "unknownRequestCount",
    ];
    const csv =
        [
            headers.join(","),
            ...[...summaries, ...partialStageSamples].map(row => headers.map(key => csvCell(row[key])).join(",")),
        ].join("\n") + "\n";
    const qualified = completedStageSamples.filter(record => record.qualified === true).length;
    const peak = Math.max(0, ...stages.map(stage => stage.peakSentInFlight || 0));
    const failures = requests.filter(record => record.qualified !== true);
    const fields = environmentSummary(environment);
    const lines = [
        "# Aitoapi 大 token 并发压测记录",
        "",
        `生成时间：${new Date().toISOString()}。本报告由当前产物自动汇总；测试记录 ${requests.length} 条，阶段 ${stages.length} 个，环境采样 ${environment.length} 条。`,
        "",
        successMetric === "response"
            ? `已闭合阶段完整回复成功 ${completedStageSamples.filter(completeResponse).length}/${completedStageSamples.length}（含前期校准）；主验收关注有效正文、STOP、EOF、结束标记及无流内/请求错误，不以 token 数量偏差或缺失 usage 判失败。稳定容量要求成功率 ≥99%、全部样本总耗时 P95≤180 秒、持续至少 10 分钟、完成数至少 max(300, 3×并发)，并达到目标客户端在途峰值。校准阶段沿用当时 token 分类，仅作辅助诊断。`
            : `已闭合阶段合格请求 ${qualified}/${completedStageSamples.length}；客户端完成上传后等待响应的在途峰值 ${peak}。稳定容量必须同时满足实际 token 与完整响应验收、合格率 ≥99%、总耗时 P95≤180 秒、持续至少 10 分钟、完成数至少 max(300, 3×并发)，并实际达到目标客户端在途峰值。`,
        "",
        `目标地址：${markdown(baseline.origin || baseline.target)}。模型：${markdown(baseline.model)}。部署提交：${markdown(commit)}；来源为 baseline.json 或 deployment-before.json。`,
        "",
        "本测试不评估模型的复杂推理能力。",
        "",
        workload === "analysis"
            ? "负载使用固定种子的合成业务记录，要求模型生成英文长篇业务分析并输出结束标记，按 usage 验证实际输入及正文输出 token。客户端在途表示请求完成上传、尚未结束响应；不能据此认定相同数量的上游模型正在有效生成。"
            : "当前运行使用合成长文本复现参考回复，属于传输诊断负载，未满足计划中的长篇分析生成要求，不能替代分析负载容量结论。客户端在途表示请求完成上传、尚未结束响应；不能据此认定相同数量的上游模型正在有效生成。",
        "",
        "## 已验证容量",
        "",
        "| 负载 | 格式 | 稳定并发 | 波次通过并发 | 最高目标档 | 客户端在途峰值 | 中止原因 |",
        "| --- | --- | ---: | ---: | ---: | ---: | --- |",
        ...capacity.map(
            row =>
                `| ${markdown(row.profileId)} | ${markdown(row.mode)} | ${row.stable === null ? "未验证" : row.stable} | ${row.wave === null ? "未验证" : row.wave} | ${row.maxTarget} | ${row.maxAchieved} | ${markdown(row.abortReasons.join("；") || "无")} |`
        ),
        "",
        peak >= 300
            ? "客户端完成上传后的在途峰值已达到 300；是否通过须查看对应负载的持续验收，不能推断 300 个上游同时有效生成或支持更高并发。"
            : `客户端完成上传后的最高在途为 ${peak}，没有达到 300；未测试到的容量不能推断。`,
        "",
        "## 阶段汇总",
        "",
        "| 负载 | 格式 | 阶段 | 并发 | 样本 | 合格率 | P50秒 | P95秒 | P99秒 | 正文token/s | 在途峰值 | HTTP状态 | 分类 |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
        ...summaries.map(
            row =>
                `| ${markdown(row.profileId)} | ${markdown(row.mode)} | ${markdown(row.phase)} | ${row.concurrency} | ${row.requestCount} | ${percentage(row.qualifiedRate)} | ${display(row.p50Ms === null ? null : row.p50Ms / 1000)} | ${display(row.p95Ms === null ? null : row.p95Ms / 1000)} | ${display(row.p99Ms === null ? null : row.p99Ms / 1000)} | ${display(row.candidateTokensPerSecond)} | ${row.peakSentInFlight} | ${markdown(JSON.stringify(row.statuses))} | ${markdown(JSON.stringify(row.classifications))} |`
        ),
        "",
        "正文 token 与思考 token 分开计量；缺失 token 不等同于零，summary.csv 的 tokenCoverage 给出各字段已知/缺失样本数。token/s 仅累计已返回的 usage，失败请求未返回的消耗未知。总耗时分位数包含有耗时记录的失败和超时请求。吞吐按已完成阶段耗时计算；请求或时间缺失的统计不得作为容量证明。HTTP 200 本身不代表合格。",
        "",
        "## 未闭合阶段的部分样本",
        "",
        `发现 ${partialGroups.size} 个 requests 有记录但 stages 无闭合记录的阶段，共 ${partialStageSampleCount} 条已返回样本。这些样本只用于诊断，不进入正常波次成功率分母、阶段吞吐或容量判断；summary.csv 以 phase=partial、originalPhase 和 stageId 独立列出。阶段可能仍在运行，也可能客户端中断，具体原因须结合事件记录。未返回请求的数量和最终状态未知，不补成失败、超时或成功。恢复同档的新阶段使用新的 stageId，不能与旧部分样本合成一个波次。`,
        "",
        "| 原阶段 | 负载 | 格式 | 原阶段类型 | 目标并发 | 已返回样本 | 完整回复 | HTTP状态 | 分类 | 未返回状态 |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |",
        ...partialStageSamples.map(
            row =>
                `| ${markdown(row.stageId)} | ${markdown(row.profileId)} | ${markdown(row.mode)} | ${markdown(row.originalPhase)} | ${row.concurrency} | ${row.requestCount} | ${row.responseSuccessCount} | ${markdown(JSON.stringify(row.statuses))} | ${markdown(JSON.stringify(row.classifications))} | 未知 |`
        ),
        "",
        "## 失败证据与诊断边界",
        "",
        `不合格记录 ${failures.length} 条。下表最多显示前 30 条；全部记录见 requests.jsonl。`,
        "",
        "| 请求 | 阶段 | HTTP | 分类 | 输入token | 正文token | 思考token | 结束原因 | 耗时秒 |",
        "| --- | --- | ---: | --- | ---: | ---: | ---: | --- | ---: |",
        ...failures
            .slice(0, 30)
            .map(
                row =>
                    `| ${markdown(row.requestId || row.clientId)} | ${markdown(row.stageId)} | ${markdown(row.httpStatus)} | ${markdown(row.classification)} | ${markdown(row.promptTokens)} | ${markdown(row.candidateTokens)} | ${markdown(row.thoughtTokens)} | ${markdown(row.finishReason || row.errorCode)} | ${display(finite(row.totalMs) === null ? null : row.totalMs / 1000)} |`
            ),
        "",
        "429、503、504、空回复与断流按原始分类记录。账号切换、冷却、上下文初始化、WebSocket 拥塞或服务内存瓶颈，需要管理记录、服务器日志或平台指标支持；仅凭客户端状态不能确认根因。",
        "",
        "## 请求与最终账号关联",
        "",
        `管理用量记录 ${serverUsage.length} 条，按客户端结果中的服务器 requestId 与 server-usage.jsonl 严格关联。未匹配表示关联证据缺失，不代表请求未在服务器执行。`,
        "",
        "| 负载 | 格式 | 阶段 | 并发 | 客户端样本 | 匹配 | 未匹配 | 覆盖率 | 匹配但账号缺失 | 最终账号分布 |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
        ...summaries.map(
            row =>
                `| ${markdown(row.profileId)} | ${markdown(row.mode)} | ${markdown(row.phase)} | ${row.concurrency} | ${row.requestCount} | ${row.serverMatchedCount} | ${row.serverUnmatchedCount} | ${percentage(row.serverMatchRate)} | ${row.serverMatchedWithoutAccount} | ${markdown(JSON.stringify(row.accountDistribution))} |`
        ),
        "",
        "账号分布仅统计管理接口返回的最终账号，不能还原每次内部重试使用的账号或内部尝试次数；不存在的尝试信息没有填入推测值。实时分页可能随其他请求完成而移动，完整匹配覆盖率须结合监控采集记录判断。",
        "",
        "## 环境与缺失证据",
        "",
        `环境采样中出现的诊断字段：${fields.length ? fields.map(markdown).join("、") : "无，环境指标缺失"}。完整时间线见 environment.jsonl。`,
        "",
        `客户端网络采样 ${network.length} 条，见 client-network.jsonl / client-network.csv；系统全部网卡流量可能包含虚拟与物理接口重叠，不能直接归属测试进程。缺失时不补零。环境与真实在途 CSV 分别见 environment.csv / inflight.csv。`,
        "",
        platform.samples > 0
            ? `平台资源产物：${platform.files.map(markdown).join("、")}；检测到 ${platform.samples} 个有效数值/样本${platform.series.length ? `（${platform.series.map(markdown).join("；")}）` : ""}。这些样本与请求时间线的相关性仍需核对。`
            : `平台 CPU/内存指标缺失：${platform.files.length ? `${platform.files.map(markdown).join("、")} 只有零个有效点或 null` : "未找到平台资源产物"}。未验证服务器 CPU、内存、网络或共享 WebSocket 的具体瓶颈。`,
        "",
        platform.missing.length
            ? `平台明确缺失字段：${platform.missing.map(markdown).join("、")}。`
            : "平台未提供额外缺失字段清单。",
        "",
        platform.runtimeLogEntries === 0
            ? "平台运行日志采样返回 0 条；不能据此认定没有 OOM、重启或上游错误。"
            : platform.runtimeLogEntries === null
              ? "平台运行日志条数未知。"
              : `平台单次采样最多返回 ${platform.runtimeLogEntries} 条日志，日志覆盖范围见 platform.jsonl。`,
        "",
        "当前报告中的客户端 CPU/内存不能替代服务器 CPU/内存。未采集到的平台资源、运行日志或逐账号冷却轨迹应作为证据缺口，不能填写推测值。标准模式与 DEBUG 复测须用阶段字段区分。",
        "",
        ...warnings.map(warning => `- ${markdown(warning)}`),
    ];
    fs.mkdirSync(outputDir, { recursive: true });
    const summaryPath = path.join(outputDir, "summary.csv");
    const reportPath = path.join(outputDir, "report.md");
    fs.writeFileSync(summaryPath, csv, "utf8");
    const writeCsv = (file, records) => {
        if (!records.length) return;
        const fields = [...new Set(records.flatMap(record => Object.keys(record)))];
        fs.writeFileSync(
            path.join(outputDir, file),
            [fields.join(","), ...records.map(record => fields.map(field => csvCell(record[field])).join(","))].join(
                "\n"
            ) + "\n",
            "utf8"
        );
    };
    writeCsv(
        "environment.csv",
        environment.map(record => ({
            activeContexts: record.status?.activeContextsCount,
            clientCpuPercent: record.local?.cpu?.processPercent,
            clientRssBytes: record.local?.memory?.rssBytes,
            enabledAccounts: record.status?.enabledAccountCount,
            eventLoopP95Ms: record.local?.eventLoopDelayMs?.p95,
            label: record.label,
            ready: record.readiness?.ready,
            settings: record.settings?.values,
            systemCpuPercent: record.local?.cpu?.systemPercent,
            time: record.time,
            uptimeSeconds: record.health?.uptime,
        }))
    );
    writeCsv("inflight.csv", inflight);
    writeCsv("client-network.csv", network);
    fs.writeFileSync(reportPath, lines.join("\n") + "\n", "utf8");
    return {
        capacities: capacity,
        completedStageSampleCount: completedStageSamples.length,
        partialStageCount: partialGroups.size,
        partialStageSampleCount,
        partialStageSamples,
        reportPath,
        requestCount: requests.length,
        summaries,
        summaryPath,
        warnings,
    };
}

module.exports = { buildReport, percentile };

if (require.main === module) {
    const outputDir = process.argv[2];
    if (!outputDir) throw new Error("Usage: node scripts/loadtest/report.js <outputDir>");
    const result = buildReport(outputDir);
    process.stdout.write(
        JSON.stringify({
            reportPath: result.reportPath,
            requestCount: result.requestCount,
            summaryPath: result.summaryPath,
        }) + "\n"
    );
}
