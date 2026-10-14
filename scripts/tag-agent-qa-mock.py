"""Loopback-only synthetic Agent and tag-index service for Windows QA."""

from __future__ import annotations

import argparse
import http.server
import ipaddress
import json
import os
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent.parent
PORT = 5119
MAX_CHAT_BODY = 2 * 1024 * 1024
MAX_SEARCH_BODY = 64 * 1024
FIXTURE_TAGS = [
    {
        "tag": "silver_hair",
        "cn_name": "银发",
        "category": "general",
        "nsfw": "safe",
        "count": 1200,
        "final_score": 0.95,
        "wiki": "合成测试说明",
    },
    {
        "tag": "moonlight",
        "cn_name": "月光",
        "category": "general",
        "nsfw": "safe",
        "count": 980,
        "final_score": 0.92,
        "wiki": "合成月光标签说明",
    },
    {
        "tag": "forest",
        "cn_name": "森林",
        "category": "general",
        "nsfw": "safe",
        "count": 760,
        "final_score": 0.90,
        "wiki": "合成森林标签说明",
    },
]
EXPECTED_SEARCH_SOURCE = f"http://127.0.0.1:{PORT}"
EXPECTED_PROMPT_APPEND = "silver hair, moonlight, forest"


class QAError(Exception):
    """A safe, user-facing protocol or local-path validation failure."""


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _temp_root(*, create: bool = False) -> Path:
    root = ROOT.resolve()
    lexical = root / ".tmp"
    try:
        resolved = lexical.resolve(strict=False)
    except (OSError, RuntimeError) as error:
        raise QAError("Cannot resolve the repository .tmp directory.") from error
    # Refuse a symlink/junction at the boundary itself as well as links below it.
    if os.path.normcase(str(resolved)) != os.path.normcase(str(lexical)):
        raise QAError("Repository .tmp must not redirect outside its own path.")
    if create:
        lexical.mkdir(parents=True, exist_ok=True)
        resolved = lexical.resolve(strict=True)
    if not resolved.is_dir() or not _is_within(resolved, root):
        raise QAError("Repository .tmp is missing or resolves outside the PC workspace.")
    return resolved


def _confined_path(raw: str | Path, label: str, *, must_exist: bool = False) -> Path:
    allowed = _temp_root(create=False)
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    try:
        resolved = candidate.resolve(strict=False)
    except (OSError, RuntimeError) as error:
        raise QAError(f"Cannot resolve {label} path.") from error
    if not _is_within(resolved, allowed):
        raise QAError(f"{label} must resolve inside PC/.tmp.")
    if must_exist and not resolved.exists():
        raise QAError(f"{label} does not exist.")
    return resolved


def _strict_json_loads(text: str):
    def reject_constant(value: str):
        raise ValueError(f"Invalid JSON constant: {value}")

    return json.loads(text, parse_constant=reject_constant)


def _json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def prepare_fixture(fixture_arg: str, data_arg: str) -> Path:
    _temp_root(create=True)
    fixture_path = _confined_path(fixture_arg, "Fixture", must_exist=True)
    data_dir = _confined_path(data_arg, "Data directory")
    if not fixture_path.is_file():
        raise QAError("Fixture must be a regular JSON file.")
    if fixture_path.stat().st_size > MAX_CHAT_BODY:
        raise QAError("Fixture exceeds the 2 MiB synthetic-fixture limit.")
    try:
        fixture = _strict_json_loads(fixture_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        raise QAError("Fixture is not valid UTF-8 JSON.") from error
    if not isinstance(fixture, dict):
        raise QAError("Fixture root must be a JSON object from c.exportWorkspace().")

    draft = fixture.get("draft")
    gallery = fixture.get("gallery")
    if not isinstance(draft, dict) or not isinstance(gallery, list):
        raise QAError("Fixture must contain an object draft and array gallery.")
    for field in ("preferences", "editor"):
        if not isinstance(fixture.get(field), dict):
            raise QAError(f"Fixture field {field} must be a JSON object.")
    if not isinstance(fixture.get("selectedId"), str):
        raise QAError("Fixture selectedId must be a string.")
    if isinstance(fixture.get("demoSequence"), bool) or not isinstance(
        fixture.get("demoSequence"), int
    ):
        raise QAError("Fixture demoSequence must be an integer.")

    seen_ids: set[str] = set()
    for index, item in enumerate(gallery):
        if not isinstance(item, dict):
            raise QAError(f"Fixture gallery item {index} must be an object.")
        image_id = item.get("id")
        if not isinstance(image_id, str) or not image_id.strip():
            raise QAError(f"Fixture gallery item {index} needs a non-empty string id.")
        if image_id in seen_ids:
            raise QAError("Fixture gallery contains duplicate ids.")
        seen_ids.add(image_id)

    try:
        json.dumps(
            fixture, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        )
    except (TypeError, ValueError) as error:
        raise QAError("Fixture contains values that are not JSON-safe.") from error

    data_dir.mkdir(parents=True, exist_ok=True)
    data_dir = _confined_path(data_dir, "Data directory")
    if not data_dir.is_dir():
        raise QAError("Data directory must be a directory.")
    database_path = _confined_path(data_dir / "workspace.sqlite", "Workspace database")
    if database_path.exists() or database_path.is_symlink():
        raise QAError("Refusing to overwrite an existing QA database.")

    # Reserve the database name exclusively before SQLite opens it. This also
    # refuses a raced-in symlink or a concurrent second prepare operation.
    try:
        descriptor = os.open(
            database_path,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            0o600,
        )
        os.close(descriptor)
    except FileExistsError as error:
        raise QAError("Refusing to overwrite an existing QA database.") from error

    fixture.pop("draft")
    fixture.pop("gallery")
    try:
        with sqlite3.connect(database_path) as database:
            database.executescript(
                """
                CREATE TABLE meta (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  revision INTEGER NOT NULL CHECK (revision > 0)
                );
                CREATE TABLE draft (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  payload TEXT NOT NULL
                );
                CREATE TABLE gallery (
                  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
                  ordinal INTEGER NOT NULL UNIQUE,
                  payload TEXT NOT NULL
                );
                CREATE TABLE workspace (
                  id INTEGER PRIMARY KEY CHECK (id = 1),
                  extra_json TEXT NOT NULL
                );
                PRAGMA user_version = 1;
                INSERT INTO meta (id, revision) VALUES (1, 1);
                """
            )
            database.execute(
                "INSERT INTO draft (id, payload) VALUES (1, ?)",
                (json.dumps(draft, ensure_ascii=False, allow_nan=False),),
            )
            database.execute(
                "INSERT INTO workspace (id, extra_json) VALUES (1, ?)",
                (json.dumps(fixture, ensure_ascii=False, allow_nan=False),),
            )
            database.executemany(
                "INSERT INTO gallery (id, ordinal, payload) VALUES (?, ?, ?)",
                [
                    (item["id"], ordinal, json.dumps(item, ensure_ascii=False, allow_nan=False))
                    for ordinal, item in enumerate(gallery)
                ],
            )
    except (OSError, sqlite3.Error, ValueError) as error:
        raise QAError("Could not create the synthetic SQLite workspace fixture.") from error
    print(database_path)
    return database_path


def _object_schema(tool: dict, name: str) -> tuple[dict, dict]:
    if tool.get("type") != "function" or not isinstance(tool.get("function"), dict):
        raise QAError("Advertised tool schema is malformed.")
    function = tool["function"]
    if function.get("name") != name:
        raise QAError("Advertised tool name did not match the expected step.")
    parameters = function.get("parameters")
    if not isinstance(parameters, dict) or parameters.get("type") != "object":
        raise QAError(f"Tool {name} did not advertise an object parameter schema.")
    properties = parameters.get("properties")
    required = parameters.get("required", [])
    if not isinstance(properties, dict) or not isinstance(required, list):
        raise QAError(f"Tool {name} advertised an invalid parameter schema.")
    return parameters, properties


def _require_property(properties: dict, name: str, expected_type: str) -> dict:
    prop = properties.get(name)
    if not isinstance(prop, dict) or prop.get("type") != expected_type:
        raise QAError(f"Tool schema does not declare {name} as {expected_type}.")
    return prop


def _validate_schema_arguments(value: object, schema: dict, path: str = "arguments") -> None:
    expected_type = schema.get("type")
    if expected_type == "object":
        if not isinstance(value, dict):
            raise QAError(f"{path} must be an object.")
        properties = schema.get("properties", {})
        required = schema.get("required", [])
        if not isinstance(properties, dict) or not isinstance(required, list):
            raise QAError(f"{path} schema is malformed.")
        missing = [key for key in required if key not in value]
        if missing:
            raise QAError(f"{path} is missing a required property.")
        if schema.get("additionalProperties") is False:
            if any(key not in properties for key in value):
                raise QAError(f"{path} contains an undeclared property.")
        for key, item in value.items():
            prop_schema = properties.get(key)
            if not isinstance(prop_schema, dict):
                raise QAError(f"{path} contains an undeclared property.")
            _validate_schema_arguments(item, prop_schema, f"{path}.{key}")
        return

    type_ok = {
        "string": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "boolean": isinstance(value, bool),
        "array": isinstance(value, list),
    }.get(expected_type, False)
    if not type_ok:
        raise QAError(f"{path} does not match its advertised schema type.")
    if isinstance(value, str) and len(value) > schema.get("maxLength", 10**9):
        raise QAError(f"{path} exceeds its advertised maximum length.")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value < schema.get("minimum", value) or value > schema.get("maximum", value):
            raise QAError(f"{path} is outside its advertised range.")
    if "enum" in schema:
        enum = schema["enum"]
        if not isinstance(enum, list) or value not in enum:
            raise QAError(f"{path} is outside its advertised enum.")
    if expected_type == "array":
        minimum = schema.get("minItems", 0)
        maximum = schema.get("maxItems", 10**9)
        if len(value) < minimum or len(value) > maximum:
            raise QAError(f"{path} has an invalid item count.")
        item_schema = schema.get("items")
        if not isinstance(item_schema, dict):
            raise QAError(f"{path} array schema is malformed.")
        for index, item in enumerate(value):
            _validate_schema_arguments(item, item_schema, f"{path}[{index}]")


def _parse_schemas(body: dict) -> dict[str, dict]:
    raw_tools = body.get("tools", [])
    if not isinstance(raw_tools, list):
        raise QAError("Request tools must be an array.")
    schemas: dict[str, dict] = {}
    for raw in raw_tools:
        if not isinstance(raw, dict) or not isinstance(raw.get("function"), dict):
            raise QAError("Request contains a malformed function tool.")
        name = raw["function"].get("name")
        if not isinstance(name, str) or not name:
            raise QAError("Request contains a function without a name.")
        if name in schemas:
            raise QAError("Request advertises a duplicate function name.")
        schemas[name] = raw
    return schemas


def _validate_expected_schema(schemas: dict[str, dict], name: str) -> dict:
    if name not in schemas:
        raise QAError(f"Required tool {name} was not advertised.")
    parameters, properties = _object_schema(schemas[name], name)
    required = parameters.get("required", [])
    if name == "read_current_prompts":
        if properties:
            raise QAError("read_current_prompts must advertise no parameters.")
    elif name == "get_memories":
        _require_property(properties, "query", "string")
        if "query" not in required:
            raise QAError("get_memories must require query.")
    elif name == "search_danbooru":
        _require_property(properties, "query", "string")
        if "query" not in required:
            raise QAError("search_danbooru must require query.")
        _require_property(properties, "limit", "integer")
        _require_property(properties, "show_nsfw", "boolean")
    elif name == "write_prompt":
        _require_property(properties, "target", "string")
        _require_property(properties, "mode", "string")
        _require_property(properties, "content", "string")
        if not {"target", "content"}.issubset(required):
            raise QAError("write_prompt must require target and content.")
        for prop_name, expected in (("target", "positive"), ("mode", "append")):
            enum = properties[prop_name].get("enum")
            if not isinstance(enum, list) or expected not in enum:
                raise QAError(f"write_prompt schema must allow {expected}.")
    return parameters


def _extract_user_text(messages: list) -> tuple[list, str]:
    last_user = None
    for index, message in enumerate(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            last_user = index
    if last_user is None:
        raise QAError("Chat request has no user message.")
    current = messages[last_user:]
    content = current[0].get("content", "")
    if isinstance(content, str):
        user_text = content
    elif isinstance(content, list):
        user_text = " ".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and isinstance(part.get("text"), str)
        )
    else:
        user_text = ""
    return current, user_text


def _history(current: list, schemas: dict[str, dict]) -> tuple[list[dict], list[dict]]:
    calls: list[dict] = []
    results: list[dict] = []
    seen: set[str] = set()
    for message in current:
        if not isinstance(message, dict):
            raise QAError("Chat history contains a malformed message.")
        if message.get("role") == "assistant" and "tool_calls" in message:
            raw_calls = message.get("tool_calls")
            if not isinstance(raw_calls, list):
                raise QAError("Assistant tool_calls must be an array.")
            for raw_call in raw_calls:
                if not isinstance(raw_call, dict) or raw_call.get("type") != "function":
                    raise QAError("Assistant returned a malformed function call.")
                call_id = raw_call.get("id")
                function = raw_call.get("function")
                if not isinstance(call_id, str) or not call_id or call_id in seen:
                    raise QAError("Assistant returned a missing or duplicate tool_call_id.")
                if not isinstance(function, dict):
                    raise QAError("Assistant function call is malformed.")
                name = function.get("name")
                raw_arguments = function.get("arguments")
                if not isinstance(name, str) or name not in schemas:
                    raise QAError("Assistant called a tool that was not advertised.")
                if not isinstance(raw_arguments, str):
                    raise QAError("Tool arguments must be a JSON string.")
                try:
                    arguments = _strict_json_loads(raw_arguments)
                except (json.JSONDecodeError, ValueError) as error:
                    raise QAError("Tool arguments are not valid JSON.") from error
                schema = schemas[name]["function"].get("parameters")
                if not isinstance(schema, dict):
                    raise QAError("Called tool has no valid advertised parameter schema.")
                _validate_schema_arguments(arguments, schema)
                seen.add(call_id)
                calls.append({"id": call_id, "name": name, "arguments": arguments})
        elif message.get("role") == "tool":
            call_id = message.get("tool_call_id")
            name = message.get("name")
            content = message.get("content")
            if not isinstance(call_id, str) or not isinstance(content, str):
                raise QAError("Tool result is missing tool_call_id or JSON content.")
            try:
                decoded = _strict_json_loads(content)
            except (json.JSONDecodeError, ValueError) as error:
                raise QAError("Tool result content is not valid JSON.") from error
            if not isinstance(decoded, dict) or not isinstance(decoded.get("ok"), bool):
                raise QAError("Tool result must be a JSON object with boolean ok.")
            results.append({"id": call_id, "name": name, "value": decoded})
    if len(calls) != len(results):
        raise QAError("Every tool call must have exactly one returned tool result.")
    result_ids: set[str] = set()
    for call, result in zip(calls, results):
        if result["id"] != call["id"]:
            raise QAError("Tool result tool_call_id does not match its call.")
        if result["id"] in result_ids:
            raise QAError("A tool_call_id has more than one result.")
        if result["name"] is not None and result["name"] != call["name"]:
            raise QAError("Tool result name does not match its tool_call_id.")
        result_ids.add(result["id"])
    return calls, results


def _require_tool_call(
    call: dict,
    expected_name: str,
    expected_args: dict,
    schemas: dict[str, dict],
) -> None:
    if call["name"] != expected_name:
        raise QAError("Tool sequence did not match the synthetic QA contract.")
    schema = _validate_expected_schema(schemas, expected_name)
    _validate_schema_arguments(call["arguments"], schema)
    if call["arguments"] != expected_args:
        raise QAError("Tool arguments did not match the advertised QA fixture values.")


def _require_ok(result: dict, expected_name: str) -> dict:
    value = result["value"]
    if result["name"] is not None and result["name"] != expected_name:
        raise QAError("Tool result name does not match its call.")
    if value["ok"] is not True:
        return value
    if "error" in value:
        raise QAError("Tool reported success while also carrying an error.")
    return value


def _validate_tool_success(name: str, result: dict) -> tuple[bool, list[str], str]:
    value = result["value"]
    if value["ok"] is False:
        error = value.get("error")
        if not isinstance(error, str) or not error.strip():
            raise QAError("Failed tool result must include a clear error string.")
        return False, [], ""
    data = _require_ok(result, name)
    returned_tags: list[str] = []
    source = ""
    if name == "read_current_prompts":
        if not all(isinstance(data.get(key), str) for key in ("positive", "negative", "version")):
            raise QAError("read_current_prompts result is missing prompt snapshot fields.")
        if not isinstance(data.get("characters"), list) or not isinstance(
            data.get("is_inpainting_mode"), bool
        ):
            raise QAError("read_current_prompts result has an invalid snapshot shape.")
    elif name == "get_memories":
        memories, count = data.get("memories"), data.get("count")
        if not isinstance(memories, list) or isinstance(count, bool) or not isinstance(count, int):
            raise QAError("get_memories result has an invalid JSON shape.")
        if count != len(memories):
            raise QAError("get_memories count does not match its returned records.")
        if not isinstance(data.get("note"), str):
            raise QAError("get_memories result is missing its data-boundary note.")
        for memory in memories:
            if not isinstance(memory, dict) or not all(
                isinstance(memory.get(key), str)
                for key in ("id", "trigger", "content", "type", "source")
            ):
                raise QAError("get_memories returned a malformed memory record.")
    elif name == "search_danbooru":
        raw_tags = data.get("tags")
        if not isinstance(raw_tags, list):
            raise QAError("search_danbooru result is missing its tags array.")
        count = data.get("count")
        if isinstance(count, bool) or not isinstance(count, int) or count != len(raw_tags):
            raise QAError("search_danbooru count does not match its tag records.")
        source = data.get("source", "")
        if not isinstance(source, str) or source.rstrip("/") != EXPECTED_SEARCH_SOURCE:
            raise QAError("search_danbooru did not report the fixed local synthetic source.")
        if data.get("query") != "星璃 月光森林" or data.get("show_nsfw") is not False:
            raise QAError("search_danbooru result does not match the safe query fixture.")
        expected = {entry["tag"]: entry for entry in FIXTURE_TAGS}
        for tag in raw_tags:
            if not isinstance(tag, dict) or not isinstance(tag.get("tag"), str):
                raise QAError("search_danbooru returned a malformed tag record.")
            tag_name = tag["tag"]
            fixture = expected.get(tag_name)
            if fixture is None or tag_name in returned_tags:
                raise QAError("search_danbooru returned an unexpected or duplicate tag.")
            if tag.get("nsfw") != "safe" or tag.get("category") != "general":
                raise QAError("search_danbooru returned a tag outside the safe fixture.")
            if tag.get("cn_name") != fixture["cn_name"]:
                raise QAError("search_danbooru returned a mismatched Chinese tag label.")
            if tag.get("count") != fixture["count"]:
                raise QAError("search_danbooru returned a mismatched tag count.")
            score = tag.get("score")
            if not isinstance(score, (int, float)) or isinstance(score, bool):
                raise QAError("search_danbooru returned a tag without a numeric score.")
            if abs(float(score) - fixture["final_score"]) > 1e-9:
                raise QAError("search_danbooru returned a mismatched synthetic tag score.")
            if not isinstance(tag.get("wiki"), str) or not tag["wiki"]:
                raise QAError("search_danbooru returned a tag without its synthetic wiki note.")
            if not isinstance(tag.get("prompt_text"), str) or not tag["prompt_text"]:
                raise QAError("search_danbooru returned a tag without prompt_text.")
            returned_tags.append(tag_name)
        if set(returned_tags) != set(expected):
            raise QAError("search_danbooru did not return all three synthetic safe tags.")
    elif name == "write_prompt":
        if data.get("target") != "positive" or data.get("saved") is not True:
            raise QAError("write_prompt result does not confirm a saved positive prompt.")
        content = data.get("content")
        if not isinstance(content, str) or not content.endswith(EXPECTED_PROMPT_APPEND):
            raise QAError("write_prompt result does not contain the expected appended text.")
    return True, returned_tags, source


def _diagnostic_nonce(schemas: dict[str, dict]) -> tuple[str, str, dict]:
    if set(schemas) != {"diagnostic_echo"}:
        raise QAError("diagnostic_echo must be the only advertised tool in a diagnostic turn.")
    parameters, properties = _object_schema(schemas["diagnostic_echo"], "diagnostic_echo")
    if len(properties) != 1:
        raise QAError("diagnostic_echo schema must expose one nonce field.")
    field, field_schema = next(iter(properties.items()))
    if not isinstance(field, str) or not isinstance(field_schema, dict):
        raise QAError("diagnostic_echo nonce schema is malformed.")
    if field_schema.get("type") != "string" or not isinstance(field_schema.get("enum"), list):
        raise QAError("diagnostic_echo must advertise its nonce as a string enum.")
    values = field_schema["enum"]
    if not values or not all(isinstance(value, str) for value in values):
        raise QAError("diagnostic_echo nonce enum is empty or malformed.")
    required = parameters.get("required", [])
    if field not in required:
        raise QAError("diagnostic_echo must require its nonce field.")
    return field, values[0], parameters


def _evaluate_diagnostic(current: list, schemas: dict[str, dict]) -> tuple[str | None, str, dict | None]:
    field, nonce, parameters = _diagnostic_nonce(schemas)
    calls, results = _history(current, schemas)
    if not calls:
        return "diagnostic_echo", "", {"field": field, "nonce": nonce, "schema": parameters}
    if len(calls) != 1 or len(results) != 1:
        raise QAError("diagnostic_echo must complete exactly one call/result round trip.")
    _require_tool_call(calls[0], "diagnostic_echo", {field: nonce}, schemas)
    result = results[0]["value"]
    if result["ok"] is not True or result.get(field) != nonce or result.get("received") is not True:
        raise QAError("diagnostic_echo result did not return the exact nonce for its call ID.")
    return None, "工具调用链路诊断完成：本地合成服务已核验本轮随机值，并收到匹配 tool_call_id 的成功结果。", None


def _evaluate_normal(
    current: list,
    schemas: dict[str, dict],
    *,
    interface_failure: bool,
) -> tuple[str | None, str, dict | None, list[str], str, str]:
    expected_steps = [
        ("read_current_prompts", {}),
        ("get_memories", {"query": "星璃"}),
        (
            "search_danbooru",
            {
                "query": "qa_failure" if interface_failure else "星璃 月光森林",
                "limit": 5,
                "show_nsfw": False,
            },
        ),
    ]
    if not interface_failure:
        expected_steps.append(
            (
                "write_prompt",
                {
                    "target": "positive",
                    "mode": "append",
                    "content": EXPECTED_PROMPT_APPEND,
                },
            )
        )

    calls, results = _history(current, schemas)
    all_tags: list[str] = []
    source = ""
    if len(calls) > len(expected_steps):
        raise QAError("Assistant emitted a tool call after the synthetic flow had ended.")

    for index, call in enumerate(calls):
        name, arguments = expected_steps[index]
        _require_tool_call(call, name, arguments, schemas)
        valid, tags, result_source = _validate_tool_success(name, results[index])
        all_tags.extend(tags)
        if result_source:
            source = result_source
        if not valid:
            if name == "search_danbooru":
                return (
                    None,
                    "合成标签接口返回明确失败，本轮已结束；没有调用写词工具，也没有修改提示词。",
                    None,
                    all_tags,
                    source or "synthetic_mobile_index",
                    "stopped",
                )
            return (
                None,
                f"工具 {name} 返回失败，本轮已结束；没有继续后续操作，也没有确认写入。",
                None,
                all_tags,
                source or "synthetic",
                "stopped",
            )

    if interface_failure:
        if len(calls) == 3:
            return (
                None,
                "故障测试未收到预期的标签接口错误；为避免误写提示词，本轮已结束且没有调用写词工具。",
                None,
                all_tags,
                source or "synthetic_mobile_index",
                "stopped",
            )
        next_name, next_arguments = expected_steps[len(calls)]
        _validate_expected_schema(schemas, next_name)
        return next_name, "", {"arguments": next_arguments}, all_tags, source, "tool_call"

    if len(calls) == 4:
        return (
            None,
            "已按顺序核验当前提示词、记忆和三条安全的合成标签；提示词追加结果确认已保存。没有生成图片。",
            None,
            all_tags,
            source or "synthetic_mobile_index",
            "completed",
        )
    next_name, next_arguments = expected_steps[len(calls)]
    _validate_expected_schema(schemas, next_name)
    return next_name, "", {"arguments": next_arguments}, all_tags, source, "tool_call"


class QAState:
    def __init__(self, log_path: Path):
        self.log_path = log_path
        self.lock = threading.Lock()
        self.pending_search_ids: list[str] = []
        self.stats = {
            "chat_requests": 0,
            "tool_calls_emitted": 0,
            "search_requests": 0,
            "search_failures": 0,
            "completed_flows": 0,
            "stopped_flows": 0,
            "last_status": "idle",
            "last_source": "synthetic",
            "last_returned_tags": [],
        }

    def queue_search_id(self, call_id: str) -> None:
        with self.lock:
            self.pending_search_ids.append(call_id)

    def take_search_id(self) -> str | None:
        with self.lock:
            if self.pending_search_ids:
                return self.pending_search_ids.pop(0)
        return None

    def record(self, event: dict) -> None:
        try:
            safe_path = _confined_path(self.log_path, "Log path")
            safe_path.parent.mkdir(parents=True, exist_ok=True)
            safe_path = _confined_path(safe_path, "Log path")
            if safe_path.exists() and not safe_path.is_file():
                raise QAError("Log path must be a regular file.")
            line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
            with safe_path.open("a", encoding="utf-8", newline="\n") as log:
                log.write(line + "\n")
        except (OSError, QAError):
            # Logging must never turn a synthetic response into a false success.
            pass

    def update(self, **values) -> None:
        with self.lock:
            self.stats.update(values)

    def increment(self, **values: int) -> None:
        with self.lock:
            for key, amount in values.items():
                self.stats[key] += amount

    def snapshot(self) -> dict:
        with self.lock:
            return dict(self.stats)


class LoopbackThreadingHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "TagAgentQAMock/1.0"
    sys_version = ""

    def log_message(self, *_args) -> None:
        # Avoid default request-line logging, which can contain user text.
        return

    @property
    def state(self) -> QAState:
        return self.server.qa_state  # type: ignore[attr-defined]

    def _loopback_only(self) -> bool:
        try:
            return ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            return False

    def _send(self, status: int, body: object, content_type: str = "application/json; charset=utf-8") -> None:
        payload = _json_bytes(body)
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True

    def _send_error_json(self, status: int, message: str) -> None:
        try:
            self._send(status, {"error": message})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _read_json(self, maximum: int) -> dict:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise QAError("Content-Length is required.")
        try:
            length = int(raw_length)
        except ValueError as error:
            raise QAError("Content-Length is invalid.") from error
        if length < 0:
            raise QAError("Content-Length is invalid.")
        if length > maximum:
            raise OverflowError
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise QAError("Request body ended before Content-Length bytes arrived.")
        try:
            value = _strict_json_loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            raise QAError("Request body must be valid UTF-8 JSON.") from error
        if not isinstance(value, dict):
            raise QAError("Request body must be a JSON object.")
        return value

    def do_GET(self) -> None:
        if not self._loopback_only():
            self._send_error_json(403, "Loopback clients only.")
            return
        path = urlsplit(self.path).path
        if path == "/v1/models":
            self._send(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": "synthetic-tool-model",
                            "object": "model",
                            "created": 0,
                            "owned_by": "local-qa",
                        }
                    ],
                },
            )
            return
        if path == "/qa/status":
            self._send(
                200,
                {
                    "ok": True,
                    "listener": f"127.0.0.1:{PORT}",
                    "stats": self.state.snapshot(),
                },
            )
            return
        if path == "/api/search":
            self._send_error_json(405, "POST is required for /api/search.")
            return
        self._send_error_json(404, "Not found.")

    def do_POST(self) -> None:
        if not self._loopback_only():
            self._send_error_json(403, "Loopback clients only.")
            return
        path = urlsplit(self.path).path
        if path == "/v1/chat/completions":
            self._post_chat()
        elif path == "/api/search":
            self._post_search()
        else:
            self._send_error_json(404, "Not found.")

    def _post_chat(self) -> None:
        started = time.monotonic()
        try:
            body = self._read_json(MAX_CHAT_BODY)
        except OverflowError:
            self._send_error_json(413, "Chat request exceeds the 2 MiB limit.")
            return
        except QAError as error:
            status = 411 if "Content-Length is required" in str(error) else 400
            self._send_error_json(status, str(error))
            return
        if "stream" in body and not isinstance(body["stream"], bool):
            self._send_error_json(400, "stream must be boolean when supplied.")
            return

        try:
            messages = body.get("messages")
            if not isinstance(messages, list):
                raise QAError("Chat messages must be an array.")
            current, user_text = _extract_user_text(messages)
            schemas = _parse_schemas(body)
            no_tool_case = "无工具测试" in user_text
            cancel_case = "取消测试" in user_text
            failure_case = "接口故障测试" in user_text
            diagnostic = "diagnostic_echo" in schemas
            if cancel_case and not any(message.get("role") == "tool" for message in current if isinstance(message, dict)):
                time.sleep(8)

            if no_tool_case:
                next_name = None
                content = "本地合成服务：无工具测试按设计只返回文本，没有调用任何工具。"
                call_data = None
                returned_tags: list[str] = []
                source = "synthetic"
                outcome = "no_tool"
            elif diagnostic:
                next_name, content, call_data = _evaluate_diagnostic(current, schemas)
                returned_tags = []
                source = "diagnostic_echo"
                outcome = "completed" if next_name is None else "tool_call"
            else:
                next_name, content, call_data, returned_tags, source, outcome = _evaluate_normal(
                    current, schemas, interface_failure=failure_case
                )

            call_id = None
            if next_name is not None:
                if next_name == "diagnostic_echo" and call_data is not None:
                    _validate_schema_arguments(
                        {call_data["field"]: call_data["nonce"]}, call_data["schema"]
                    )
                elif call_data is not None:
                    self._validate_expected_outgoing_schema(next_name, schemas, call_data["arguments"])
                call_id = f"qa-tag-{uuid.uuid4().hex}"
                if next_name == "search_danbooru":
                    self.state.queue_search_id(call_id)
                self._emit_chat(body, next_name, call_data, call_id, content)
                self.state.increment(tool_calls_emitted=1)
            else:
                self._emit_chat(body, None, None, None, content)
                self.state.increment(
                    completed_flows=1 if outcome == "completed" else 0,
                    stopped_flows=1 if outcome in ("no_tool", "stopped") else 0,
                )

            self.state.increment(chat_requests=1)
            self.state.update(
                last_status=outcome,
                last_source=source,
                last_returned_tags=returned_tags,
            )
            self.state.record(
                {
                    "time_utc": datetime.now(timezone.utc).isoformat(),
                    "path": "/v1/chat/completions",
                    "status": 200,
                    "step": next_name or "final",
                    "call_id": call_id,
                    "tool_results": [
                        {"step": call["name"], "call_id": call["id"], "status": result["value"]["ok"]}
                        for call, result in zip(*_history(current, schemas))
                    ] if not no_tool_case else [],
                    "source": source,
                    "returned_tags": returned_tags,
                    "outcome": outcome,
                    "elapsed_ms": int((time.monotonic() - started) * 1000),
                }
            )
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        except Exception as error:
            detail = str(error) if isinstance(error, QAError) else "请求或工具协议结构不正确。"
            content = f"本地合成 QA 已安全结束：{detail} 没有确认任何后续写入。"
            self.state.increment(chat_requests=1, stopped_flows=1)
            self.state.update(last_status="protocol_error", last_source="synthetic", last_returned_tags=[])
            self.state.record(
                {
                    "time_utc": datetime.now(timezone.utc).isoformat(),
                    "path": "/v1/chat/completions",
                    "status": 200,
                    "step": "final_error",
                    "call_id": None,
                    "tool_results": [],
                    "source": "synthetic",
                    "returned_tags": [],
                    "outcome": "protocol_error",
                }
            )
            try:
                self._emit_chat(body, None, None, None, content)
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    def _validate_expected_outgoing_schema(self, name: str, schemas: dict[str, dict], arguments: dict) -> None:
        schema = _validate_expected_schema(schemas, name)
        _validate_schema_arguments(arguments, schema)

    def _emit_chat(
        self,
        body: dict,
        tool_name: str | None,
        call_data: dict | None,
        call_id: str | None,
        content: str,
    ) -> None:
        stream = body.get("stream", True)
        if not isinstance(stream, bool):
            raise QAError("stream must be boolean when supplied.")
        response_id = f"chatcmpl-qa-{uuid.uuid4().hex}"
        if tool_name == "diagnostic_echo":
            arguments = {call_data["field"]: call_data["nonce"]}
        elif tool_name is not None:
            arguments = call_data["arguments"]
        else:
            arguments = None

        if not stream:
            message = {"role": "assistant", "content": content or None, "reasoning_content": "qa-synthetic-protocol-field"}
            if tool_name is not None:
                message["content"] = None
                message["tool_calls"] = [
                    {
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": json.dumps(arguments, ensure_ascii=False, separators=(",", ":")),
                        },
                    }
                ]
            self._send(
                200,
                {
                    "id": response_id,
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": "synthetic-tool-model",
                    "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool_name else "stop"}],
                },
            )
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(delta: dict, finish: str | None = None) -> None:
            payload = {
                "id": response_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": "synthetic-tool-model",
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            self.wfile.write(b"data: " + _json_bytes(payload) + b"\n\n")
            self.wfile.flush()

        try:
            emit({"role": "assistant", "reasoning_content": "qa-synthetic-protocol-field"})
            if tool_name is not None:
                raw_arguments = json.dumps(arguments, ensure_ascii=False, separators=(",", ":"))
                split = max(1, len(raw_arguments) // 2)
                emit(
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": call_id,
                                "type": "function",
                                "function": {"name": tool_name, "arguments": raw_arguments[:split]},
                            }
                        ]
                    }
                )
                emit(
                    {
                        "tool_calls": [
                            {"index": 0, "function": {"arguments": raw_arguments[split:]}}
                        ]
                    },
                    "tool_calls",
                )
            else:
                midpoint = max(1, len(content) // 2)
                emit({"content": content[:midpoint]})
                emit({"content": content[midpoint:]}, "stop")
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return

    def _post_search(self) -> None:
        call_id = self.state.take_search_id()
        try:
            body = self._read_json(MAX_SEARCH_BODY)
        except OverflowError:
            self._record_search(call_id, 413, [], "synthetic_mobile_index", False)
            self._send_error_json(413, "Search request exceeds the 64 KiB limit.")
            return
        except QAError as error:
            self._record_search(call_id, 400, [], "synthetic_mobile_index", False)
            status = 411 if "Content-Length is required" in str(error) else 400
            self._send_error_json(status, str(error))
            return

        query = body.get("query")
        top_k = body.get("top_k", 5)
        limit = body.get("limit", 30)
        show_nsfw = body.get("show_nsfw", False)
        if (
            not isinstance(query, str)
            or not query.strip()
            or isinstance(top_k, bool)
            or not isinstance(top_k, int)
            or top_k < 1
            or top_k > 30
            or isinstance(limit, bool)
            or not isinstance(limit, int)
            or limit < 1
            or limit > 30
            or not isinstance(show_nsfw, bool)
        ):
            self._record_search(call_id, 400, [], "synthetic_mobile_index", False)
            self._send_error_json(400, "Search query/top_k/limit/show_nsfw has an invalid type.")
            return

        if query == "qa_failure":
            self._record_search(call_id, 503, [], "synthetic_mobile_index", True)
            self._send_error_json(503, "Synthetic tag-index failure requested by QA fixture.")
            return

        tags = [dict(item) for item in FIXTURE_TAGS[: min(limit, top_k, len(FIXTURE_TAGS))]]
        self._record_search(call_id, 200, [item["tag"] for item in tags], "synthetic_mobile_index", False)
        self._send(200, {"results": tags})

    def _record_search(
        self,
        call_id: str | None,
        status: int,
        returned_tags: list[str],
        source: str,
        failure_fixture: bool,
    ) -> None:
        self.state.increment(search_requests=1, search_failures=1 if status >= 500 else 0)
        self.state.update(last_status=f"search_http_{status}", last_source=source, last_returned_tags=returned_tags)
        self.state.record(
            {
                "time_utc": datetime.now(timezone.utc).isoformat(),
                "path": "/api/search",
                "status": status,
                "step": "search_danbooru",
                "call_id": call_id,
                "source": source,
                "returned_tags": returned_tags,
                "fixture": "qa_failure" if failure_fixture else "safe_synthetic_index",
            }
        )


def serve(data_arg: str, log_arg: str) -> None:
    _temp_root(create=True)
    data_dir = _confined_path(data_arg, "Data directory")
    data_dir.mkdir(parents=True, exist_ok=True)
    data_dir = _confined_path(data_dir, "Data directory")
    if not data_dir.is_dir():
        raise QAError("Data directory must be a directory.")
    log_path = _confined_path(log_arg, "Log path")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = _confined_path(log_path, "Log path")
    if log_path.exists() and not log_path.is_file():
        raise QAError("Log path must be a regular file.")

    server = LoopbackThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.qa_root = ROOT.resolve()  # type: ignore[attr-defined]
    server.qa_data_dir = data_dir  # type: ignore[attr-defined]
    server.qa_state = QAState(log_path)  # type: ignore[attr-defined]
    print(f"Synthetic tag Agent QA on 127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopped.", flush=True)
    finally:
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare", action="store_true", help="Create a synthetic workspace SQLite database.")
    parser.add_argument(
        "--fixture",
        default=".tmp/tag-agent-native-fixture.json",
        help="c.exportWorkspace() JSON fixture; must resolve inside PC/.tmp.",
    )
    parser.add_argument(
        "--data-dir",
        default=".tmp/tag-agent-native-qa",
        help="Workspace directory; must resolve inside PC/.tmp.",
    )
    parser.add_argument(
        "--log",
        default=".tmp/tag-agent-native-requests.jsonl",
        help="Append-only redacted JSONL receipt path; must resolve inside PC/.tmp.",
    )
    options = parser.parse_args()
    try:
        if options.prepare:
            prepare_fixture(options.fixture, options.data_dir)
        else:
            serve(options.data_dir, options.log)
    except (QAError, OSError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
