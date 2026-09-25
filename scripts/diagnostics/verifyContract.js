const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const prefix = "contracts/diagnostics/v1/";
const digest = data => createHash("sha256").update(data).digest("hex");
const manifest = fs.readFileSync(`${prefix}SHA256SUMS`);
assert.equal(digest(manifest), "ddb202238cfdaabef1af11575dbfcac788fdbc5a457aea5e72b913afc5b478d4");
let count = 0;
const expectedFiles = new Set(["SHA256SUMS"]);
for (const line of manifest.toString().trimEnd().split("\n")) {
    const [expected, file] = line.split("  ");
    expectedFiles.add(file);
    assert.equal(digest(fs.readFileSync(path.join(prefix, file))), expected, file);
    if (process.argv.includes("--index"))
        assert.equal(digest(execFileSync("git", ["show", `:${prefix}${file}`])), expected, `Git index ${file}`);
    count++;
}
const actualFiles = fs
    .readdirSync(prefix, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(prefix, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
assert.deepEqual(actualFiles.sort(), [...expectedFiles].sort(), "No unlisted contract files");
if (process.argv.includes("--index")) {
    const indexed = execFileSync("git", ["ls-files", "--", prefix], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map(file => file.slice(prefix.length));
    assert.deepEqual(indexed.sort(), [...expectedFiles].sort(), "No unlisted indexed contract files");
}
if (process.argv.includes("--index"))
    assert.equal(digest(execFileSync("git", ["show", `:${prefix}SHA256SUMS`])), digest(manifest));
console.log(
    `Frozen contract: ${count} file hashes and manifest bytes verified${process.argv.includes("--index") ? " in worktree AND Git index" : " in worktree"}`
);
