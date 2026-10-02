#!/usr/bin/env python3
"""Read-only Zeabur platform sampling through the user's shared local helper."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import re
import signal
import sys
import threading
import time
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path


HELPER = Path("G:/code/gemini30/zeaburcli/zeaburctl.py")
ARTIFACTS = Path(__file__).resolve().parents[2] / "artifacts" / "loadtest"
BASELINE_QUERY = """query LoadtestPlatformBaseline($service:ObjectID!,$environment:ObjectID!){
  service(_id:$service){
    status(environmentID:$environment)
    resourceLimit{cpu memory}
    maxResourceLimit{cpu memory}
    podStatuses(environmentID:$environment){name status}
  }
  deployments(serviceID:$service,environmentID:$environment,perPage:1){
    edges{node{_id status createdAt finishedAt commitSHA}}
  }
}"""
METRICS_QUERY = """query LoadtestPlatformMetrics($service:ObjectID!,$project:ObjectID!,$environment:ObjectID!,$start:Time!,$end:Time!){
  service(_id:$service){
    cpu:metrics(projectID:$project,environmentID:$environment,metricType:CPU,startTime:$start,endTime:$end){timestamp value}
    memory:metrics(projectID:$project,environmentID:$environment,metricType:MEMORY,startTime:$start,endTime:$end){timestamp value}
    networkMetrics(environmentID:$environment,startTime:$start,endTime:$end){region value{timestamp value}}
  }
}"""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def finite(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def iso_time(value):
    if not isinstance(value, str) or len(value) > 48:
        return None
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value
    except ValueError:
        return None


def enum_string(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", value) else None


def hex_id(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-fA-F0-9]{24,64}", value) else None


def load_helper():
    # Importing the shared helper must not create files next to its credentials.
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("loadtest_zeabur_shared", HELPER)
    if spec is None or spec.loader is None:
        raise RuntimeError("shared_helper_unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def safe_call(call):
    try:
        return {"ok": True, "data": call()}
    except Exception:
        # The helper's exception messages may contain API details. Never export them.
        return {"ok": False, "errorCode": "platform_api_unavailable"}


def metric_points(points):
    if not isinstance(points, list):
        return []
    return [{"timestamp": iso_time(point.get("timestamp")), "value": finite(point.get("value"))}
            for point in points if isinstance(point, dict)
            and iso_time(point.get("timestamp")) is not None and finite(point.get("value")) is not None]


class PlatformSampler:
    def __init__(self, helper, profile, window_seconds=180):
        self.helper = helper
        self.profile = profile
        self.window_seconds = window_seconds
        self.seen_logs = set()
        self.log_order = deque()
        self.previous_pods = None
        self.previous_deployment = None

    def logs(self, entries):
        counts = Counter()
        diagnostics = []
        timestamps = []
        new_count = 0
        for entry in entries if isinstance(entries, list) else []:
            if not isinstance(entry, dict):
                continue
            message = entry.get("message")
            if not isinstance(message, str):
                continue
            stamp = iso_time(entry.get("timestamp"))
            if stamp:
                timestamps.append(stamp)
            digest = hashlib.sha256((str(entry.get("timestamp")) + "\n" + message).encode("utf8")).hexdigest()
            if digest in self.seen_logs:
                continue
            self.seen_logs.add(digest)
            self.log_order.append(digest)
            while len(self.log_order) > 20000:
                self.seen_logs.discard(self.log_order.popleft())
            new_count += 1
            lowered = message.lower()
            for code in (429, 502, 503, 504):
                if re.search(rf"(?<!\d){code}(?!\d)", message):
                    counts[f"status_{code}_mentions"] += 1
            for label, pattern in {
                "oom_mentions": r"oomkilled|out.of.memory|\boom\b|heap out of memory",
                "timeout_mentions": r"timeout|timed out|超时",
                "empty_reply_mentions": r"empty (?:response|reply)|空回复|空响应",
                "restart_mentions": r"restart|restarting|重启",
                "cooldown_mentions": r"cooldown|冷却",
                "switch_mentions": r"switch|切换",
                "backpressure_mentions": r"backpressure|背压",
            }.items():
                if re.search(pattern, lowered):
                    counts[label] += 1
            marker = message.find("@diag ")
            if marker < 0:
                continue
            try:
                record = json.loads(message[marker + 6:])
            except (ValueError, TypeError):
                counts["diagnostic_parse_failures"] += 1
                continue
            if not isinstance(record, dict):
                continue
            event = record.get("event")
            if not isinstance(event, str) or not re.fullmatch(r"(?:diag|debug)\.[a-zA-Z0-9_.-]{1,100}", event):
                continue
            # Export a small explicit schema. No arbitrary data, text, headers, names or errors.
            safe = {"event": event, "timestamp": stamp}
            for name in ("requestId", "callerRequestId"):
                value = record.get(name)
                if isinstance(value, str) and re.fullmatch(
                    r"(?:req_|loadtest-|calibration-|wave-|explore-|refine-|confirm-|sustain-|nonstream-|debug-|count-)[A-Za-z0-9_.:-]{1,200}", value
                ):
                    safe[name] = value
            for name in ("logSeq", "attemptIndex", "accountIndex", "durationMs", "statusCode", "pid"):
                if finite(record.get(name)) is not None:
                    safe[name] = record[name]
            data = record.get("data")
            if isinstance(data, dict):
                numeric = {name: data[name] for name in (
                    "durationMs", "statusCode", "attemptIndex", "accountIndex", "bytes", "chunkCount", "elapsedMs",
                    "promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount"
                ) if finite(data.get(name)) is not None}
                if numeric:
                    safe["data"] = numeric
            diagnostics.append(safe)
        return {"rawEntryCount": len(entries) if isinstance(entries, list) else 0,
                "newEntryCount": new_count, "firstTimestamp": min(timestamps) if timestamps else None,
                "lastTimestamp": max(timestamps) if timestamps else None,
                "errorMentionCounts": dict(counts), "diagnostics": diagnostics,
                "rawMessagesStored": False, "coverage": "entries_available" if entries else "no_entries_returned"}

    def sample(self):
        now = datetime.now(timezone.utc)
        variables = {"service": self.profile["service_id"], "environment": self.profile["environment_id"]}
        metric_variables = {**variables, "project": self.profile["project_id"],
                            "start": (now - timedelta(seconds=self.window_seconds)).isoformat(), "end": now.isoformat()}
        with ThreadPoolExecutor(max_workers=3) as pool:
            baseline_job = pool.submit(safe_call, lambda: self.helper.graphql(BASELINE_QUERY, variables))
            metrics_job = pool.submit(safe_call, lambda: self.helper.graphql(METRICS_QUERY, metric_variables))
            logs_job = pool.submit(safe_call, lambda: self.helper.fetch_logs(self.profile, "runtime", None))
            baseline, metrics, logs = baseline_job.result(), metrics_job.result(), logs_job.result()
        result = {"time": now.isoformat(), "collectedAt": utc_now(), "source": "zeabur_graphql",
                  "windowSeconds": self.window_seconds, "readOnly": True, "missing": [],
                  "metricUnits": {"cpu": "not_documented_by_schema", "memory": "not_documented_by_schema",
                                  "network": "not_documented_by_schema"}}
        if baseline["ok"]:
            data = baseline["data"]
            service = data.get("service") or {}
            result["serviceStatus"] = enum_string(service.get("status"))
            result["resources"] = {name: {key: finite((service.get(name) or {}).get(key)) for key in ("cpu", "memory")}
                                   for name in ("resourceLimit", "maxResourceLimit")}
            for name, limits in result["resources"].items():
                if any(value is None for value in limits.values()):
                    result["missing"].append(f"{name}_incomplete")
            pods = [{"identityHash": hashlib.sha256(str(pod.get("name", "")).encode("utf8")).hexdigest()[:16],
                     "status": enum_string(pod.get("status"))} for pod in service.get("podStatuses") or []
                    if isinstance(pod, dict)]
            identities = sorted(pod["identityHash"] for pod in pods)
            result["pods"] = pods
            result["podIdentityChanged"] = self.previous_pods is not None and identities != self.previous_pods
            self.previous_pods = identities
            edges = (data.get("deployments") or {}).get("edges") or []
            latest = (edges[0].get("node") or {}) if edges else {}
            deployment = {"id": hex_id(latest.get("_id")), "status": enum_string(latest.get("status")),
                          "commitSHA": hex_id(latest.get("commitSHA")), "createdAt": iso_time(latest.get("createdAt")),
                          "finishedAt": iso_time(latest.get("finishedAt"))}
            result["deployment"] = deployment
            result["deploymentChanged"] = self.previous_deployment is not None and deployment["id"] != self.previous_deployment
            self.previous_deployment = deployment["id"]
            result["missing"].append("pod_restart_count_and_termination_reason_not_exposed")
        else:
            result["baselineErrorCode"] = baseline["errorCode"]
            result["missing"].append("platform_baseline_unavailable")
        result["metrics"] = {"cpu": [], "memory": [], "network": []}
        if metrics["ok"]:
            service = metrics["data"].get("service") or {}
            for name in ("cpu", "memory"):
                result["metrics"][name] = metric_points(service.get(name))
                if not result["metrics"][name]:
                    result["missing"].append(f"{name}_metric_points_empty")
            result["metrics"]["network"] = [
                {"region": item["region"], "points": metric_points(item.get("value"))}
                for item in service.get("networkMetrics") or []
                if isinstance(item, dict) and isinstance(item.get("region"), str)
                and re.fullmatch(r"[a-z]{2,6}[0-9]{1,2}", item["region"])
            ]
            if not any(item["points"] for item in result["metrics"]["network"]):
                result["missing"].append("network_metric_points_empty")
        else:
            result["metricsErrorCode"] = metrics["errorCode"]
            result["missing"].append("platform_metrics_unavailable")
        if logs["ok"]:
            result["logs"] = self.logs(logs["data"])
            if result["logs"]["rawEntryCount"] == 0:
                result["missing"].append("runtime_log_entries_empty")
            result["oom"] = {"logMentionCount": result["logs"]["errorMentionCounts"].get("oom_mentions", 0),
                             "terminationReason": None, "confirmed": None}
        else:
            result["logs"] = {"errorCode": logs["errorCode"], "coverage": "unavailable", "rawMessagesStored": False}
            result["missing"].append("runtime_logs_unavailable")
            result["oom"] = {"logMentionCount": None, "terminationReason": None, "confirmed": None}
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--watch", action="store_true")
    parser.add_argument("--window-seconds", type=int, default=180)
    parser.add_argument("--duration-seconds", type=int, default=0)
    args = parser.parse_args()
    output = Path(args.output_dir).resolve()
    if not output.is_relative_to(ARTIFACTS.resolve()) or output == ARTIFACTS.resolve():
        raise RuntimeError("output_directory_outside_artifacts")
    if not 30 <= args.window_seconds <= 3600 or args.duration_seconds < 0:
        raise RuntimeError("invalid_arguments")
    output.mkdir(parents=True, exist_ok=True)
    helper = load_helper()
    profile = helper.get_project("aitoapi")
    sampler = PlatformSampler(helper, profile, args.window_seconds)
    stopped = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    started = time.monotonic()
    while not stopped.is_set():
        sample_started = time.monotonic()
        record = sampler.sample()
        with (output / "platform.jsonl").open("a", encoding="utf8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + "\n")
        print(json.dumps({"event": "platform_sample", "time": record["time"],
                          "serviceStatus": record.get("serviceStatus"), "missing": record["missing"]}), flush=True)
        if not args.watch or (args.duration_seconds and time.monotonic() - started >= args.duration_seconds):
            break
        wait = max(0, 30 - (time.monotonic() - sample_started))
        if args.duration_seconds:
            wait = min(wait, max(0, args.duration_seconds - (time.monotonic() - started)))
        stopped.wait(wait)
        if args.duration_seconds and time.monotonic() - started >= args.duration_seconds:
            break


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error)
        safe = message if message in {"output_directory_outside_artifacts", "invalid_arguments", "shared_helper_unavailable"} else "platform_sampling_failed"
        print(json.dumps({"event": "platform_error", "code": safe}), file=sys.stderr)
        sys.exit(1)
