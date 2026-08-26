#!/usr/bin/env python3
"""
survey-schema.py -- schema survey of Claude Code session files.

Walks every ``*.jsonl`` under ``~/.claude/projects`` (main session transcripts,
``<sid>/subagents/agent-*.jsonl``, ``<sid>/subagents/workflows/wf_*/agent-*.jsonl``
and ``journal.jsonl``), plus the sibling ``.meta.json`` / ``workflows/*.json`` /
``tool-results/*`` files and the ``~/.claude`` side files (history.jsonl,
stats-cache.json, sessions/, tasks/, teams/, session-env/, file-history/,
plugins/installed_plugins.json, settings.json), and emits a machine-readable
schema census: for every record type, every JSON path with presence counts and
observed JSON types, small-cardinality enumerations for whitelisted fields,
numeric ranges, tool-level statistics, streaming/dedupe measurements, file-level
statistics and directory layout.

Design rules (this file is meant to become orangu's schema-drift detector):

* streaming: files are read line by line in binary mode, never loaded whole;
* memory-safe: per-file working sets (uuid maps, tool_use_id -> tool name)
  are released after each file; nested dicts with dynamic keys (file paths,
  ids, hashes) are collapsed to ``*``; enumerations are capped;
* privacy: transcript message strings are not written by default. Output still
  includes relative file paths, session identifiers, timestamps, and values from
  an explicit metadata whitelist (type/subtype/model/version/...). ``--discover``
  also prints selected candidate string values to stderr. Treat every output as
  potentially sensitive and review it before sharing;
* fast: one worker process per file batch (``--workers``), merged at the end;
* pure standard library, Python >= 3.9.

Usage:
    survey-schema.py [--root ~/.claude] [--out schema-survey.json]
                     [--workers N] [--limit N] [--per-file] [--discover] [--quiet]

Exit code 0 on success, 2 if <root>/projects does not exist.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from typing import Any, Dict, Iterable, List, Optional, Tuple

# ----------------------------------------------------------------------------
# constants
# ----------------------------------------------------------------------------

MAX_DEPTH = 10            # max nesting recorded by the generic walker
MAX_CHILD_KEYS = 120      # more distinct child keys than this -> collapse to '*'
MAX_ENUM_VALUES = 600     # cap on distinct values kept for a whitelisted enum path
MAX_DISCOVER_VALUES = 24  # cap for --discover candidate sets (memory only)
INPUT_DEPTH = 2           # depth recorded inside tool_use.input
TUR_DEPTH = 5             # depth recorded inside toolUseResult

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
HEXISH_RE = re.compile(r"^[0-9a-f]{12,}$", re.I)
ID_PREFIX_RE = re.compile(r"^(toolu_|msg_|req_|wf_|agent-|a[0-9a-f]{16}$|call_|srvtoolu_)")
TOKENISH_RE = re.compile(r"^[A-Za-z0-9_.:\-/@\[\] ]{1,40}$")
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
DATE_KEY_RE = re.compile(r"^\d{4}-\d{2}(-\d{2})?")

# leaf names whose (short) values are safe, low-cardinality enumerations
ENUM_LEAVES = {
    "type", "subtype", "role", "model", "stop_reason", "status", "operation",
    "mode", "permissionMode", "entrypoint", "userType", "version", "effort",
    "service_tier", "speed", "inference_geo", "hookEvent", "hookName", "level",
    "agentType", "taskKind", "color", "origin", "promptSource", "queuePriority",
    "kind", "state", "provider", "isSidechain", "isMeta",
    "isCompactSummary", "isVisibleInTranscriptOnly", "isSnapshotUpdate",
    "is_error", "interrupted", "isImage", "trigger", "spawnDepth", "modelId",
    "sandbox", "backgroundTaskId", "phase",
    "priority", "event", "eventName", "hook_event_name", "role_type",
    "sourceType", "format", "media_type", "encoding", "action", "policy",
    "behavior", "displayMode", "compactionMode", "compaction",
    "budgetKind", "planMode", "activeTool", "toolName", "tool_name", "toolUseCount",
    "isReplay", "isEmpty", "aborted", "cancelled", "success", "isSummary",
    "wasInterrupted", "durationUnit", "resumed", "hasThinking", "isTruncated",
    "truncated", "citations", "cache_control", "ttl", "id_type",
    # eligible low-cardinality identifiers found by --discover; all are safe to enumerate
    "commandMode", "reminderType", "fromMode", "toolDenialKind", "attributionAgent",
    "attributionMcpServer", "attributionMcpTool", "attributionPlugin", "attributionSkill",
    "apiRefusalCategory", "direction", "fallbackModel", "originalModel",
    "agent_type", "subagent_type", "resolvedModel", "liveSubscription",
    "returnCodeInterpretation", "isolation", "skill", "isApiErrorMessage",
    "toolEndsTurn", "hasOutput", "preventedContinuation", "isSnapshotUpdate",
    "apiErrorStatus", "toolUseResult_type", "runInBackground", "run_in_background",
    "dangerouslyDisableSandbox", "isReadOnly", "isSandboxed", "isBackground",
    "wasBackground", "background", "shellType", "sourceKind", "resultKind",
    "closeReason", "exitReason", "terminationReason", "cancelReason",
    "compactReason", "compactionReason", "summaryType", "snapshotType",
    "deltaType", "linkType", "authorRole", "senderRole",
    "queueSource", "queuedFrom", "hookEventName", "hook_event", "hookType",
    "isBlocking", "blocking", "warnedAt", "thresholdType", "modelClass",
    "resolvedModelClass", "effortLevel", "thinkingLevel", "reasoningEffort",
    "isEphemeral", "ephemeral", "isolationMode", "workflowState", "phaseName",
    "isTeammate", "isLead", "teamRole", "verified", "isVerified", "notified",
    "isFallback", "fallbackReason", "retry", "isRetry", "wasRetried",
    "taskType", "task_type", "retrieval_status", "codeText", "senderColor",
    "targetColor", "updatedFields", "disabledReason", "cronKind", "scope",
    "output_mode", "colorScheme", "nameSource", "backendType",
}
# leaf names that are never enumerated even if they end up in ENUM_LEAVES
# (they hold text/paths/ids)
NEVER_ENUM_LEAVES = {"name", "id", "text", "content", "cwd", "gitBranch",
                     "uuid", "parentUuid", "sessionId", "leafUuid", "path",
                     "filePath", "file_path", "command", "prompt", "description",
                     "title", "summary", "url", "query", "pattern", "message",
                     "signature", "data", "input", "output", "stdout", "stderr",
                     "session_id", "slug", "agentId", "requestId", "toolUseID",
                     "tool_use_id", "source_uuid", "timestamp", "hopChain",
                     "senderTaskId", "worktreeBranch", "team_name", "pin",
                     "resumedAgentId", "sourceToolUseID", "sourceToolAssistantUUID",
                     "newDate", "displayPath", "taskId", "task_id", "owner",
                     "label", "ref", "favicon", "addedNames", "removedNames",
                     "body", "from", "to", "email", "key", "value", "sha",
                     "branch", "commit", "messageId", "promptId", "customTitle",
                     "aiTitle", "agentName", "prRepository", "prUrl", "prNumber",
                     "activeForm", "subject", "author", "user", "login", "token",
                     "apiKey", "secret", "password", "cookie", "header", "headers",
                     "recipient", "sender", "teammate_id", "agent_id", "leadAgentId"}
# top-level path prefixes whose *keys* are dynamic (collapsed to '*')
DYNAMIC_KEY_PARENTS = {
    "snapshot.trackedFileBackups", "trackedFileBackups", "pastedContents",
    "modelUsage", "projects", "byModel", "byDay", "byTool", "byDate",
    "dailyModelTokens", "dailyActivity", "modelUsageByDay", "tokensByModel",
    "hourCounts",
}

# whitelisted (safe) exact paths for enumerating values even though the leaf
# name is generic
ENUM_EXACT_PATHS = {
    "error",                           # top-level assistant error class (rate_limit, ...)
    "message.content[].name",          # tool_use tool name
    "message.usage.cache_creation.ephemeral_5m_input_tokens",  # numeric anyway
    "toolUseResult.status",
    "toolUseResult.type",
    "attachment.type",
    "attachment.hookEvent",
    "attachment.hookName",
    "attachment.toolName",
    "operation",
    "mode",
    "permissionMode",
    "level",
    "isVisibleInTranscriptOnly",
    "slashCommand",
}
ENUM_LEAVES -= NEVER_ENUM_LEAVES
# scopes whose payloads are user-defined (structured outputs): shapes only, no values
NO_ENUM_SCOPES = {"input:StructuredOutput", "tur:StructuredOutput", "rec:result",
                  "input:TaskCreate", "input:TaskUpdate", "tur:TaskCreate", "tur:TaskUpdate",
                  "tur:TaskGet", "tur:TaskList", "att:task_reminder"}


def jtype(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, int):
        return "int"
    if isinstance(v, float):
        return "float"
    if isinstance(v, str):
        return "str"
    if isinstance(v, list):
        return "list"
    if isinstance(v, dict):
        return "dict"
    return type(v).__name__


def is_dynamic_key(k: str) -> bool:
    if len(k) > 48 or "/" in k or "\\" in k or " " in k:
        return True
    if UUID_RE.match(k) or HEXISH_RE.match(k) or ID_PREFIX_RE.match(k):
        return True
    if k.isdigit() or "@" in k:
        return True
    if DATE_KEY_RE.match(k):
        return True
    return False


# ----------------------------------------------------------------------------
# Schema: path -> stats
# ----------------------------------------------------------------------------

class Schema:
    """A census of JSON paths.

    entry = {
        'n': presence count,
        't': Counter(json type -> count),
        'v': Counter(value -> count) or None,   # only for enum-whitelisted paths
        'hc': bool,                             # enum overflowed MAX_ENUM_VALUES
        'num': [min, max, sum, count] or None,  # numeric leaves
        'len': [min, max, sum, count] or None,  # str length / list length
    }
    """

    __slots__ = ("paths", "children", "records", "discover", "enums")

    def __init__(self, discover: bool = False, enums: bool = True):
        self.paths: Dict[str, dict] = {}
        self.children: Dict[str, set] = defaultdict(set)   # parent path -> child keys
        self.records = 0
        self.discover: Optional[Dict[str, Optional[set]]] = {} if discover else None
        self.enums = enums   # False for scopes holding user-defined payloads

    # -- observation ---------------------------------------------------------
    def _entry(self, path: str) -> dict:
        e = self.paths.get(path)
        if e is None:
            e = {"n": 0, "t": Counter(), "v": None, "hc": False, "num": None, "len": None}
            self.paths[path] = e
        return e

    def observe(self, value: Any, path: str = "", depth: int = 0,
                max_depth: int = MAX_DEPTH, leaf: str = "") -> None:
        e = self._entry(path)
        e["n"] += 1
        t = jtype(value)
        e["t"][t] += 1
        if t == "dict":
            if depth >= max_depth:
                return
            parent_is_dynamic = path in DYNAMIC_KEY_PARENTS or path.endswith(".*") \
                or (path and path.split(".")[-1] in DYNAMIC_KEY_PARENTS)
            kids = self.children[path]
            for k, v in value.items():
                if parent_is_dynamic or is_dynamic_key(k) or (k not in kids and len(kids) >= MAX_CHILD_KEYS):
                    kk = "*"
                else:
                    kk = k
                    kids.add(k)
                self.observe(v, f"{path}.{kk}" if path else kk, depth + 1, max_depth, kk)
        elif t == "list":
            ln = len(value)
            self._num(e, "len", ln)
            if depth >= max_depth:
                return
            sub = f"{path}[]"
            for v in value:
                self.observe(v, sub, depth + 1, max_depth, leaf)
        elif t == "str":
            self._num(e, "len", len(value))
            self._enum(e, path, leaf, value)
        elif t == "bool":
            self._enum(e, path, leaf, value, force=True)
        elif t in ("int", "float"):
            self._num(e, "num", value)
            if leaf in ("spawnDepth", "iterations", "ttl", "toolUseCount", "queuePriority",
                        "level", "attempt", "retries", "maxDepth", "exitCode", "exit_code",
                        "returncode", "status", "code"):
                self._enum(e, path, leaf, value, force=True)

    def observe_children(self, value: Any, path: str, depth: int, max_depth: int = MAX_DEPTH) -> None:
        """Observe the children of an already-counted container path."""
        if isinstance(value, dict):
            kids = self.children[path]
            for k, v in value.items():
                if is_dynamic_key(k) or (k not in kids and len(kids) >= MAX_CHILD_KEYS):
                    kk = "*"
                else:
                    kk = k
                    kids.add(k)
                self.observe(v, f"{path}.{kk}", depth + 1, max_depth, kk)
        elif isinstance(value, list):
            for v in value:
                self.observe(v, f"{path}[]", depth + 1, max_depth, path.rsplit(".", 1)[-1])

    @staticmethod
    def _num(e: dict, key: str, x) -> None:
        s = e[key]
        if s is None:
            e[key] = [x, x, x, 1]
        else:
            if x < s[0]:
                s[0] = x
            if x > s[1]:
                s[1] = x
            s[2] += x
            s[3] += 1

    def _enum(self, e: dict, path: str, leaf: str, value, force: bool = False) -> None:
        if not self.enums or ".metadata." in path or path.startswith("metadata."):
            return
        if force or path in ENUM_EXACT_PATHS or (leaf in ENUM_LEAVES and leaf not in NEVER_ENUM_LEAVES):
            if isinstance(value, str) and len(value) > 80:
                # never keep long strings even on whitelisted paths
                e["hc"] = True
                return
            if e["hc"]:
                return
            c = e["v"]
            if c is None:
                c = e["v"] = Counter()
            key = value if isinstance(value, str) else json.dumps(value)
            if key in c or len(c) < MAX_ENUM_VALUES:
                c[key] += 1
            else:
                e["hc"] = True
                e["v"] = None
        elif self.discover is not None and isinstance(value, str) and leaf not in NEVER_ENUM_LEAVES:
            s = self.discover.get(path, set())
            if s is None:
                return
            if len(value) > 60:
                self.discover[path] = None
                return
            s.add(value)
            if len(s) > MAX_DISCOVER_VALUES:
                self.discover[path] = None
            else:
                self.discover[path] = s

    # -- merge / export -----------------------------------------------------
    def merge(self, other: "Schema") -> None:
        self.records += other.records
        for p, oe in other.paths.items():
            e = self._entry(p)
            e["n"] += oe["n"]
            e["t"].update(oe["t"])
            if oe["hc"]:
                e["hc"] = True
                e["v"] = None
            elif oe["v"] is not None and not e["hc"]:
                if e["v"] is None:
                    e["v"] = Counter()
                e["v"].update(oe["v"])
                if len(e["v"]) > MAX_ENUM_VALUES:
                    e["hc"] = True
                    e["v"] = None
            for k in ("num", "len"):
                if oe[k] is not None:
                    if e[k] is None:
                        e[k] = list(oe[k])
                    else:
                        s = e[k]
                        s[0] = min(s[0], oe[k][0])
                        s[1] = max(s[1], oe[k][1])
                        s[2] += oe[k][2]
                        s[3] += oe[k][3]
        for p, kids in other.children.items():
            self.children[p] |= kids
        if self.discover is not None and other.discover is not None:
            for p, s in other.discover.items():
                if p in self.discover and self.discover[p] is None:
                    continue
                if s is None:
                    self.discover[p] = None
                else:
                    cur = self.discover.get(p, set())
                    cur |= s
                    self.discover[p] = None if len(cur) > MAX_DISCOVER_VALUES else cur

    def export(self, top_n: int = 60) -> dict:
        out = {}
        for p in sorted(self.paths):
            e = self.paths[p]
            row: dict = {"n": e["n"], "types": dict(e["t"])}
            if e["v"] is not None:
                vals = e["v"].most_common()
                row["values"] = {k: v for k, v in vals[:top_n]}
                if len(vals) > top_n:
                    row["values_truncated"] = len(vals) - top_n
                row["distinct"] = len(vals)
            elif e["hc"]:
                row["values"] = "high-cardinality"
            if e["num"] is not None:
                mn, mx, sm, ct = e["num"]
                row["num"] = {"min": mn, "max": mx, "mean": round(sm / ct, 3), "count": ct}
            if e["len"] is not None:
                mn, mx, sm, ct = e["len"]
                row["len"] = {"min": mn, "max": mx, "mean": round(sm / ct, 1)}
            out[p] = row
        return {"records": self.records, "paths": out}


# ----------------------------------------------------------------------------
# per-file survey
# ----------------------------------------------------------------------------

def classify(rel: str) -> str:
    """Category of a jsonl file by its path relative to <root>/projects."""
    parts = rel.split("/")
    if len(parts) == 2 and parts[1].endswith(".jsonl"):
        return "main"
    if len(parts) >= 4 and parts[2] == "subagents":
        if parts[3] == "workflows":
            if parts[-1] == "journal.jsonl":
                return "wf_journal"
            if parts[-1].startswith("agent-"):
                return "wf_subagent"
            return "wf_other"
        if parts[-1].startswith("agent-"):
            return "subagent"
        return "subagent_other"
    return "other"


class FileStats:
    """Aggregate for one worker batch (merged in the parent)."""

    def __init__(self, discover: bool):
        d = discover
        self.scopes: Dict[str, Schema] = {}
        self.discover = discover
        self.cat = Counter()               # category -> files
        self.cat_bytes = Counter()
        self.cat_records = Counter()
        self.cat_bad = Counter()
        self.types_by_cat: Dict[str, Counter] = defaultdict(Counter)
        self.tools: Dict[str, dict] = {}
        self.files: List[dict] = []
        self.session_files: Dict[str, List[str]] = defaultdict(list)  # sessionId -> main files
        self.msgid_group_sizes = Counter()  # size -> groups (assistant records sharing message.id)
        self.msgid_usage_identical = Counter()
        self.msgid_usage_diff_fields = Counter()
        self.msgid_chain_ok = Counter()      # 'ok'/'broken' parent chain inside a group
        self.msgid_final_pos = Counter()     # where the final usage sits inside a group
        self.msgid_group_block_combo = Counter()
        self.reqid_group_sizes = Counter()
        self.assistant_block_combo = Counter()
        self.assistant_blocks_per_record = Counter()
        self.user_kind = Counter()
        self.user_tool_results_per_record = Counter()
        self.tool_result_shape = Counter()
        self.tool_result_block_types = Counter()
        self.tur_present_by_tool = Counter()
        self.tur_type_by_tool: Dict[str, Counter] = defaultdict(Counter)
        self.tool_result_orphans = 0
        self.ctx_drop_events = 0
        self.ctx_max_hist = Counter()        # bucket -> files
        self.compact_signals = Counter()
        self.ts_format = Counter()
        self.sidechain_by_cat: Dict[str, Counter] = defaultdict(Counter)
        self.agentid_by_cat: Dict[str, Counter] = defaultdict(Counter)
        self.version_by_cat: Dict[str, Counter] = defaultdict(Counter)
        self.first_ts: Optional[str] = None
        self.last_ts: Optional[str] = None
        self.subagent_meta_match = Counter()
        self.parent_chain = Counter()  # roots / orphans / linked
        self.multi_version_files = 0
        self.sid_mismatch = Counter()

    def scope(self, name: str) -> Schema:
        s = self.scopes.get(name)
        if s is None:
            s = self.scopes[name] = Schema(self.discover, enums=name not in NO_ENUM_SCOPES)
        return s

    def tool(self, name: str) -> dict:
        t = self.tools.get(name)
        if t is None:
            t = self.tools[name] = {"tool_use": 0, "tool_result": 0, "is_error": 0,
                                    "result_chars": 0, "result_shape": Counter(),
                                    "input_keys": Counter(), "tur": 0}
        return t

    # -- merge ---------------------------------------------------------------
    def merge(self, o: "FileStats") -> None:
        for k, s in o.scopes.items():
            self.scope(k).merge(s)
        for attr in ("cat", "cat_bytes", "cat_records", "cat_bad", "msgid_group_sizes",
                     "msgid_usage_identical", "msgid_usage_diff_fields", "msgid_chain_ok", "msgid_final_pos",
                     "msgid_group_block_combo", "reqid_group_sizes", "assistant_block_combo",
                     "assistant_blocks_per_record", "user_kind", "user_tool_results_per_record",
                     "tool_result_shape", "tool_result_block_types", "tur_present_by_tool",
                     "ctx_max_hist", "compact_signals", "ts_format", "subagent_meta_match",
                     "parent_chain", "sid_mismatch"):
            getattr(self, attr).update(getattr(o, attr))
        for attr in ("types_by_cat", "tur_type_by_tool", "sidechain_by_cat", "agentid_by_cat",
                     "version_by_cat"):
            mine = getattr(self, attr)
            for k, c in getattr(o, attr).items():
                mine[k].update(c)
        for name, t in o.tools.items():
            m = self.tool(name)
            for k in ("tool_use", "tool_result", "is_error", "result_chars", "tur"):
                m[k] += t[k]
            m["result_shape"].update(t["result_shape"])
            m["input_keys"].update(t["input_keys"])
        self.files.extend(o.files)
        for sid, fl in o.session_files.items():
            self.session_files[sid].extend(fl)
        self.tool_result_orphans += o.tool_result_orphans
        self.ctx_drop_events += o.ctx_drop_events
        self.multi_version_files += o.multi_version_files
        for a in ("first_ts", "last_ts"):
            v = getattr(o, a)
            if v is not None:
                cur = getattr(self, a)
                if cur is None or (a == "first_ts" and v < cur) or (a == "last_ts" and v > cur):
                    setattr(self, a, v)


def _content_blocks(msg: Any) -> Tuple[str, list]:
    """Return (shape, blocks) for message.content."""
    if not isinstance(msg, dict):
        return "no-message", []
    c = msg.get("content")
    if isinstance(c, str):
        return "str", []
    if isinstance(c, list):
        return "list", c
    if c is None:
        return "absent" if "content" not in msg else "null", []
    return jtype(c), []


def _tool_result_chars(block: dict) -> int:
    c = block.get("content")
    if isinstance(c, str):
        return len(c)
    n = 0
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict):
                t = b.get("text")
                if isinstance(t, str):
                    n += len(t)
                elif b.get("type") == "image":
                    src = b.get("source")
                    if isinstance(src, dict) and isinstance(src.get("data"), str):
                        n += len(src["data"])
    return n


def survey_jsonl(path: str, rel: str, cat: str, st: FileStats, keep_per_file: bool) -> None:
    size = os.path.getsize(path)
    st.cat[cat] += 1
    st.cat_bytes[cat] += size
    frec: dict = {"path": rel, "cat": cat, "bytes": size, "lines": 0, "bad": 0,
                  "max_line": 0, "types": Counter(), "roots": 0, "orphans": 0,
                  "ts_nonmono": 0, "sids": 0, "sid_match": None, "first_ts": None,
                  "last_ts": None, "versions": [], "assistant": 0, "prompts": 0,
                  "ctx_max": 0, "compact": 0, "bad_last": False, "msgid_dups": 0,
                  "dup_uuids": 0}
    uuids: set = set()
    uuid_counts: Counter = Counter()
    parents: List[str] = []
    tool_names: Dict[str, str] = {}
    sids: Counter = Counter()
    versions: Counter = Counter()
    last_ts: Optional[str] = None
    prev_ctx: Optional[int] = None
    msg_groups: Dict[str, List[dict]] = {}
    req_groups: Counter = Counter()
    stem = os.path.basename(path)[:-6]
    parent_sid = rel.split("/")[1] if cat != "main" else stem
    rec_scope_prefix = "rec"
    line_no = 0
    bad_line_last = False
    with open(path, "rb") as fh:
        for raw in fh:
            line_no += 1
            ln = len(raw)
            if ln > frec["max_line"]:
                frec["max_line"] = ln
            s = raw.strip()
            if not s:
                continue
            try:
                rec = json.loads(s)
            except Exception:
                frec["bad"] += 1
                bad_line_last = True
                continue
            bad_line_last = False
            if not isinstance(rec, dict):
                frec["bad"] += 1
                st.types_by_cat[cat]["<non-dict>"] += 1
                continue
            frec["lines"] += 1
            rtype = rec.get("type")
            if not isinstance(rtype, str):
                rtype = "<no-type>"
            frec["types"][rtype] += 1
            st.types_by_cat[cat][rtype] += 1
            sc = st.scope(f"{rec_scope_prefix}:{rtype}")
            sc.records += 1
            # generic walk of the whole record, but keep the heavy sub-trees shallow;
            # they get their own dedicated scopes below.
            for k, v in rec.items():
                if k == "message" and isinstance(v, dict):
                    sc.observe(v, "message", 1, max_depth=2, leaf="message")
                    for mk, mv in v.items():
                        if mk == "content":
                            if isinstance(mv, list):
                                for b in mv:
                                    sc.observe(b, "message.content[]", 3, max_depth=4, leaf="content")
                                    if isinstance(b, dict):
                                        # small structured sub-objects of a block (not input/content);
                                        # the parent path was already counted by the block walk above
                                        for bk in ("caller", "from", "to", "source", "cache_control", "citations"):
                                            if bk in b:
                                                sc.observe_children(b[bk], f"message.content[].{bk}", 4, max_depth=6)
                        elif mk == "usage":
                            st.scope("usage").observe(mv, "", 0, leaf="usage")
                            st.scope("usage").records += 1
                        elif mk in ("diagnostics", "context_management", "stop_details", "container"):
                            sc.observe_children(mv, f"message.{mk}", 2, max_depth=6)
                elif k == "toolUseResult":
                    sc.observe(v, "toolUseResult", 1, max_depth=1, leaf="toolUseResult")
                elif k == "attachment" and isinstance(v, dict):
                    sc.observe(v, "attachment", 1, max_depth=2, leaf="attachment")
                    at = v.get("type")
                    at = at if isinstance(at, str) else "<no-type>"
                    a_sc = st.scope(f"att:{at}")
                    a_sc.records += 1
                    a_sc.observe(v, "", 0, leaf="attachment")
                elif k == "snapshot":
                    sc.observe(v, "snapshot", 1, max_depth=4, leaf="snapshot")
                elif k == "result":
                    # workflow journal / StructuredOutput payloads: user-defined schema
                    sc.observe(v, "result", 1, max_depth=1, leaf="result")
                elif k == "mcpMeta":
                    # MCP structured content: arbitrary server-defined payload, keys only
                    sc.observe(v, "mcpMeta", 1, max_depth=2, leaf="mcpMeta")
                else:
                    sc.observe(v, k, 1, leaf=k)
            if rtype == "system":
                sub = rec.get("subtype")
                sub = sub if isinstance(sub, str) else "<no-subtype>"
                s_sc = st.scope(f"sys:{sub}")
                s_sc.records += 1
                s_sc.observe(rec, "", 0, leaf="")
            # ---- ids / chain
            u = rec.get("uuid")
            p = rec.get("parentUuid")
            if isinstance(u, str):
                uuids.add(u)
                uuid_counts[u] += 1
            if "parentUuid" in rec:
                if p is None:
                    frec["roots"] += 1
                elif isinstance(p, str):
                    parents.append(p)
            sid = rec.get("sessionId")
            if isinstance(sid, str):
                sids[sid] += 1
            ver = rec.get("version")
            if isinstance(ver, str):
                versions[ver] += 1
            ts = rec.get("timestamp")
            if isinstance(ts, str):
                st.ts_format["iso-Z" if TS_RE.match(ts) else "other"] += 1
                if frec["first_ts"] is None:
                    frec["first_ts"] = ts
                frec["last_ts"] = ts
                if last_ts is not None and ts < last_ts:
                    frec["ts_nonmono"] += 1
                last_ts = ts
            elif ts is not None:
                st.ts_format[jtype(ts)] += 1
            if "isSidechain" in rec:
                st.sidechain_by_cat[cat][json.dumps(rec["isSidechain"])] += 1
            if "agentId" in rec:
                st.agentid_by_cat[cat]["present"] += 1
                aid = rec["agentId"]
                if cat in ("subagent", "wf_subagent") and isinstance(aid, str):
                    st.subagent_meta_match["stem==agent-<agentId>" if stem == "agent-" + aid else "stem!=agent-<agentId>"] += 1
            # compaction signals
            for ck in ("isCompactSummary", "compactMetadata", "isVisibleInTranscriptOnly"):
                if ck in rec:
                    st.compact_signals[f"{rtype}.{ck}"] += 1
                    frec["compact"] += 1
            if rtype == "system" and rec.get("subtype") == "compact_boundary":
                st.compact_signals["system.compact_boundary"] += 1
                frec["compact"] += 1
            # ---- message-level
            msg = rec.get("message")
            if rtype in ("user", "assistant") and isinstance(msg, dict):
                shape, blocks = _content_blocks(msg)
                st.scope("content-shape").observe(shape, f"{rtype}.content_shape", 0, leaf="type")
                if rtype == "assistant":
                    frec["assistant"] += 1
                    combo = "+".join(sorted({b.get("type", "?") for b in blocks if isinstance(b, dict)})) or shape
                    st.assistant_block_combo[combo] += 1
                    st.assistant_blocks_per_record[min(len(blocks), 20)] += 1
                    mid = msg.get("id")
                    if isinstance(mid, str):
                        msg_groups.setdefault(mid, []).append(rec)
                    rid = rec.get("requestId")
                    if isinstance(rid, str):
                        req_groups[rid] += 1
                    usage = msg.get("usage")
                    if isinstance(usage, dict):
                        ctx = 0
                        for uk in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                            x = usage.get(uk)
                            if isinstance(x, (int, float)):
                                ctx += int(x)
                        if ctx > frec["ctx_max"]:
                            frec["ctx_max"] = ctx
                        if prev_ctx is not None and prev_ctx > 20000 and ctx < prev_ctx * 0.5:
                            st.ctx_drop_events += 1
                        prev_ctx = ctx
                    for b in blocks:
                        if not isinstance(b, dict):
                            continue
                        if b.get("type") == "tool_use":
                            name = b.get("name")
                            name = name if isinstance(name, str) else "<no-name>"
                            tid = b.get("id")
                            if isinstance(tid, str):
                                tool_names[tid] = name
                            t = st.tool(name)
                            t["tool_use"] += 1
                            inp = b.get("input")
                            if isinstance(inp, dict):
                                for ik in inp:
                                    t["input_keys"][ik] += 1
                                isc = st.scope(f"input:{name}")
                                isc.records += 1
                                isc.observe(inp, "", 0, max_depth=INPUT_DEPTH, leaf="input")
                else:  # user
                    n_tr = 0
                    has_text = False
                    has_other = False
                    for b in blocks:
                        if not isinstance(b, dict):
                            continue
                        bt = b.get("type")
                        if bt == "tool_result":
                            n_tr += 1
                            tid = b.get("tool_use_id")
                            name = tool_names.get(tid) if isinstance(tid, str) else None
                            if name is None:
                                st.tool_result_orphans += 1
                                name = "<unknown>"
                            t = st.tool(name)
                            t["tool_result"] += 1
                            if b.get("is_error") is True:
                                t["is_error"] += 1
                            c = b.get("content")
                            shape2 = "absent" if "content" not in b else jtype(c)
                            t["result_shape"][shape2] += 1
                            st.tool_result_shape[shape2] += 1
                            if isinstance(c, list):
                                for cb in c:
                                    st.tool_result_block_types[cb.get("type", "?") if isinstance(cb, dict) else jtype(cb)] += 1
                            t["result_chars"] += _tool_result_chars(b)
                        elif bt == "text":
                            has_text = True
                        else:
                            has_other = True
                    if n_tr:
                        st.user_tool_results_per_record[min(n_tr, 20)] += 1
                        kind = "tool_result" if not (has_text or has_other) else "tool_result+other"
                    elif rec.get("isMeta") is True:
                        kind = "meta"
                    elif shape == "str":
                        kind = "prompt_str"
                        frec["prompts"] += 1
                    elif has_text and not has_other:
                        kind = "prompt_blocks"
                        frec["prompts"] += 1
                    elif has_text and has_other:
                        kind = "prompt_blocks+other"
                        frec["prompts"] += 1
                    else:
                        kind = "other:" + shape
                    st.user_kind[kind] += 1
                    if rec.get("isCompactSummary") is True:
                        st.user_kind["(isCompactSummary)"] += 1
                    # toolUseResult (top-level) belongs to the tool_result user record
                    if "toolUseResult" in rec:
                        tur = rec["toolUseResult"]
                        # attribute to the tool of the (first) tool_result block
                        name = "<none>"
                        for b in blocks:
                            if isinstance(b, dict) and b.get("type") == "tool_result":
                                tid = b.get("tool_use_id")
                                name = tool_names.get(tid, "<unknown>") if isinstance(tid, str) else "<unknown>"
                                break
                        st.tur_present_by_tool[name] += 1
                        st.tur_type_by_tool[name][jtype(tur)] += 1
                        st.tool(name)["tur"] += 1
                        tsc = st.scope(f"tur:{name}")
                        tsc.records += 1
                        depth_cap = 1 if name in ("StructuredOutput",) else TUR_DEPTH
                        tsc.observe(tur, "", 0, max_depth=depth_cap, leaf="toolUseResult")
    # ---- post-file
    frec["bad_last"] = bad_line_last
    frec["phys_lines"] = line_no
    st.cat_records[cat] += frec["lines"]
    st.cat_bad[cat] += frec["bad"]
    frec["orphans"] = sum(1 for p in parents if p not in uuids)
    frec["dup_uuids"] = sum(1 for c in uuid_counts.values() if c > 1)
    st.parent_chain["duplicate_uuids"] += frec["dup_uuids"]
    st.parent_chain["roots"] += frec["roots"]
    st.parent_chain["orphans"] += frec["orphans"]
    st.parent_chain["linked"] += len(parents) - frec["orphans"]
    frec["sids"] = len(sids)
    if sids:
        top = sids.most_common(1)[0][0]
        frec["sid_match"] = (top == parent_sid)
        st.sid_mismatch[f"{cat}:{'match' if top == parent_sid else 'mismatch'}"] += 1
        if len(sids) > 1:
            st.sid_mismatch[f"{cat}:multi-sid-in-file"] += 1
        if cat == "main":
            for s in sids:
                st.session_files[s].append(rel)
    else:
        st.sid_mismatch[f"{cat}:no-sessionId"] += 1
    frec["versions"] = sorted(versions)
    st.version_by_cat[cat].update(versions)
    if len(versions) > 1:
        st.multi_version_files += 1
    if frec["first_ts"]:
        if st.first_ts is None or frec["first_ts"] < st.first_ts:
            st.first_ts = frec["first_ts"]
        if st.last_ts is None or frec["last_ts"] > st.last_ts:
            st.last_ts = frec["last_ts"]
    # ctx bucket
    cm = frec["ctx_max"]
    b = "0" if cm == 0 else "<50k" if cm < 50_000 else "<100k" if cm < 100_000 else "<150k" if cm < 150_000 else "<200k" if cm < 200_000 else "<500k" if cm < 500_000 else ">=500k"
    st.ctx_max_hist[b] += 1
    # streaming groups
    for mid, grp in msg_groups.items():
        n = len(grp)
        st.msgid_group_sizes[min(n, 12)] += 1
        if n > 1:
            frec["msgid_dups"] += 1
            usages = [json.dumps(g["message"].get("usage"), sort_keys=True) for g in grp]
            if all(x == usages[0] for x in usages):
                st.msgid_usage_identical["identical"] += 1
            else:
                st.msgid_usage_identical["different"] += 1
                base = grp[0]["message"].get("usage") or {}
                for g in grp[1:]:
                    u2 = g["message"].get("usage") or {}
                    for k in set(base) | set(u2):
                        if base.get(k) != u2.get(k):
                            st.msgid_usage_diff_fields[k] += 1
            ok = all(grp[i].get("parentUuid") == grp[i - 1].get("uuid") for i in range(1, n))
            st.msgid_chain_ok["chained" if ok else "not-chained"] += 1
            finals = [i for i, g in enumerate(grp) if g["message"].get("stop_reason") is not None]
            if not finals:
                st.msgid_final_pos["no-stop_reason"] += 1
            elif finals == [n - 1]:
                st.msgid_final_pos["only-last-has-stop_reason"] += 1
            elif len(finals) == n:
                st.msgid_final_pos["all-have-stop_reason"] += 1
            else:
                st.msgid_final_pos["mixed"] += 1
            outs = [g["message"].get("usage", {}).get("output_tokens") or 0 for g in grp]
            st.msgid_final_pos["max-output_tokens-is-last" if outs.index(max(outs)) == n - 1 or outs.count(max(outs)) == n else "max-output_tokens-not-last"] += 1
            combos = []
            for g in grp:
                _, bl = _content_blocks(g["message"])
                combos.append("+".join(sorted({b.get("type", "?") for b in bl if isinstance(b, dict)})))
            st.msgid_group_block_combo[" | ".join(combos)[:120]] += 1
    for rid, n in req_groups.items():
        st.reqid_group_sizes[min(n, 12)] += 1
    if keep_per_file:
        frec["types"] = dict(frec["types"])
        st.files.append(frec)
    else:
        st.files.append({"path": rel, "cat": cat, "bytes": size, "lines": frec["lines"],
                         "bad": frec["bad"], "max_line": frec["max_line"],
                         "ts_nonmono": frec["ts_nonmono"], "roots": frec["roots"],
                         "orphans": frec["orphans"], "sids": frec["sids"],
                         "assistant": frec["assistant"], "prompts": frec["prompts"],
                         "ctx_max": frec["ctx_max"], "compact": frec["compact"],
                         "msgid_dups": frec["msgid_dups"], "bad_last": frec["bad_last"],
                         "dup_uuids": frec["dup_uuids"], "phys_lines": frec["phys_lines"],
                         "first_ts": frec["first_ts"], "last_ts": frec["last_ts"],
                         "versions": frec["versions"], "sid_match": frec["sid_match"]})


def worker(args: Tuple[str, List[Tuple[str, str, str]], bool, bool]) -> FileStats:
    root, items, keep_per_file, discover = args
    st = FileStats(discover)
    for path, rel, cat in items:
        try:
            survey_jsonl(path, rel, cat, st, keep_per_file)
        except Exception as ex:  # keep going, but record it
            st.files.append({"path": rel, "cat": cat, "error": f"{type(ex).__name__}: {ex}"[:200]})
            st.cat["<error>"] += 1
    return st


# ----------------------------------------------------------------------------
# non-jsonl sidecars + layout
# ----------------------------------------------------------------------------

def _load_json(path: str) -> Any:
    with open(path, "rb") as fh:
        return json.loads(fh.read())


def survey_layout(projects_dir: str, discover: bool) -> Tuple[dict, List[Tuple[str, str, str]]]:
    """Walk <root>/projects; return (layout report, list of jsonl files to survey)."""
    layout: dict = {"projects": 0, "project_entries": Counter(), "sessions_main": 0,
                    "sessions_with_dir": 0, "dirs_without_main": 0, "session_subdirs": Counter(),
                    "session_dir_files": Counter(), "subagent_name_patterns": Counter(),
                    "meta_pairing": Counter(), "tool_results_names": Counter(),
                    "tool_results_ext": Counter(), "tool_results_bytes": [0, 0, 0],
                    "tool_results_txt_shape": Counter(), "workflows_files": Counter(),
                    "wf_subagent_dirs": 0, "wf_subagent_files": Counter(),
                    "other_files": Counter(), "subagent_count_hist": Counter()}
    scopes: Dict[str, Schema] = {}

    def sc(name: str) -> Schema:
        s = scopes.get(name)
        if s is None:
            s = scopes[name] = Schema(discover)
        return s

    jsonl_items: List[Tuple[str, str, str]] = []
    for slug in sorted(os.listdir(projects_dir)):
        pdir = os.path.join(projects_dir, slug)
        if not os.path.isdir(pdir):
            layout["project_entries"]["<file>"] += 1
            continue
        layout["projects"] += 1
        entries = os.listdir(pdir)
        mains = set()
        dirs = set()
        for e in entries:
            full = os.path.join(pdir, e)
            if e.endswith(".jsonl") and UUID_RE.match(e[:-6]):
                mains.add(e[:-6])
                layout["project_entries"]["<uuid>.jsonl"] += 1
                jsonl_items.append((full, f"{slug}/{e}", "main"))
            elif os.path.isdir(full) and UUID_RE.match(e):
                dirs.add(e)
                layout["project_entries"]["<uuid>/"] += 1
            elif os.path.isdir(full):
                layout["project_entries"][f"{e}/"] += 1
            else:
                layout["project_entries"][e if not e.endswith(".jsonl") else "<other>.jsonl"] += 1
                if e.endswith(".jsonl"):
                    jsonl_items.append((full, f"{slug}/{e}", "other"))
        layout["sessions_main"] += len(mains)
        layout["sessions_with_dir"] += len(mains & dirs)
        layout["dirs_without_main"] += len(dirs - mains)
        for sid in sorted(dirs):
            sdir = os.path.join(pdir, sid)
            for sub in os.listdir(sdir):
                subp = os.path.join(sdir, sub)
                if os.path.isdir(subp):
                    layout["session_subdirs"][sub] += 1
                else:
                    layout["session_dir_files"][os.path.splitext(sub)[1] or sub] += 1
            # subagents
            sa = os.path.join(sdir, "subagents")
            if os.path.isdir(sa):
                n_agents = 0
                stems = set()
                for f in os.listdir(sa):
                    fp = os.path.join(sa, f)
                    if os.path.isdir(fp):
                        if f == "workflows":
                            for wf in os.listdir(fp):
                                wfd = os.path.join(fp, wf)
                                if not os.path.isdir(wfd):
                                    layout["wf_subagent_files"]["<file>:" + os.path.splitext(wf)[1]] += 1
                                    continue
                                layout["wf_subagent_dirs"] += 1
                                for g in os.listdir(wfd):
                                    gp = os.path.join(wfd, g)
                                    rel = f"{slug}/{sid}/subagents/workflows/{wf}/{g}"
                                    if g == "journal.jsonl":
                                        layout["wf_subagent_files"]["journal.jsonl"] += 1
                                        jsonl_items.append((gp, rel, "wf_journal"))
                                    elif g.endswith(".meta.json"):
                                        layout["wf_subagent_files"]["agent-*.meta.json"] += 1
                                        try:
                                            m = _load_json(gp)
                                            s = sc("wf_meta.json"); s.records += 1; s.observe(m, "", 0)
                                        except Exception:
                                            layout["wf_subagent_files"]["<bad meta.json>"] += 1
                                    elif g.endswith(".jsonl"):
                                        layout["wf_subagent_files"]["agent-*.jsonl"] += 1
                                        jsonl_items.append((gp, rel, "wf_subagent"))
                                    else:
                                        layout["wf_subagent_files"]["<other>:" + g[-12:]] += 1
                        else:
                            layout["session_subdirs"]["subagents/" + f + "/"] += 1
                        continue
                    if f.endswith(".meta.json"):
                        stem = f[:-10]
                        stems.add(("meta", stem))
                        try:
                            m = _load_json(fp)
                            s = sc("meta.json"); s.records += 1; s.observe(m, "", 0)
                        except Exception:
                            layout["meta_pairing"]["<bad meta.json>"] += 1
                    elif f.endswith(".jsonl"):
                        stem = f[:-6]
                        stems.add(("jsonl", stem))
                        n_agents += 1
                        pat = re.sub(r"[0-9a-f]{16}$", "<hash16>", stem)
                        pat = re.sub(r"^agent-(.+)-<hash16>$", "agent-<name>-<hash16>", pat)
                        pat = re.sub(r"^agent-a<hash16>$", "agent-a<hash16>", pat)
                        if pat not in ("agent-<name>-<hash16>", "agent-a<hash16>"):
                            pat = "other:" + re.sub(r"[0-9a-f]{8,}", "<hex>", stem)[:40]
                        layout["subagent_name_patterns"][pat] += 1
                        jsonl_items.append((fp, f"{slug}/{sid}/subagents/{f}", "subagent"))
                    else:
                        layout["session_subdirs"]["subagents/<other file>" + os.path.splitext(f)[1]] += 1
                js = {s for k, s in stems if k == "jsonl"}
                ms = {s for k, s in stems if k == "meta"}
                layout["meta_pairing"]["jsonl+meta"] += len(js & ms)
                layout["meta_pairing"]["jsonl-only"] += len(js - ms)
                layout["meta_pairing"]["meta-only"] += len(ms - js)
                layout["subagent_count_hist"][str(min(n_agents, 30)) if n_agents < 30 else "30+"] += 1
            # tool-results
            tr = os.path.join(sdir, "tool-results")
            if os.path.isdir(tr):
                for f in os.listdir(tr):
                    fp = os.path.join(tr, f)
                    if os.path.isdir(fp):
                        pat = re.sub(r"[0-9a-f-]{36}", "<uuid>", f)
                        layout["tool_results_names"]["dir:" + pat] += 1
                        for g in os.listdir(fp):
                            layout["tool_results_ext"]["(dir)" + os.path.splitext(g)[1]] += 1
                        continue
                    ext = os.path.splitext(f)[1]
                    layout["tool_results_ext"][ext] += 1
                    stem = os.path.splitext(f)[0]
                    if stem.startswith("toolu_"):
                        pat = "toolu_<id>" + ext
                    elif re.fullmatch(r"[a-z0-9]{9}", stem):
                        pat = "<9-char-id>" + ext
                    else:
                        pat = "other:" + re.sub(r"[0-9a-f]{8,}", "<hex>", stem)[:30] + ext
                    layout["tool_results_names"][pat] += 1
                    sz = os.path.getsize(fp)
                    b = layout["tool_results_bytes"]
                    b[0] += 1; b[1] += sz; b[2] = max(b[2], sz)
                    if ext == ".txt":
                        with open(fp, "rb") as fh:
                            head = fh.read(2)
                        layout["tool_results_txt_shape"]["json-like" if head[:1] in (b"{", b"[") else "text"] += 1
            # workflows
            wf = os.path.join(sdir, "workflows")
            if os.path.isdir(wf):
                for f in os.listdir(wf):
                    fp = os.path.join(wf, f)
                    if os.path.isdir(fp):
                        for g in os.listdir(fp):
                            layout["workflows_files"][f + "/*" + os.path.splitext(g)[1]] += 1
                        continue
                    ext = os.path.splitext(f)[1]
                    layout["workflows_files"][("wf_<id>" if f.startswith("wf_") else "<other>") + ext] += 1
                    if ext == ".json":
                        try:
                            m = _load_json(fp)
                            s = sc("workflow.json"); s.records += 1
                            if isinstance(m, dict) and "result" in m:
                                # workflow result payloads are user-defined: record shape only
                                shallow = dict(m); res = shallow.pop("result")
                                s.observe(shallow, "", 0, max_depth=6)
                                s.observe(res, "result", 1, max_depth=1, leaf="result")
                            else:
                                s.observe(m, "", 0, max_depth=6)
                        except Exception:
                            layout["workflows_files"]["<bad json>"] += 1
            # any other subdir: record file extension mix only
            for sub in os.listdir(sdir):
                if sub in ("subagents", "tool-results", "workflows"):
                    continue
                subp = os.path.join(sdir, sub)
                if os.path.isdir(subp):
                    for dp, _, fs in os.walk(subp):
                        for g in fs:
                            layout["other_files"][sub + "/**" + os.path.splitext(g)[1]] += 1
    layout["tool_results_bytes"] = {"files": layout["tool_results_bytes"][0],
                                    "total": layout["tool_results_bytes"][1],
                                    "max": layout["tool_results_bytes"][2]}
    for k, v in list(layout.items()):
        if isinstance(v, Counter):
            layout[k] = dict(v.most_common())
    layout["scopes"] = {k: v.export() for k, v in scopes.items()}
    return layout, jsonl_items


def survey_sidebar(root: str, discover: bool) -> dict:
    """~/.claude side files that describe sessions (keys only)."""
    out: dict = {}
    scopes: Dict[str, Schema] = {}

    def sc(name: str) -> Schema:
        s = scopes.get(name)
        if s is None:
            s = scopes[name] = Schema(discover)
        return s

    # history.jsonl
    hp = os.path.join(root, "history.jsonl")
    if os.path.exists(hp):
        n = bad = 0
        s = sc("history.jsonl")
        with open(hp, "rb") as fh:
            for raw in fh:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    o = json.loads(raw)
                except Exception:
                    bad += 1
                    continue
                n += 1
                s.records += 1
                s.observe(o, "", 0, max_depth=3)
        out["history.jsonl"] = {"records": n, "bad": bad, "bytes": os.path.getsize(hp)}
    # stats-cache.json
    sp = os.path.join(root, "stats-cache.json")
    if os.path.exists(sp):
        try:
            o = _load_json(sp)
            s = sc("stats-cache.json"); s.records = 1; s.observe(o, "", 0, max_depth=4)
            out["stats-cache.json"] = {"bytes": os.path.getsize(sp)}
        except Exception as ex:
            out["stats-cache.json"] = {"error": type(ex).__name__}
    # sessions/*.json
    sd = os.path.join(root, "sessions")
    if os.path.isdir(sd):
        pats = Counter()
        for f in os.listdir(sd):
            pats[re.sub(r"[0-9a-f]{20,}", "<hash>", re.sub(r"^\d+", "<pid>", f))] += 1
            if f.endswith(".json"):
                try:
                    o = _load_json(os.path.join(sd, f))
                    s = sc("sessions/<pid>.json"); s.records += 1; s.observe(o, "", 0, max_depth=3)
                except Exception:
                    pats["<bad json>"] += 1
        out["sessions/"] = dict(pats)
    # tasks/<session-*>/
    td = os.path.join(root, "tasks")
    if os.path.isdir(td):
        pats = Counter()
        n_dirs = 0
        for d in os.listdir(td):
            dp = os.path.join(td, d)
            if not os.path.isdir(dp):
                pats["<file>" + d] += 1
                continue
            n_dirs += 1
            for f in os.listdir(dp):
                pats[re.sub(r"\d+", "N", f)] += 1
                if f.endswith(".json"):
                    try:
                        o = _load_json(os.path.join(dp, f))
                        s = sc("tasks/<session>/<N>.json"); s.records += 1; s.observe(o, "", 0, max_depth=4)
                    except Exception:
                        pats["<bad json>"] += 1
        out["tasks/"] = {"session_dirs": n_dirs, "files": dict(pats)}
    # teams/
    tm = os.path.join(root, "teams")
    if os.path.isdir(tm):
        pats = Counter()
        for d in os.listdir(tm):
            dp = os.path.join(tm, d)
            if not os.path.isdir(dp):
                continue
            for dp2, _, fs in os.walk(dp):
                for f in fs:
                    relp = os.path.relpath(os.path.join(dp2, f), dp)
                    pat = re.sub(r"inboxes/.+\.json", "inboxes/<name>.json", relp)
                    pats[pat] += 1
                    if f.endswith(".json"):
                        try:
                            o = _load_json(os.path.join(dp2, f))
                            name = "teams/<session>/config.json" if f == "config.json" else "teams/<session>/inboxes/<name>.json"
                            s = sc(name); s.records += 1; s.observe(o, "", 0, max_depth=4)
                        except Exception:
                            pats["<bad json>"] += 1
        out["teams/"] = {"dirs": len([d for d in os.listdir(tm) if os.path.isdir(os.path.join(tm, d))]), "files": dict(pats)}
    # session-env/
    se = os.path.join(root, "session-env")
    if os.path.isdir(se):
        dirs = [d for d in os.listdir(se) if os.path.isdir(os.path.join(se, d))]
        nfiles = sum(len(fs) for _, _, fs in os.walk(se))
        out["session-env/"] = {"dirs": len(dirs), "uuid_named": sum(1 for d in dirs if UUID_RE.match(d)), "files": nfiles}
    # file-history/
    fh = os.path.join(root, "file-history")
    if os.path.isdir(fh):
        dirs = [d for d in os.listdir(fh) if os.path.isdir(os.path.join(fh, d))]
        pats = Counter()
        total = 0
        for d in dirs:
            for f in os.listdir(os.path.join(fh, d)):
                pats[re.sub(r"^[0-9a-f]+@v\d+$", "<hash>@v<N>", f)] += 1
                total += os.path.getsize(os.path.join(fh, d, f))
        out["file-history/"] = {"session_dirs": len(dirs), "uuid_named": sum(1 for d in dirs if UUID_RE.match(d)),
                                "files": dict(pats), "bytes": total}
    # plugins/installed_plugins.json
    ip = os.path.join(root, "plugins", "installed_plugins.json")
    if os.path.exists(ip):
        try:
            o = _load_json(ip)
            s = sc("plugins/installed_plugins.json"); s.records = 1; s.observe(o, "", 0, max_depth=4)
        except Exception as ex:
            out["plugins/installed_plugins.json"] = {"error": type(ex).__name__}
    # settings.json (keys only; a few safe scalar values)
    for name in ("settings.json", "settings.local.json"):
        stp = os.path.join(root, name)
        if os.path.exists(stp):
            try:
                o = _load_json(stp)
                rep: dict = {"top_level_keys": sorted(o.keys()) if isinstance(o, dict) else jtype(o)}
                if isinstance(o, dict):
                    safe = {}
                    for k, v in o.items():
                        if isinstance(v, (bool, int, float)) or (isinstance(v, str) and k in ("model", "theme", "effortLevel", "language")):
                            safe[k] = v if not isinstance(v, str) else v[:40]
                        elif isinstance(v, dict) and k != "env":
                            safe[k] = {"<keys>": sorted(v.keys())[:40]}
                        elif isinstance(v, dict):
                            safe[k] = {"<n keys>": len(v)}
                        elif isinstance(v, list):
                            safe[k] = {"<list len>": len(v)}
                    rep["safe_view"] = safe
                out[name] = rep
            except Exception as ex:
                out[name] = {"error": type(ex).__name__}
    out["scopes"] = {k: v.export() for k, v in scopes.items()}
    return out


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------

def percentiles(xs: List[float], ps=(0, 10, 25, 50, 75, 90, 95, 99, 100)) -> dict:
    if not xs:
        return {}
    xs = sorted(xs)
    n = len(xs)
    return {f"p{p}": xs[min(n - 1, int(round(p / 100 * (n - 1))))] for p in ps}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", default=os.path.expanduser("~/.claude"))
    ap.add_argument("--out", default="schema-survey.json")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    ap.add_argument("--limit", type=int, default=0, help="only survey the first N jsonl files (debug)")
    ap.add_argument("--per-file", action="store_true",
                    help="include the per-file rows (path, size, lines, roots, ...) in the output; off by default "
                         "because they list every session id and project slug on the machine")
    ap.add_argument("--discover", action="store_true", help="print candidate enum paths to stderr")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    t0 = time.time()
    root = os.path.abspath(os.path.expanduser(args.root))
    projects_dir = os.path.join(root, "projects")
    if not os.path.isdir(projects_dir):
        print(f"no projects dir at {projects_dir}", file=sys.stderr)
        return 2

    layout, items = survey_layout(projects_dir, args.discover)
    if args.limit:
        items = items[: args.limit]
    # largest files first for better load balance
    items.sort(key=lambda it: -os.path.getsize(it[0]))
    n_workers = max(1, min(args.workers, len(items)))
    batches: List[List[Tuple[str, str, str]]] = [[] for _ in range(n_workers)]
    for i, it in enumerate(items):
        batches[i % n_workers].append(it)
    if not args.quiet:
        print(f"[survey] {len(items)} jsonl files, {n_workers} workers", file=sys.stderr)

    total = FileStats(args.discover)
    if n_workers == 1:
        total.merge(worker((root, batches[0], args.per_file, args.discover)))
    else:
        with ProcessPoolExecutor(max_workers=n_workers) as ex:
            for st in ex.map(worker, [(root, b, args.per_file, args.discover) for b in batches]):
                total.merge(st)
    sidebar = survey_sidebar(root, args.discover)

    # ---- assemble report
    files = total.files
    ok_files = [f for f in files if "error" not in f]
    by_cat: Dict[str, List[dict]] = defaultdict(list)
    for f in ok_files:
        by_cat[f["cat"]].append(f)
    cat_report = {}
    for cat, fl in by_cat.items():
        cat_report[cat] = {
            "files": len(fl),
            "bytes": sum(f["bytes"] for f in fl),
            "records": sum(f["lines"] for f in fl),
            "bad_lines": sum(f["bad"] for f in fl),
            "files_with_bad_lines": sum(1 for f in fl if f["bad"]),
            "files_bad_last_line": sum(1 for f in fl if f.get("bad_last")),
            "files_zero_records": sum(1 for f in fl if f["lines"] == 0),
            "size_bytes_pct": percentiles([f["bytes"] for f in fl]),
            "lines_pct": percentiles([f["lines"] for f in fl]),
            "max_line_bytes_pct": percentiles([f["max_line"] for f in fl]),
            "max_line_bytes_max": max((f["max_line"] for f in fl), default=0),
            "files_ts_nonmonotonic": sum(1 for f in fl if f["ts_nonmono"]),
            "ts_nonmonotonic_steps": sum(f["ts_nonmono"] for f in fl),
            "roots_pct": percentiles([f["roots"] for f in fl]),
            "files_with_orphans": sum(1 for f in fl if f["orphans"]),
            "orphan_parent_refs": sum(f["orphans"] for f in fl),
            "files_multi_sessionId": sum(1 for f in fl if f["sids"] > 1),
            "files_sid_mismatch": sum(1 for f in fl if f["sid_match"] is False),
            "files_no_sessionId": sum(1 for f in fl if f["sids"] == 0),
            "prompts_pct": percentiles([f["prompts"] for f in fl]),
            "assistant_records_pct": percentiles([f["assistant"] for f in fl]),
            "ctx_max_pct": percentiles([f["ctx_max"] for f in fl]),
            "files_with_compaction_signal": sum(1 for f in fl if f["compact"]),
            "files_with_msgid_dups": sum(1 for f in fl if f["msgid_dups"]),
            "files_multi_version": sum(1 for f in fl if len(f["versions"]) > 1),
            "files_with_duplicate_uuids": sum(1 for f in fl if f.get("dup_uuids")),
            "record_types": dict(total.types_by_cat[cat].most_common()),
        }
    multi = {sid: fl for sid, fl in total.session_files.items() if len(fl) > 1}
    versions_all = Counter()
    for c in total.version_by_cat.values():
        versions_all.update(c)

    def vkey(v: str):
        return tuple(int(x) if x.isdigit() else x for x in re.split(r"[.-]", v))

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "root": root.replace(os.path.expanduser("~"), "~", 1),
        "elapsed_s": round(time.time() - t0, 1),
        "totals": {
            "jsonl_files": len(ok_files),
            "files_errored": len(files) - len(ok_files),
            "bytes": sum(f["bytes"] for f in ok_files),
            "records": sum(f["lines"] for f in ok_files),
            "bad_lines": sum(f["bad"] for f in ok_files),
            "first_timestamp": total.first_ts,
            "last_timestamp": total.last_ts,
            "record_types_all": dict(sum((c for c in total.types_by_cat.values()), Counter()).most_common()),
        },
        "categories": cat_report,
        "versions": {"distinct": len(versions_all),
                     "min": min(versions_all, key=vkey) if versions_all else None,
                     "max": max(versions_all, key=vkey) if versions_all else None,
                     "counts": dict(sorted(versions_all.items(), key=lambda kv: vkey(kv[0]))),
                     "files_with_multiple_versions": total.multi_version_files},
        "sessions": {
            "sessionIds_in_multiple_main_files": len(multi),
            "examples_count_hist": dict(Counter(len(v) for v in multi.values())),
            "sid_vs_location": dict(total.sid_mismatch),
        },
        "timestamps": {"format": dict(total.ts_format)},
        "parent_chain": dict(total.parent_chain),
        "sidechain_by_category": {k: dict(v) for k, v in total.sidechain_by_cat.items()},
        "subagent_file_naming": dict(total.subagent_meta_match),
        "agentId_by_category": {k: dict(v) for k, v in total.agentid_by_cat.items()},
        "content": {
            "assistant_block_combos": dict(total.assistant_block_combo.most_common()),
            "assistant_blocks_per_record": dict(sorted(total.assistant_blocks_per_record.items())),
            "user_record_kinds": dict(total.user_kind.most_common()),
            "user_tool_results_per_record": dict(sorted(total.user_tool_results_per_record.items())),
            "tool_result_content_shape": dict(total.tool_result_shape),
            "tool_result_block_types": dict(total.tool_result_block_types),
            "tool_result_unmatched_tool_use_id": total.tool_result_orphans,
        },
        "streaming": {
            "assistant_records_per_message_id": dict(sorted(total.msgid_group_sizes.items())),
            "usage_within_group": dict(total.msgid_usage_identical),
            "usage_fields_that_differ_within_group": dict(total.msgid_usage_diff_fields.most_common()),
            "parent_chain_within_group": dict(total.msgid_chain_ok),
            "final_usage_position_within_group": dict(total.msgid_final_pos),
            "block_combos_within_group": dict(total.msgid_group_block_combo.most_common(25)),
            "assistant_records_per_requestId": dict(sorted(total.reqid_group_sizes.items())),
        },
        "context": {"ctx_max_per_file_hist": dict(total.ctx_max_hist),
                    "ctx_drop_events_gt50pct": total.ctx_drop_events,
                    "compaction_signals": dict(total.compact_signals)},
        "tools": {},
        "toolUseResult_by_tool": {k: dict(v) for k, v in total.tur_type_by_tool.items()},
        "scopes": {k: v.export() for k, v in sorted(total.scopes.items())},
        "layout": layout,
        "sidebar": sidebar,
    }
    for name, t in sorted(total.tools.items(), key=lambda kv: -kv[1]["tool_use"]):
        report["tools"][name] = {
            "tool_use": t["tool_use"], "tool_result": t["tool_result"], "is_error": t["is_error"],
            "toolUseResult_records": t["tur"], "result_chars_total": t["result_chars"],
            "result_shape": dict(t["result_shape"]),
            "input_keys": dict(t["input_keys"].most_common()),
        }
    if args.per_file:
        report["files"] = files
    else:
        report["files"] = f"omitted ({len(files)} files; re-run with --per-file)"
    with open(args.out, "w") as fh:
        json.dump(report, fh, indent=1, sort_keys=False, default=str)
    if not args.quiet:
        print(f"[survey] wrote {args.out} in {report['elapsed_s']}s "
              f"({report['totals']['records']} records, {report['totals']['bad_lines']} bad lines)",
              file=sys.stderr)
    if args.discover:
        print("\n[discover] candidate enumeration paths (not in whitelist, <=%d distinct values):" % MAX_DISCOVER_VALUES, file=sys.stderr)
        for scope, s in sorted(total.scopes.items()):
            if s.discover is None:
                continue
            for p, vals in sorted(s.discover.items()):
                if vals is None or not vals:
                    continue
                shown = sorted(v for v in vals if TOKENISH_RE.match(v))
                hidden = len(vals) - len(shown)
                print(f"  {scope} :: {p} :: {len(vals)} distinct :: {shown[:12]}{' +hidden=%d' % hidden if hidden else ''}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
