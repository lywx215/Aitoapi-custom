const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const Headers = require("../../src/diagnostics/Headers");
const Peers = require("../../src/diagnostics/Peers");
const Resource = require("../../src/diagnostics/Resource");
const Projection = require("../../src/diagnostics/Projection");
const root = path.resolve(__dirname, "../../contracts/diagnostics/v1");
const vectors = name => JSON.parse(fs.readFileSync(path.join(root, "vectors", `${name}.json`)));
let checks = 0;
const fresh = new Set();
function compare(actual, expected, id) {
    if (expected.traceId === "<generated>") {
        assert.match(actual.traceId, /^(?!0{32}$)[0-9a-f]{32}$/);
        assert(!fresh.has(actual.traceId));
        fresh.add(actual.traceId);
        actual.traceId = "<generated>";
    }
    assert.deepEqual(actual, expected, id);
    checks++;
}
async function main() {
    for (const v of vectors("headers")) compare(Headers.extract(v.input), v.expected, v.id);
    for (const v of vectors("copy-source")) compare(Headers.filterCopied(v.input.headers), v.expected, v.id);
    for (const v of vectors("outbound")) compare(Headers.outgoing(v.input), v.expected, v.id);
    for (const v of vectors("peer-response")) compare(Headers.peerResponse(v.input), v.expected, v.id);
    for (const v of vectors("aito-mapping")) {
        const before = JSON.stringify(v.input);
        compare(Projection.aito(v.input), v.expected, v.id);
        assert.equal(JSON.stringify(v.input), before);
    }
    for (const v of vectors("peers")) {
        const snapshot = Peers.parse(v.input.config);
        compare(
            { configStatus: snapshot.configStatus, match: Peers.match(snapshot, v.input.target)?.alias || null },
            v.expected,
            v.id
        );
    }
    for (const v of vectors("resources")) {
        const result = Resource.create(v.input);
        assert.match(result.bootId, /^[0-9a-f-]{36}$/);
        assert(!fresh.has(result.bootId));
        fresh.add(result.bootId);
        result.bootId = "<new-uuid-per-worker>";
        if (v.expected.instanceId === "<random-uuid>") {
            assert.match(result.instanceId, /^[0-9a-f-]{36}$/);
            assert(!fresh.has(result.instanceId));
            fresh.add(result.instanceId);
            result.instanceId = "<random-uuid>";
        }
        compare(result, v.expected, v.id);
    }
    for (const v of vectors("redirects")) {
        const peers = Peers.parse(v.input.peers);
        let previous = {
            diagnosticOwned: false,
            headers: Object.fromEntries(v.input.headers.map(([k, value]) => [k, [value]])),
        };
        const actual = [];
        for (const step of v.input.steps) {
            const clean = Headers.outgoing({
                allowed: false,
                diagnosticOwned: previous.diagnosticOwned,
                headers: Object.entries(previous.headers).flatMap(([k, vs]) => vs.map(value => [k, value])),
            });
            const fields = Object.entries(clean.headers).flatMap(([k, vs]) => vs.map(value => [k, value]));
            for (const [k, value] of step.businessHeaders || []) {
                for (let i = fields.length - 1; i >= 0; i--)
                    if (fields[i][0].toLowerCase() === k.toLowerCase()) fields.splice(i, 1);
                fields.push([k, value]);
            }
            previous = Headers.outgoing({
                ...step,
                allowed: Boolean(Peers.match(peers, step.target)),
                diagnosticOwned: false,
                headers: fields,
            });
            actual.push(previous);
        }
        compare(actual, v.expected, v.id);
    }
    // Exercise the real Node HTTP parser. Raw socket bytes exist only on the fixture client.
    for (const v of vectors("http-ingress")) {
        let observed;
        const server = http.createServer((req, res) => {
            const fields = Headers.fields(req).filter(([k]) => k.toLowerCase() !== "connection");
            observed = {
                fields: fields.map(([k, value]) => [k.toLowerCase(), value]),
                result: Headers.extract({ headers: fields }),
            };
            res.end("unchanged");
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        await new Promise((resolve, reject) => {
            const socket = net.connect(server.address().port, "127.0.0.1", () =>
                socket.write(`GET / HTTP/1.0\r\n${v.input.wireHeaderLines.join("\r\n")}\r\n\r\n`)
            );
            socket.on("error", reject);
            socket.resume();
            socket.on("end", resolve);
        });
        await new Promise(resolve => server.close(resolve));
        assert.deepEqual(observed.fields, v.input.headers, v.id);
        compare(observed.result, v.expected, v.id);
    }
    console.log(`diagnostics runtime contract vectors: ${checks} passed`);
}
main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
