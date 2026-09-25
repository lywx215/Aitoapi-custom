"""Offline schema/semantic QA of real Node output; never used by the service."""
import importlib.util
import json
import pathlib
import sys
sys.dont_write_bytecode = True

root = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("contract", root / "contracts/diagnostics/v1/validate.py")
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
total = 0
for filename in sys.argv[1:]:
    for index, line in enumerate(pathlib.Path(filename).read_text(encoding="utf-8").splitlines(), 1):
        if line.startswith("@diag "):
            line = line[6:]
        record = json.loads(line)
        contract.SCHEMA.validate(record)
        issues = contract.semantic_issues(record)
        assert not issues, (filename, index, issues)
        assert len(("@diag " + line + "\n").encode()) <= 4096, (filename, index, "line_limit")
        total += 1
print(f"PASS: {total} runtime records (schema, cross-field semantics, 4096-byte limit)")
