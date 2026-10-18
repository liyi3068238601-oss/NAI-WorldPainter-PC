from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
REGISTRY_PATH = ROOT / "tool-registry.json"
CONTRACTS_PATH = ROOT / "TOOL_CONTRACTS.md"
LABELS = ("职责与时机", "可用性与副作用", "模型入参", "Host 注入", "业务结果")


def read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def _value(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    return str(value)


def _bounds(schema: dict[str, Any], *, length: bool = False) -> str:
    minimum = "minLength" if length else "minimum"
    maximum = "maxLength" if length else "maximum"
    parts = []
    if minimum in schema:
        parts.append(f"min {schema[minimum]}")
    if maximum in schema:
        parts.append(f"max {schema[maximum]}")
    if schema.get("exclusiveMinimum") is not None:
        parts.append(f"> {schema['exclusiveMinimum']}")
    if schema.get("exclusiveMaximum") is not None:
        parts.append(f"< {schema['exclusiveMaximum']}")
    return f" ({', '.join(parts)})" if parts else ""


def render_type(schema: dict[str, Any]) -> str:
    """Render a compact, deterministic type/enum/range summary from JSON Schema."""
    if "enum" in schema:
        base = "value ∈ {" + ", ".join(_value(item) for item in schema["enum"]) + "}"
        return base + _bounds(schema, length=schema.get("type") == "string")
    if "const" in schema:
        return "value=" + _value(schema["const"])
    if "anyOf" in schema or "oneOf" in schema:
        branches = schema.get("anyOf", schema.get("oneOf", []))
        return " | ".join(render_type(branch) for branch in branches)
    kind = schema.get("type", "any")
    if isinstance(kind, list):
        return " | ".join(render_type({**schema, "type": item}) for item in kind)
    if kind == "array":
        item_type = render_type(schema.get("items", {}))
        result = f"array<{item_type}>"
        if schema.get("minItems") is not None:
            result += f" ≥{schema['minItems']}"
        if schema.get("maxItems") is not None:
            result += f" ≤{schema['maxItems']}"
        return result
    if kind == "string":
        return "string" + _bounds(schema, length=True)
    if kind in ("integer", "number"):
        return kind + _bounds(schema)
    if kind == "object":
        return "object"
    return kind


def _field_rows(properties: dict[str, Any], required: list[str]) -> str:
    if not properties:
        return "无"
    return "; ".join(
        f"`{field}{'*' if field in required else ''}`: {render_type(schema)}"
        for field, schema in properties.items()
    )


def build_summary_lines(tool: dict[str, Any], *, group_count: int | None = None) -> dict[str, str]:
    """Return the five human-contract rows that are wholly derived from registry data."""
    availability = tool["availability"]
    cost = tool["cost"]
    host_fields = tool.get("hostInjectedFields", [])
    host = ", ".join(host_fields) if host_fields else "无额外模型可见字段"
    input_schema = tool["inputSchema"]
    data_schema = tool["resultSchema"].get("properties", {}).get("data", {})
    input_properties = input_schema.get("properties", {})
    result_properties = data_schema.get("properties", {})
    model_fields = tool.get("modelFields", [])
    model_properties = {name: input_properties[name] for name in model_fields}
    model_summary = _field_rows(model_properties, input_schema.get("required", []))
    if tool["canonical"] == "get_capabilities" and group_count is not None:
        model_summary += f"（每次请求最多 10 组；完整目录共 {group_count} 组）"
    return {
        "职责与时机": f"**职责与时机：** {tool['description']}",
        "可用性与副作用": (
            f"**可用性与副作用：** `{availability['exposure']}` / `{availability['group']}`；"
            f"effect=`{tool['effect']}`；approval=`{tool['approval']}`；"
            f"paid=`{_value(cost['paid'])}`，mayCharge=`{_value(cost['mayCharge'])}`。Host-only：{host}."
        ),
        "模型入参": f"**模型入参：** {model_summary}。",
        "Host 注入": f"**Host 注入：** {host}。逐字段派生来源见 registry `fieldMappings.hostInjected`。",
        "业务结果": f"**业务结果：** {_field_rows(result_properties, data_schema.get('required', []))}。",
    }


def sync_content(text: str, registry: dict[str, Any]) -> tuple[str, list[str]]:
    lines = text.splitlines()
    sections: dict[str, tuple[int, int]] = {}
    heading_indices = []
    for index, line in enumerate(lines):
        if line.startswith("### `") and line.endswith("`"):
            heading_indices.append((index, line[5:-1]))
    for position, (heading_index, name) in enumerate(heading_indices):
        end = heading_indices[position + 1][0] if position + 1 < len(heading_indices) else len(lines)
        sections[name] = (heading_index, end)

    drifted = []
    for tool in registry["tools"]:
        name = tool["canonical"]
        if name not in sections:
            raise ValueError(f"TOOL_CONTRACTS.md has no section for {name}")
        start, end = sections[name]
        expected = build_summary_lines(tool, group_count=len(registry["groupCatalog"]))
        found = {label: None for label in LABELS}
        for index in range(start + 1, end):
            line = lines[index]
            for label in LABELS:
                if line.startswith(f"**{label}：**"):
                    found[label] = index
                    break
        for label, expected_line in expected.items():
            index = found[label]
            if index is None:
                raise ValueError(f"{name}: missing derived summary row {label}")
            if lines[index] != expected_line:
                drifted.append(f"{name}:{label}")
                lines[index] = expected_line
    return "\n".join(lines) + "\n", drifted


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate/check registry-derived TOOL_CONTRACTS.md rows.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--write", action="store_true", help="write derived rows into TOOL_CONTRACTS.md")
    mode.add_argument("--check", action="store_true", help="check derived rows only (default)")
    args = parser.parse_args()
    registry = read_json(REGISTRY_PATH)
    original_bytes = CONTRACTS_PATH.read_bytes()
    newline = "\r\n" if b"\r\n" in original_bytes else "\n"
    original = original_bytes.decode("utf-8")
    rendered, drifted = sync_content(original, registry)
    if args.write:
        CONTRACTS_PATH.write_bytes(rendered.replace("\n", newline).encode("utf-8"))
        print(f"Wrote registry-derived rows for {len(registry['tools'])} tools; {len(drifted)} rows changed.")
        return 0
    if drifted:
        print("Registry-derived TOOL_CONTRACTS.md rows are stale:", file=sys.stderr)
        for item in drifted:
            print(f"  {item}", file=sys.stderr)
        print("Run python sync_tool_summaries.py --write to update only those rows.", file=sys.stderr)
        return 1
    print(f"OK: all five registry-derived summary rows match for {len(registry['tools'])} tools.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
