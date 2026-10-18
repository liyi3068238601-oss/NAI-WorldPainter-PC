#!/usr/bin/env python3
"""Validate the design-only tool registry and its JSON Schema fixtures.

Requires Python 3.10+ and jsonschema 4.x. This script does not contact services
or execute product handlers.
"""
from __future__ import annotations

import json
import re
import sys
import copy
from pathlib import Path

from jsonschema import Draft202012Validator
from sync_tool_summaries import build_summary_lines

ROOT = Path(__file__).resolve().parent
REGISTRY_PATH = ROOT / "tool-registry.json"
FIXTURE_PATH = ROOT / "schema-fixtures" / "fixtures.json"
COUNTEREXAMPLE_PATH = ROOT / "schema-fixtures" / "counterexamples-r3.json"
ORIGINAL_AGGREGATE_COUNTEREXAMPLE_PATH = ROOT / "source" / "R3_新增聚合状态反例.json"
EXPECTED = [
    "get_capabilities", "read_generation_state", "list_history", "search_tags",
    "search_artists", "search_gallery", "search_web", "search_prompt_presets",
    "search_reference_presets", "read_image_metadata", "search_memories",
    "read_skill", "read_prompting_reference", "ask_user", "get_execution",
    "propose_prompt", "read_creation", "read_proposal", "set_current_proposal",
    "apply_prompt", "save_prompt_preset", "read_prompt_template",
    "manage_prompt_templates", "convert_prompt", "edit_prompt", "reverse_prompt",
    "prepare_generation", "generate_image", "redraw_image", "inpaint_image",
    "upscale_image", "process_image", "cancel_execution", "propose_memory",
    "delete_memory_candidate", "patch_creation_inputs",
]
DRAFT = "https://json-schema.org/draft/2020-12/schema"
EXECUTION_STATUSES = (
    "queued", "dispatching", "running", "cancel_requested", "completed",
    "partial", "error", "cancelled", "unknown", "blocked", "denied",
)
ATTACHMENT_IDENTITY = [
    "artifactId", "attachmentId", "attachmentRevision", "hash", "outputIndex",
    "conversationId", "creationId", "parentAttachmentId",
]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load(path: Path):
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def walk_objects(schema, path="$"):
    if isinstance(schema, dict):
        if schema.get("type") == "object":
            require(
                schema.get("additionalProperties") is False,
                f"{path}: object schema must set additionalProperties:false",
            )
            # Yield the current object as well as its descendants. The previous
            # implementation only recursed, leaving dependent identity checks empty.
            yield path, schema
        for key, value in schema.items():
            if isinstance(value, (dict, list)):
                yield from walk_objects(value, f"{path}.{key}")
    elif isinstance(schema, list):
        for index, value in enumerate(schema):
            yield from walk_objects(value, f"{path}[{index}]")


def assert_completed_output_identity(outputs_schema):
    required = set()
    for clause in outputs_schema.get("allOf", []):
        if clause.get("if", {}).get("properties", {}).get("status", {}).get("const") == "completed":
            required.update(clause.get("then", {}).get("required", []))
    require(set(ATTACHMENT_IDENTITY).issubset(required),
            "completed output must require the full stable attachment identity")


def validate_execution_semantics(data):
    """Validate aggregate state evidence that the JSON Schema cannot express."""
    if data.get("readStatus") != "ok":
        return

    def check(condition: bool, rule: str, message: str) -> None:
        if not condition:
            raise AssertionError(f"[{rule}] {message}")

    expected = data["expectedOutputCount"]
    outputs = data["outputs"]
    statuses = [item["status"] for item in outputs]
    indices = [item["outputIndex"] for item in outputs]
    execution = data["executionStatus"]
    granularity = data["requestGranularity"]
    provider = data.get("providerReceiptStatus")
    check(execution in EXECUTION_STATUSES, "status:enum", f"unhandled executionStatus: {execution}")
    check(len(set(indices)) == len(indices), "cardinality", "execution outputs must have unique outputIndex values")
    check(all(0 <= index < expected for index in indices), "cardinality", "outputIndex must be within expectedOutputCount")
    check(len(outputs) == expected and set(indices) == set(range(expected)), "cardinality",
          "every execution snapshot must preserve one indexed status per expected output")

    unknown_evidence = provider == "unknown" or "unknown" in statuses
    pending_evidence = provider == "pending" or "pending" in statuses
    dispatched_outputs = any(status in ("pending", "completed", "failed", "cancelled", "unknown")
                             for status in statuses)
    if granularity == "batch" and provider in ("pending", "confirmed", "unknown"):
        check("not_dispatched" not in statuses, "batch",
              "after a batch provider request, an output cannot be claimed not_dispatched")

    # Shared priority: uncertainty first, then actual in-flight work. A gate or
    # terminal label cannot mask either class of evidence.
    if unknown_evidence:
        check(execution == "unknown", "priority:unknown",
              "unknown provider/output evidence has priority over every other aggregate state")
    elif pending_evidence:
        check(execution in ("running", "cancel_requested"), "priority:pending",
              "pending provider/output evidence requires running or cancel_requested")

    if provider == "pending":
        check("pending" in statuses, "receipt:pending-output",
              "pending provider receipt requires a matching pending output")
    if "cancelled" in statuses:
        check(all(item.get("errorCode") == "cancelled" for item in outputs if item["status"] == "cancelled"),
              "output:cancelled", "cancelled output requires errorCode=cancelled")
    if "failed" in statuses:
        check(all(item.get("errorCode") in ("provider_error", "attachment_unavailable")
                  for item in outputs if item["status"] == "failed"),
              "output:failed", "every failed output requires a known failure errorCode")
    if "failed" in statuses and execution in ("running", "cancel_requested"):
        check(data.get("blockedReason") == "prior_paid_failure", "gate:known-failure",
              "known failed output beside in-flight work requires the explicit prior_paid_failure dispatch gate")

    # Every public enum member has one explicit branch. These state-specific
    # assertions are also named in executionStatusCoverage for branch-level QA.
    if execution == "queued":
        check(all(status == "not_dispatched" for status in statuses)
              and provider == "not_applicable", "status:queued",
              "queued requires every output not_dispatched and providerReceiptStatus=not_applicable")
        check("pauseReason" in data, "status:queued", "queued aggregate must state pauseReason")
        check(not data.get("blockedReason") or data.get("pauseReason") != "none", "status:queued",
              "an active blockedReason cannot be described as ordinary pauseReason=none queueing")
    elif execution == "dispatching":
        check("not_dispatched" in statuses and not pending_evidence and not unknown_evidence,
              "status:dispatching", "dispatching requires remaining not_dispatched output and no pending/unknown receipt")
        check(provider in ("not_applicable", "confirmed"), "status:dispatching",
              "dispatching cannot claim an unreceived provider call")
        check(data.get("pauseReason") in (None, "none") and not data.get("blockedReason"),
              "status:dispatching", "dispatching requires an active, unblocked claim; held work remains queued")
        if provider == "confirmed":
            check(granularity == "per_output" and "completed" in statuses
                  and all(status in ("completed", "not_dispatched") for status in statuses),
                  "status:dispatching",
                  "confirmed dispatching may only follow completed per-output outputs; a previous failure/cancellation forbids another claim")
        else:
            check(all(status == "not_dispatched" for status in statuses), "status:dispatching",
                  "without any provider receipt, dispatching outputs must all remain not_dispatched")
    elif execution == "running":
        check("pending" in statuses and provider in ("pending", "confirmed"), "status:running",
              "running requires an actually dispatched pending output and pending/confirmed provider receipt")
    elif execution == "cancel_requested":
        check("pending" in statuses and provider in ("pending", "confirmed"), "status:cancel_requested",
              "cancel_requested requires an actually dispatched pending output; a request alone is not terminal")
    elif execution == "completed":
        check(all(status == "completed" for status in statuses)
              and provider == "confirmed"
              and not data.get("blockedReason"), "status:completed",
              "completed requires every expected output completed, a confirmed provider request receipt, and no active dispatch gate")
    elif execution == "partial":
        known_terminal = all(status in ("completed", "failed", "cancelled", "not_dispatched") for status in statuses)
        has_known_non_success = any(status in ("failed", "cancelled", "not_dispatched") for status in statuses)
        check(known_terminal and "completed" in statuses and has_known_non_success
              and provider == "confirmed" and not data.get("blockedReason"),
              "status:partial",
              "partial requires all known terminal outcomes, a confirmed provider request, at least one success and one known non-success, and no active gate")
    elif execution == "error":
        check("failed" in statuses
              and all(status in ("failed", "cancelled", "not_dispatched") for status in statuses)
              and provider == "confirmed" and not data.get("blockedReason"), "status:error",
              "error requires a confirmed known failure, no success/in-flight/unknown output, and no active gate")
    elif execution == "cancelled":
        check("cancelled" in statuses
              and all(status in ("cancelled", "not_dispatched") for status in statuses)
              and provider in ("confirmed", "not_applicable") and not data.get("blockedReason"),
              "status:cancelled",
              "cancelled requires at least one confirmed cancelled output, no success/failure, and no active gate")
    elif execution == "unknown":
        check(unknown_evidence, "status:unknown", "unknown aggregate needs an unknown provider receipt or output")
        check(provider != "not_applicable", "status:unknown", "unknown dispatched output cannot have providerReceiptStatus=not_applicable")
        if provider == "unknown":
            check(dispatched_outputs, "status:unknown",
                  "unknown provider receipt needs per-output evidence that dispatch may have occurred")
    elif execution == "blocked":
        check(all(status == "not_dispatched" for status in statuses)
              and provider == "not_applicable" and bool(data.get("blockedReason")), "status:blocked",
              "terminal blocked requires every output not_dispatched, no provider receipt, and an active blockedReason")
    elif execution == "denied":
        check(all(status == "not_dispatched" for status in statuses)
              and provider == "not_applicable" and not data.get("blockedReason"), "status:denied",
              "denied requires the persisted denial decision, no provider dispatch, and no active blockedReason")
    else:
        raise AssertionError(f"[status:enum] executionStatus branch was not implemented: {execution}")

    if data.get("requestedSeedPolicy") == "fixed":
        seed = data.get("requestedSeed")
        check(isinstance(seed, int) and not isinstance(seed, bool) and 0 <= seed <= 4294967295,
              "seed", "fixed seed policy requires a uint32 requestedSeed")
    elif data.get("requestedSeedPolicy") == "random":
        check(data.get("requestedSeed") is None, "seed", "random seed policy requires requestedSeed=null")


def validate_reference_participation_case(case):
    """Check reference authorization against synthetic host evidence, not user-event authenticity."""
    before = case.get("before")
    after = case["after"]
    target = case["target"]

    def same_target(binding):
        return (binding is not None
                and binding.get("conversationId") == target.get("conversationId")
                and binding.get("creationId") == target.get("creationId"))

    if case.get("expectedInputRevision") != case.get("currentInputRevision"):
        return False, "cas:revision"
    if after.get("includeInGeneration") is not True:
        return True, "revocation"
    if after.get("role") != "reference" or not same_target(after):
        return False, "authorization:reference-target"

    authorization = case.get("hostAuthorizationEvidence")
    preserve_existing = (
        isinstance(authorization, dict)
        and authorization.get("sourceKind") == "user"
        and bool(authorization.get("eventRef"))
        and before is not None
        and before.get("includeInGeneration") is True
        and before.get("role") == "reference"
        and same_target(before)
        and before.get("attachmentId") == after.get("attachmentId")
        and before.get("attachmentRevision") == after.get("attachmentRevision")
        and before.get("referencePurpose") == after.get("referencePurpose")
        and authorization.get("conversationId") == target.get("conversationId")
        and authorization.get("creationId") == target.get("creationId")
        and authorization.get("attachmentId") == after.get("attachmentId")
        and authorization.get("attachmentRevision") == after.get("attachmentRevision")
        and authorization.get("role") == before.get("role") == after.get("role") == "reference"
        and authorization.get("referencePurpose") == before.get("referencePurpose") == after.get("referencePurpose")
        and authorization.get("authorizationScope") == "include_reference_in_generation"
        and authorization.get("authorizedInputRevision") == case.get("expectedInputRevision")
        and authorization.get("activeAtExpectedRevision") is True
        and authorization.get("revokedAtExpectedRevision") is False
    )
    if preserve_existing:
        return True, "preserve-existing"

    evidence = case.get("hostIntentEvidence")
    exact_user_opt_in = (
        isinstance(evidence, dict)
        and evidence.get("sourceKind") == "user"
        and bool(evidence.get("eventRef"))
        and evidence.get("explicitOptIn") is True
        and evidence.get("userIntentRef") == case.get("userIntentRef")
        and evidence.get("conversationId") == target.get("conversationId")
        and evidence.get("creationId") == target.get("creationId")
        and evidence.get("attachmentId") == after.get("attachmentId")
        and evidence.get("attachmentRevision") == after.get("attachmentRevision")
        and evidence.get("role") == after.get("role") == "reference"
        and evidence.get("referencePurpose") == after.get("referencePurpose")
        and evidence.get("authorizationScope") == "include_reference_in_generation"
        and evidence.get("inputRevision") == case.get("expectedInputRevision")
    )
    if exact_user_opt_in:
        return True, "explicit-opt-in"
    return False, "authorization:missing-exact-opt-in"

def run_mutation_tests(outputs_schema):
    safe_nested = {"type": "object", "additionalProperties": False,
                   "properties": {"nested": {"type": "object", "additionalProperties": False}}}
    require(len(list(walk_objects(safe_nested))) == 2,
            "walk_objects must yield both root and nested object")
    unsafe_nested = copy.deepcopy(safe_nested)
    unsafe_nested["properties"]["nested"]["additionalProperties"] = True
    try:
        list(walk_objects(unsafe_nested))
    except AssertionError:
        pass
    else:
        raise AssertionError("walk_objects mutation failed to detect additionalProperties=true")

    damaged = json.loads(json.dumps(outputs_schema))
    for clause in damaged.get("allOf", []):
        if clause.get("if", {}).get("properties", {}).get("status", {}).get("const") == "completed":
            clause["then"]["required"].remove("hash")
            break
    try:
        assert_completed_output_identity(damaged)
    except AssertionError:
        pass
    else:
        raise AssertionError("completed identity mutation failed to detect a missing hash requirement")
    require(Draft202012Validator(outputs_schema).is_valid({"outputIndex": 0, "status": "pending"}),
            "non-completed output must not require artifact identity")



def validate_reference_purpose(schema, path="$", purposes=("color", "composition", "character", "atmosphere")):
    """Check discriminated reference-purpose rules on nested attachment bindings."""
    if isinstance(schema, dict):
        if schema.get("type") == "object":
            role = schema.get("properties", {}).get("role", {})
            roles = role.get("enum", [])
            if "reference" in roles:
                purpose = schema.get("properties", {}).get("referencePurpose", {})
                require(purpose.get("enum") == list(purposes),
                        f"{path}: referencePurpose must enumerate the four creative purposes")
                if roles == ["reference"]:
                    require("referencePurpose" in schema.get("required", []),
                            f"{path}: reference-only binding must require referencePurpose")
                else:
                    rules = schema.get("allOf", [])
                    require(any(
                        rule.get("if", {}).get("properties", {}).get("role", {}).get("const") == "reference"
                        and "referencePurpose" in rule.get("then", {}).get("required", [])
                        for rule in rules
                    ), f"{path}: role=reference must require referencePurpose")
                    require(any(
                        rule.get("if", {}).get("properties", {}).get("role", {}).get("not", {}).get("const") == "reference"
                        and "referencePurpose" in rule.get("then", {}).get("not", {}).get("required", [])
                        for rule in rules
                    ), f"{path}: non-reference roles must forbid referencePurpose")
                    if "discussion" in roles:
                        require("includeInGeneration" in schema.get("properties", {}),
                                f"{path}: discussion binding must expose includeInGeneration")
                        require(any(
                            rule.get("if", {}).get("properties", {}).get("role", {}).get("const") == "discussion"
                            and rule.get("then", {}).get("properties", {}).get("includeInGeneration", {}).get("const") is False
                            and "includeInGeneration" in rule.get("then", {}).get("required", [])
                            for rule in rules
                        ), f"{path}: discussion must require includeInGeneration=false")
        for key, value in schema.items():
            if isinstance(value, (dict, list)):
                validate_reference_purpose(value, f"{path}.{key}", purposes)
    elif isinstance(schema, list):
        for index, value in enumerate(schema):
            validate_reference_purpose(value, f"{path}[{index}]", purposes)


def assert_registry_derived_contract_summaries(contracts, by_name, group_ids):
    """Require every published summary row to equal the shared registry renderer."""
    sections = re.split(r"(?m)^### `([^`]+)`\s*$", contracts)
    blocks = {sections[index]: sections[index + 1]
              for index in range(1, len(sections), 2)}
    require(set(blocks) == set(by_name),
            "TOOL_CONTRACTS.md must summarize every registered tool exactly once")

    def labeled_line(block, label):
        return re.search(rf"(?m)^\*\*{re.escape(label)}：\*\*.*$", block)

    for name, tool in by_name.items():
        block = blocks[name]
        for label, expected_line in build_summary_lines(tool, group_count=len(group_ids)).items():
            match = labeled_line(block, label)
            require(match is not None and match.group(0) == expected_line,
                    f"{name}: {label} summary must exactly match registry-derived types, required markers, enums, ranges, and metadata")

    capability = by_name["get_capabilities"]
    capability_block = blocks["get_capabilities"]
    model_line = labeled_line(capability_block, "模型入参").group(0)
    result_line = labeled_line(capability_block, "业务结果").group(0)
    require(all(group_id in model_line and group_id in result_line for group_id in group_ids),
            "get_capabilities summary must enumerate all registry groups, not a stale subset")
    requested_groups = capability["inputSchema"]["properties"]["requestedGroups"]
    require(requested_groups.get("maxItems") == 10
            and "≤10" in model_line and "≤10" in result_line
            and f"完整目录共 {len(group_ids)} 组" in model_line,
            "get_capabilities must distinguish the 23-group catalog from the per-call max 10")


def main() -> int:
    registry = load(REGISTRY_PATH)
    fixtures = load(FIXTURE_PATH)
    require(registry.get("designState") == "design-only", "registry must be explicitly design-only")
    require(registry.get("registryVersion") == "2.0.0",
            "R4 adds/deletes no fields but tightens cancel conditional branches; 2.0.0 is retained only for this unimplemented design snapshot")
    require(registry.get("toolCount") == len(EXPECTED), "toolCount must match expected catalog")
    tools = registry.get("tools")
    require(isinstance(tools, list), "tools must be an array")
    names = [tool.get("canonical") for tool in tools]
    require(names == EXPECTED, f"canonical order/list mismatch: {names}")
    require(len(set(names)) == len(names), "canonical names must be unique")
    by_name = {tool["canonical"]: tool for tool in tools}
    require(all(tool.get("schemaVersion") == registry["registryVersion"] for tool in tools),
            "every tool schemaVersion must match the R3 major registry version")

    # The request enum, returned group enum, availability.group values, and
    # canonical memberships all derive from one machine-readable group catalog.
    group_catalog = registry.get("groupCatalog", [])
    group_ids = [entry.get("groupId") for entry in group_catalog]
    require(len(group_ids) == len(set(group_ids)), "groupCatalog IDs must be unique")
    require(set(group_ids) == {tool["availability"]["group"] for tool in tools},
            "groupCatalog must cover exactly the availability groups")
    for entry in group_catalog:
        expected_members = [tool["canonical"] for tool in tools
                            if tool["availability"]["group"] == entry["groupId"]]
        require(entry.get("canonicalTools") == expected_members,
                f"{entry['groupId']}: group mapping must list its canonical tools exactly")
    capability = by_name["get_capabilities"]
    require(capability["availability"].get("exposure") == "always_on",
            "get_capabilities must be the always-on discovery entry point")
    require("始终挂载" in capability["availability"].get("when", "")
            and "按需调用" in capability["availability"].get("when", "")
            and "不要求每轮" in capability["availability"].get("when", ""),
            "always-on means mounted continuously, while invocation remains on demand")
    requested_enum = capability["inputSchema"]["properties"]["requestedGroups"]["items"].get("enum")
    result_data_props = capability["resultSchema"]["properties"]["data"]["properties"]
    require(requested_enum == group_ids
            and result_data_props["requestedGroups"]["items"].get("enum") == group_ids
            and result_data_props["available"]["items"]["properties"]["group"].get("enum") == group_ids
            and result_data_props["requestedDenied"]["items"]["properties"]["group"].get("enum") == group_ids,
            "requested groups and returned group IDs must use the single groupCatalog mapping")

    defs = registry.get("$defs", {})
    for definition_name, definition in defs.items():
        Draft202012Validator.check_schema(definition)
        tuple(walk_objects(definition, f"$defs.{definition_name}"))
    image_submission_tools = ("generate_image", "redraw_image", "inpaint_image", "upscale_image", "process_image")
    expected_context = set(defs.get("ExecutionSubmissionContext", {}).get("properties", {}))
    require(expected_context, "ExecutionSubmissionContext must be a concrete host-only schema")
    for name in image_submission_tools:
        tool = by_name[name]
        require(tool.get("hostContextRef") == "#/$defs/ExecutionSubmissionContext",
                f"{name}: must reference the shared ExecutionSubmissionContext")
        require(set(tool["hostInjectedFields"]) == expected_context,
                f"{name}: host injected fields must match the shared context exactly")

    scoped_tools = set(registry.get("catalogPolicy", {}).get("targetSelection", {}).get("appliesTo", []))
    require(scoped_tools == set(registry.get("modelTargetReferences", {}).get("appliesTo", scoped_tools)),
            "model target reference lists must agree")
    for name, tool in by_name.items():
        for field in (
            "schemaVersion", "inputSchema", "resultSchema", "availability", "effect",
            "approval", "cost", "legacyHandler", "fieldMappings", "errors",
            "modelFields", "hostInjectedFields",
        ):
            require(field in tool, f"{name}: missing {field}")
        require(tool["modelFields"] == list(tool["inputSchema"].get("properties", {})),
                f"{name}: modelFields must match flat inputSchema properties")
        require(not set(tool["modelFields"]).intersection(tool["hostInjectedFields"]),
                f"{name}: modelFields and hostInjectedFields overlap")
        mapped_host_fields = set(tool["fieldMappings"].get("hostInjected", {}))
        require(mapped_host_fields == set(tool["hostInjectedFields"]),
                f"{name}: hostInjectedFields and fieldMappings.hostInjected must match exactly")
        context_ref = tool.get("hostContextRef")
        if context_ref:
            require(context_ref.startswith("#/$defs/") and context_ref.rsplit("/", 1)[-1] in defs,
                    f"{name}: hostContextRef must resolve to a registry $defs schema")
        if name in scoped_tools:
            props = tool["inputSchema"].get("properties", {})
            require("targetConversationId" in props and "targetCreationId" in props,
                    f"{name}: scoped tool needs optional target pair")
            require("targetConversationId" not in tool["hostInjectedFields"]
                    and "targetCreationId" not in tool["hostInjectedFields"],
                    f"{name}: model target refs must not be marked host-only")
            require("allowedTargetScopes" in tool["hostInjectedFields"],
                    f"{name}: host must validate against allowedTargetScopes")
            all_of = tool["inputSchema"].get("allOf", [])
            require(any(x.get("if", {}).get("required") == ["targetConversationId"]
                        and x.get("then", {}).get("required") == ["targetCreationId"] for x in all_of),
                    f"{name}: targetConversationId must require targetCreationId")
            require(any(x.get("if", {}).get("required") == ["targetCreationId"]
                        and x.get("then", {}).get("required") == ["targetConversationId"] for x in all_of),
                    f"{name}: targetCreationId must require targetConversationId")
        for schema_name in ("inputSchema", "resultSchema"):
            schema = tool[schema_name]
            require(schema.get("$schema") == DRAFT, f"{name}.{schema_name}: wrong JSON Schema dialect")
            require(schema.get("type") == "object", f"{name}.{schema_name}: root must be object")
            require(schema.get("additionalProperties") is False,
                    f"{name}.{schema_name}: root must reject unknown fields")
            Draft202012Validator.check_schema(schema)
            tuple(walk_objects(schema, f"{name}.{schema_name}"))

        result_schema = tool["resultSchema"]
        require(result_schema["properties"].get("resultKind", {}).get("enum")
                == ["business", "preflight_failure"],
                f"{name}: resultKind must distinguish business from preflight failure")
        require(result_schema.get("required") == ["resultKind"],
                f"{name}: only the result discriminator is unconditionally required")
        business_branch = next((clause for clause in result_schema.get("allOf", [])
                                if clause.get("if", {}).get("properties", {}).get("resultKind", {}).get("const") == "business"), None)
        preflight_branch = next((clause for clause in result_schema.get("allOf", [])
                                 if clause.get("if", {}).get("properties", {}).get("resultKind", {}).get("const") == "preflight_failure"), None)
        require(business_branch is not None and "data" in business_branch.get("then", {}).get("required", [])
                and set(business_branch.get("then", {}).get("properties", {}).get("status", {}).get("enum", []))
                    == {"accepted", "completed", "denied", "cancelled", "blocked", "error"},
                f"{name}: business results must preserve data for real post-dispatch outcomes")
        require(preflight_branch is not None
                and "error" in preflight_branch.get("then", {}).get("required", [])
                and "data" in preflight_branch.get("then", {}).get("not", {}).get("required", [])
                and preflight_branch.get("then", {}).get("properties", {}).get("status", {}).get("enum")
                == ["denied", "cancelled", "blocked", "error"],
                f"{name}: preflight failures require an error envelope and forbid data")

        require(bool(tool["errors"]), f"{name}: errors cannot be empty")
        for error in tool["errors"]:
            require(error.get("code"), f"{name}: error missing code")
            require(error.get("allowedActions"), f"{name}: error missing allowedActions")
        require(isinstance(tool["fieldMappings"], dict), f"{name}: fieldMappings must be an object")
        validate_reference_purpose(tool["inputSchema"], f"{name}.inputSchema")
        validate_reference_purpose(tool["resultSchema"], f"{name}.resultSchema")

    # Contract-critical state and capability fields.
    input_version = registry.get("catalogPolicy", {}).get("executionInputVersion", "")
    require(all(token in input_version for token in (
        "OriginalMessageSnapshot", "TurnEffectiveInputSnapshot", "prepare/approval/enqueue",
        "frozenInputRevision", "Later UI edits"
    )), "executionInputVersion must preserve the three-stage frozen-input sequence")
    prepare_host_map = by_name["prepare_generation"]["fieldMappings"]["hostInjected"]
    require("TurnEffectiveInputSnapshot.effectiveInputRevision" in prepare_host_map.get("frozenInputRevision", "")
            and "preserving the original" in input_version,
            "three-stage snapshot summary must agree with the existing accurate host mapping")
    state = by_name["read_generation_state"]["resultSchema"]["properties"]["data"]["properties"]
    for field in ("draftId", "draftRevision", "inputRevision"):
        require(field in state, f"read_generation_state must expose {field}")
    creation_data = by_name["read_creation"]["resultSchema"]["properties"]["data"]
    creation_ok = next((clause for clause in creation_data.get("allOf", [])
                        if clause.get("if", {}).get("properties", {}).get("readStatus", {}).get("const") == "ok"), None)
    require(creation_ok is not None and "references" in creation_ok.get("then", {}).get("required", []),
            "read_creation success must return the complete references array, including empty arrays")
    creation_refs = creation_data["properties"]["references"]["items"]
    require({"edit_source", "mask"}.issubset(set(creation_refs["properties"]["role"].get("enum", []))),
            "read_creation references must represent edit_source and mask bindings")
    patch_input = by_name["patch_creation_inputs"]["inputSchema"]
    require("referencePurpose" in patch_input["properties"]
            and "referencePurpose" in by_name["patch_creation_inputs"]["modelFields"],
            "patch_creation_inputs must expose model referencePurpose as a flat field")
    caps = by_name["get_capabilities"]["inputSchema"]["properties"]
    require("requestedGroups" in caps, "get_capabilities must support requestedGroups")
    for field in ("catalogVersion", "available", "mounted", "requestedDenied"):
        require(field in by_name["get_capabilities"]["resultSchema"]["properties"]["data"]["properties"],
                f"get_capabilities must return {field}")

    # The execution output must be a directly reusable, scoped attachment.
    outputs = by_name["get_execution"]["resultSchema"]["properties"]["data"]["properties"]["outputs"]["items"]
    for field in ATTACHMENT_IDENTITY:
        require(field in outputs["properties"], f"execution output missing {field}")
    completed_branch = next(
        (clause for clause in outputs.get("allOf", [])
         if clause.get("if", {}).get("properties", {}).get("status", {}).get("const") == "completed"),
        None,
    )
    require(completed_branch is not None, "completed outputs must require the reusable attachment tuple")
    assert_completed_output_identity(outputs)
    require({"type": "null"} in outputs["properties"]["parentAttachmentId"].get("anyOf", []),
            "parentAttachmentId must allow null for an original generation")
    execution_statuses = by_name["get_execution"]["resultSchema"]["properties"]["data"]["properties"]["executionStatus"]["enum"]
    require(tuple(execution_statuses) == EXECUTION_STATUSES,
            "execution semantic validator must cover every public executionStatus in enum order")
    aggregate_contract = registry.get("semanticContracts", {}).get("executionAggregate", {})
    require("every readStatus=ok" in aggregate_contract.get("outputCardinality", "")
            and "expectedOutputCount" in aggregate_contract.get("outputCardinality", "")
            and "unknown" in aggregate_contract.get("unknownPriority", "")
            and "pending" in aggregate_contract.get("inFlightPriority", "")
            and "durable dispatcher claim" in aggregate_contract.get("dispatching", "")
            and "not expressible or verified" in aggregate_contract.get("dispatching", "")
            and "blockedReason" in aggregate_contract.get("dispatchGate", "")
            and "providerReceiptStatus=not_applicable" in aggregate_contract.get("blocked", "")
            and "providerReceiptStatus=not_applicable" in aggregate_contract.get("denied", "")
            and "persisted authorization-denial decision" in aggregate_contract.get("zeroSuccess", "")
            and "not independently prove" in aggregate_contract.get("denialEvidenceLimit", "")
            and "failed" in aggregate_contract.get("zeroSuccess", "")
            and "cancelled" in aggregate_contract.get("cancelledOutput", "")
            and "Cancellation intent" in aggregate_contract.get("cancelIntent", "")
            and "not_sent" in aggregate_contract.get("cancelIntent", "")
            and "pending" in aggregate_contract.get("cancelIntent", "")
            and "unknown" in aggregate_contract.get("cancelIntent", "")
            and "none" in aggregate_contract.get("queued", ""),
            "execution semantic contract must define priorities, host claim limits, terminal evidence, and dispatch-gate separation")
    require("only" in aggregate_contract.get("dispatching", "")
            and "completed" in aggregate_contract.get("dispatching", "")
            and "failed" in aggregate_contract.get("dispatching", "")
            and "cancelled" in aggregate_contract.get("dispatching", "")
            and "providerReceiptStatus=confirmed" in aggregate_contract.get("completed", "")
            and "not_applicable" in aggregate_contract.get("completed", "")
            and "providerReceiptStatus=confirmed" in aggregate_contract.get("partial", "")
            and "Every output" in aggregate_contract.get("failedOutput", "")
            and "prior_paid_failure" in aggregate_contract.get("failedOutput", "")
            and "unknown_prior_receipt" in aggregate_contract.get("dispatchGate", ""),
            "aggregate contract must forbid post-failure/cancel dispatch, require provider receipts for successes, and name the known-failure gate")
    execution_data_props = by_name["get_execution"]["resultSchema"]["properties"]["data"]["properties"]
    require("prior_paid_failure" in execution_data_props["blockedReason"].get("enum", []),
            "get_execution.blockedReason must represent a known prior paid failure without mislabeling it unknown")

    reference_contract = registry.get("semanticContracts", {}).get("referenceParticipation", {})
    require("requested state" in reference_contract.get("requestedValueIsNotAuthorization", "")
            and "expectedInputRevision" in reference_contract.get("preserveExisting", "")
            and ("no revocation" in reference_contract.get("preserveExisting", "")
                 or "unrevoked" in reference_contract.get("preserveExisting", ""))
            and "purpose-only" in reference_contract.get("preserveExisting", "")
            and "referencePurpose" in reference_contract.get("preserveExisting", "")
            and "same userIntentRef" in reference_contract.get("explicitOptIn", "")
            and "exact reference" in reference_contract.get("explicitOptIn", "")
            and "role change" in reference_contract.get("roleChange", "")
            and "cannot authenticate" in reference_contract.get("evidenceLimit", ""),
            "reference participation contract must distinguish requested value, preserved authorization, explicit opt-in, and offline evidence limits")
    reference_policy = registry.get("catalogPolicy", {}).get("referencePolicy", "")
    require("includeInGeneration=true is a requested state" in reference_policy
            and "same userIntentRef" in reference_policy
            and "purpose change alone does not authorize" in reference_policy,
            "catalogPolicy.referencePolicy must state that participation permission is host-verified")
    patch_tool = by_name["patch_creation_inputs"]
    patch_host = patch_tool["fieldMappings"].get("hostInjected", {})
    patch_constraints = patch_tool.get("catalogConstraints", [])
    require("permission" not in patch_tool["inputSchema"].get("properties", {})
            and "permission" not in patch_tool.get("modelFields", [])
            and "original user event" in patch_host.get("userIntentRef", "")
            and any("purpose change alone does not authorize" in item for item in patch_constraints)
            and any("same userIntentRef" in item for item in patch_constraints),
            "patch reference authorization must stay host-only and preserve explicit user-event scope rules")
    for name in ("prepare_generation", "redraw_image", "inpaint_image"):
        schema = by_name[name]["inputSchema"]
        clauses = schema.get("allOf", [])
        fixed = any(
            clause.get("if", {}).get("properties", {}).get("requestedSeedPolicy", {}).get("const") == "fixed"
            and "requestedSeedPolicy" in clause.get("if", {}).get("required", [])
            and "requestedSeed" in clause.get("then", {}).get("required", [])
            for clause in clauses
        )
        random = any(
            clause.get("if", {}).get("properties", {}).get("requestedSeedPolicy", {}).get("const") == "random"
            and "requestedSeedPolicy" in clause.get("if", {}).get("required", [])
            and clause.get("then", {}).get("not", {}).get("required") == ["requestedSeed"]
            for clause in clauses
        )
        supplied = any(
            clause.get("if", {}).get("required") == ["requestedSeed"]
            and clause.get("then", {}).get("properties", {}).get("requestedSeedPolicy", {}).get("const") == "fixed"
            for clause in clauses
        )
        require(fixed and random and supplied,
                f"{name}: fixed/random/requested seed conditions must be mutually consistent")
    seed_source = outputs["properties"]["resolvedSeedSource"]
    require({"type": "null"} in seed_source.get("anyOf", []),
            "unverified output seed provenance must allow null")
    require({"provider", "verified_embedded"}.issubset(
                set(next((branch.get("enum", []) for branch in seed_source.get("anyOf", [])
                          if isinstance(branch, dict) and branch.get("enum")), []))),
            "output seed provenance must identify provider or verified embedded metadata")
    require("resolvedSeed" in completed_branch.get("then", {}).get("required", [])
            and "resolvedSeedSource" in completed_branch.get("then", {}).get("required", []),
            "each completed output must carry its own actual seed and provenance")

    emotion_branch = next((branch for branch in by_name["process_image"]["inputSchema"].get("oneOf", [])
                           if branch.get("properties", {}).get("operation", {}).get("const") == "emotion"), None)
    require(emotion_branch is not None and {"operation", "emotion"}.issubset(
                set(emotion_branch.get("required", []))),
            "process_image emotion branch must require a discriminating emotion value")

    patch = by_name["patch_creation_inputs"]
    patch_input = patch["inputSchema"]
    clear_branch = next((branch for branch in patch_input.get("oneOf", [])
                         if branch.get("properties", {}).get("action", {}).get("const") == "clear_edit_source"), None)
    require(clear_branch is not None and "attachmentId" in clear_branch.get("not", {}).get("anyOf", [])[0].get("required", []),
            "clear_edit_source must remain a narrow action with an optional expectedAttachmentId only")
    patch_data = patch["resultSchema"]["properties"]["data"]["properties"]
    require(set(("beforeRefs", "afterRefs", "actionId", "inputRevision", "undo")).issubset(
                set(patch["resultSchema"]["properties"]["data"]["required"])),
            "patch_creation_inputs must return a complete reversible change set")
    undo_schema = next((branch for branch in patch_data["undo"]["anyOf"]
                        if isinstance(branch, dict) and branch.get("type") == "object"), None)
    require(undo_schema is not None and {"affectedAttachmentIds", "restoreRefs", "expectedInputRevision"}.issubset(
                set(undo_schema.get("required", []))),
            "patch undo must support multi-attachment CAS restoration")

    # Every result-side object that exposes an image attachment must expose its full stable identity.
    for name, tool in by_name.items():
        for _, schema_obj in walk_objects(tool["resultSchema"], f"{name}.resultSchema"):
            props = schema_obj.get("properties", {})
            if "artifactId" in props and "attachmentId" in props:
                completed_conditional = any(
                    clause.get("if", {}).get("properties", {}).get("status", {}).get("const") == "completed"
                    for clause in schema_obj.get("allOf", [])
                )
                if completed_conditional:
                    assert_completed_output_identity(schema_obj)
                else:
                    required = set(schema_obj.get("required", []))
                    require(set(ATTACHMENT_IDENTITY).issubset(required),
                            f"{name}: attachment record does not require the full identity tuple")
                require({"type": "null"} in props["parentAttachmentId"].get("anyOf", []),
                        f"{name}: parentAttachmentId must allow null")

    run_mutation_tests(outputs)

    target_policy = registry.get("catalogPolicy", {}).get("targetSelection", {})
    require(target_policy.get("default") == "缺省使用用户发送该消息时冻结的 message/card target，不读取 UI active。",
            "target default must be the frozen message target, never current UI active")
    require("allowedTargetScopes" in registry.get("catalogPolicy", {}).get("hostInjected", ""),
            "hostInjected policy must distinguish allowed target scope from model refs")
    purpose_policy = registry.get("catalogPolicy", {}).get("referencePurposePolicy", {})
    require(purpose_policy.get("values") == ["color", "composition", "character", "atmosphere"]
            and purpose_policy.get("requiredWhenRole") == "reference"
            and purpose_policy.get("isProviderCapability") is False
            and purpose_policy.get("discussionIncludeInGeneration") is False
            and "host must independently verify" in purpose_policy.get("hostCapabilityCheck", ""),
            "referencePurpose must remain semantic metadata with independent host capability validation")
    reference_policy = registry.get("catalogPolicy", {}).get("referencePolicy", "")
    patch_reference_rules = registry.get("semanticContracts", {}).get("referenceParticipation", {})
    patch_tool = by_name["patch_creation_inputs"]
    patch_reference_constraints = " ".join(patch_tool.get("catalogConstraints", []))
    require("role=reference is classification, not consent" in reference_policy
            and "referencePurpose" in reference_policy
            and "active, unrevoked" in patch_reference_rules.get("preserveExisting", "")
            and "authorization" in patch_reference_rules.get("preserveExisting", "")
            and "referencePurpose" in patch_reference_rules.get("preserveExisting", "")
            and "new purpose" in patch_reference_rules.get("explicitOptIn", "")
            and "role=reference is classification, not consent" in patch_reference_constraints
            and "referencePurpose" in patch_reference_constraints,
            "reference participation must bind preserved grants and explicit opt-ins to exact purpose; role is not consent")
    for name in ("cancel_execution", "propose_memory", "delete_memory_candidate"):
        cost = by_name[name]["cost"]
        require(cost.get("paid") is False and cost.get("mayCharge") is False
                and cost.get("chargeKinds") == [], f"{name}: local/cancel tool must not claim a new service charge")
    image_submission_tools = ("generate_image", "redraw_image", "inpaint_image", "upscale_image", "process_image")
    for name in image_submission_tools:
        clauses = by_name[name]["resultSchema"].get("allOf", [])
        accepted_outer = any(
            clause.get("if", {}).get("properties", {}).get("status", {}).get("const") == "accepted"
            and clause.get("then", {}).get("properties", {}).get("data", {}).get("properties", {})
                .get("submissionStatus", {}).get("const") == "accepted"
            for clause in clauses
        )
        accepted_inner = any(
            clause.get("if", {}).get("properties", {}).get("data", {}).get("properties", {})
                .get("submissionStatus", {}).get("const") == "accepted"
            and clause.get("then", {}).get("properties", {}).get("status", {}).get("const") == "accepted"
            for clause in clauses
        )
        require(accepted_outer and accepted_inner,
                f"{name}: queued image submission must use matching outer/data accepted status")

    cancel_data = by_name["cancel_execution"]["resultSchema"]["properties"]["data"]
    require("executionStatus" not in cancel_data.get("required", [])
            and "receiptRevision" not in cancel_data.get("required", []),
            "cancel_execution must allow not_found without fabricated phase/revision")
    cancel_branches = cancel_data.get("allOf", [])
    not_found_branch = next((clause for clause in cancel_branches
                             if clause.get("if", {}).get("properties", {}).get("cancelDisposition", {}).get("const") == "not_found"), None)
    terminal_branch = next((clause for clause in cancel_branches
                            if clause.get("if", {}).get("properties", {}).get("cancelDisposition", {}).get("const") == "already_terminal"), None)
    requested_branch = next((clause for clause in cancel_branches
                             if clause.get("if", {}).get("properties", {}).get("cancelDisposition", {}).get("const") == "requested"), None)
    require(not_found_branch is not None
            and not_found_branch.get("then", {}).get("properties", {}).get("providerCancellation", {}).get("const") == "not_sent"
            and {"executionStatus", "receiptRevision"}.issubset(
                {field for condition in not_found_branch.get("then", {}).get("not", {}).get("anyOf", [])
                 for field in condition.get("required", [])}),
            "cancel not_found must return providerCancellation=not_sent with no phase/revision")
    terminal_states = {"completed", "partial", "error", "cancelled", "blocked", "denied"}
    require(terminal_branch is not None
            and set(terminal_branch.get("then", {}).get("properties", {}).get("executionStatus", {}).get("enum", [])) == terminal_states,
            "already_terminal must be restricted to actual terminal execution states")
    requested_states = set(requested_branch.get("then", {}).get("properties", {})
                           .get("executionStatus", {}).get("enum", [])) if requested_branch else set()
    dispatch_cancel_branch = next((clause for clause in cancel_branches
                                   if clause.get("if", {}).get("properties", {}).get("cancelDisposition", {}).get("const") == "requested"
                                   and clause.get("if", {}).get("properties", {}).get("executionStatus", {}).get("const") == "dispatching"), None)
    inflight_cancel_branch = next((clause for clause in cancel_branches
                                   if clause.get("if", {}).get("properties", {}).get("cancelDisposition", {}).get("const") == "requested"
                                   and clause.get("if", {}).get("properties", {}).get("executionStatus", {}).get("enum") == ["cancel_requested"]), None)
    not_cancellable_branch = next((clause for clause in cancel_branches
                                   if clause.get("if", {}).get("properties", {}).get("cancelDisposition", {}).get("const") == "not_cancellable"), None)
    not_cancellable_states = set(not_cancellable_branch.get("then", {}).get("properties", {})
                                 .get("executionStatus", {}).get("enum", [])) if not_cancellable_branch else set()
    require(requested_branch is not None
            and requested_states == {"dispatching", "cancel_requested", "cancelled", "unknown"},
            "requested cancellation must preserve dispatching/cancel_requested/cancelled/unknown without claiming running")
    require(not_cancellable_branch is not None
            and not_cancellable_branch.get("then", {}).get("properties", {}).get("executionStatus", {}).get("enum")
                == ["running", "cancel_requested", "unknown"]
            and not_cancellable_states == {"running", "cancel_requested", "unknown"},
            "not_cancellable is limited to running/cancel_requested/unknown; queued and dispatching use host CAS/intent")
    requested_cancelled_branch = next((clause for clause in cancel_branches
                                       if clause.get("if", {}).get("properties", {}).get("cancelDisposition", {}).get("const") == "requested"
                                       and clause.get("if", {}).get("properties", {}).get("executionStatus", {}).get("const") == "cancelled"), None)
    requested_unknown_branch = next((clause for clause in cancel_branches
                                     if clause.get("if", {}).get("properties", {}).get("cancelDisposition", {}).get("const") == "requested"
                                     and clause.get("if", {}).get("properties", {}).get("executionStatus", {}).get("const") == "unknown"), None)
    require(requested_cancelled_branch is not None
            and set(requested_cancelled_branch.get("then", {}).get("properties", {}).get("providerCancellation", {}).get("enum", []))
                == {"not_sent", "confirmed"}
            and requested_unknown_branch is not None
            and requested_unknown_branch.get("then", {}).get("properties", {}).get("providerCancellation", {}).get("const") == "unknown",
            "requested/cancelled permits only local-not-sent or confirmed provider cancellation; unknown execution remains unknown")
    requested_cancel_requested_branch = next((clause for clause in cancel_branches
                                              if clause.get("if", {}).get("properties", {}).get("cancelDisposition", {}).get("const") == "requested"
                                              and clause.get("if", {}).get("properties", {}).get("executionStatus", {}).get("enum") == ["cancel_requested"]), None)
    require(requested_cancel_requested_branch is not None
            and set(requested_cancel_requested_branch.get("then", {}).get("properties", {}).get("providerCancellation", {}).get("enum", []))
                == {"requested", "unsupported", "unknown"}
            and not_cancellable_branch.get("then", {}).get("properties", {}).get("providerCancellation", {}).get("enum")
                == ["unsupported", "unknown"],
            "cancel_requested and not_cancellable provider-outcome pairings must stay explicit; not_cancellable cannot claim not_sent")
    require(dispatch_cancel_branch is not None
            and dispatch_cancel_branch.get("then", {}).get("properties", {}).get("providerCancellation", {}).get("const") == "not_sent"
            and inflight_cancel_branch is not None
            and set(inflight_cancel_branch.get("then", {}).get("properties", {}).get("providerCancellation", {}).get("enum", []))
                == {"requested", "unsupported", "unknown"},
            "dispatching cancellation must only persist host intent; provider cancellation is allowed only after pending evidence")

    prepare_preview = next(
        (branch for branch in by_name["prepare_generation"]["resultSchema"]["properties"]["data"]
         ["properties"]["preview"]["anyOf"] if isinstance(branch, dict) and branch.get("type") == "object"),
        None,
    )
    require(prepare_preview is not None, "prepared generation must expose a preview object")
    preview_seed_rules = prepare_preview.get("allOf", [])
    fixed_preview = next((rule for rule in preview_seed_rules
                          if rule.get("if", {}).get("properties", {}).get("requestedSeedPolicy", {}).get("const") == "fixed"), None)
    random_preview = next((rule for rule in preview_seed_rules
                           if rule.get("if", {}).get("properties", {}).get("requestedSeedPolicy", {}).get("const") == "random"), None)
    require(fixed_preview is not None
            and fixed_preview.get("then", {}).get("properties", {}).get("requestedSeed", {}).get("type") == "integer",
            "fixed-seed preview must return a non-null requestedSeed")
    require(random_preview is not None
            and random_preview.get("then", {}).get("properties", {}).get("requestedSeed", {}).get("const", "missing") is None,
            "random-seed preview must return requestedSeed=null, not omit it")

    templates = by_name["manage_prompt_templates"]
    require(templates.get("approvalByAction") == {
        "read": "none", "select": "none", "save": "existing_confirm_auto", "restore": "existing_confirm_auto"
    }, "manage_prompt_templates must distinguish read/select from write approval")

    require(fixtures.get("fixtureVersion") == "2.0.0"
            and fixtures.get("registryVersion") == registry["registryVersion"],
            "fixture corpus must declare its own major format and exact registry version")
    fixture_cases = fixtures.get("fixtures")
    require(isinstance(fixture_cases, list), "fixtures must be an array")
    checked = 0
    for case in fixture_cases:
        name = case.get("tool")
        require(name in by_name, f"{case.get('id')}: unknown tool {name}")
        require(case.get("schemaVersion") == by_name[name]["schemaVersion"],
                f"{case.get('id')}: fixture must be pinned to the tool schemaVersion")
        schema_name = "inputSchema" if case.get("target") == "input" else "resultSchema"
        schema = by_name[name][schema_name]
        validator = Draft202012Validator(schema)
        errors = list(validator.iter_errors(case.get("instance")))
        valid = not errors
        require(valid is case.get("valid"),
                f"{case.get('id')}: expected valid={case.get('valid')}, got {valid}; "
                + ("; ".join(error.message for error in errors[:3]) if errors else ""))
        if valid and case.get("tool") == "get_execution" and case.get("target") == "result" \
                and case["instance"].get("resultKind") == "business":
            validate_execution_semantics(case["instance"]["data"])
        checked += 1

    # Require explicit four-case coverage for every registered tool, not merely
    # a large fixture count concentrated on a handful of schemas.
    coverage = fixtures.get("coverage", {})
    coverage_rows = coverage.get("tools", [])
    require(coverage.get("count") == len(EXPECTED) and len(coverage_rows) == len(EXPECTED),
            "coverage table must explicitly include all 36 tools")
    fixture_by_id = {case.get("id"): case for case in fixture_cases}
    for row in coverage_rows:
        name = row.get("tool")
        require(name in by_name, f"coverage table contains unknown tool {name}")
        require(row.get("schemaVersion") == by_name[name]["schemaVersion"],
                f"{name}: coverage row must name the tool schemaVersion")
        for key, target, expected_valid in (
            ("minimumValidInputFixture", "input", True),
            ("invalidBoundaryFixture", "input", False),
            ("normalBusinessResultFixture", "result", True),
            ("preflightErrorFixture", "result", True),
        ):
            case = fixture_by_id.get(row.get(key))
            require(case is not None and case.get("tool") == name and case.get("target") == target
                    and case.get("valid") is expected_valid,
                    f"{name}: missing explicit {key} coverage")
        preflight = fixture_by_id[row["preflightErrorFixture"]]["instance"]
        require(preflight.get("resultKind") == "preflight_failure" and "data" not in preflight,
                f"{name}: preflight case must not fabricate business data")

    semantic_cases = fixtures.get("semanticCases", [])
    require(semantic_cases, "cross-output execution semantics need focused cases")
    for case in semantic_cases:
        require(case.get("schemaVersion") == by_name["get_execution"]["schemaVersion"],
                f"{case['id']}: semantic case must be pinned to get_execution schemaVersion")
        instance = case["instance"]
        schema_ok = Draft202012Validator(by_name["get_execution"]["resultSchema"]).is_valid(instance)
        require(schema_ok is case["schemaValid"],
                f"{case['id']}: unexpected JSON Schema result {schema_ok}")
        semantic_ok = schema_ok
        rejection = None
        if schema_ok:
            try:
                validate_execution_semantics(instance["data"])
            except AssertionError as error:
                semantic_ok = False
                rejection = str(error)
        require(semantic_ok is case["semanticValid"],
                f"{case['id']}: expected semanticValid={case['semanticValid']}, got {semantic_ok}")
        if case.get("expectedRejectRule"):
            require(rejection is not None and rejection.startswith(case["expectedRejectRule"]),
                    f"{case['id']}: expected semantic rejection at {case['expectedRejectRule']}, got {rejection}")

    cancel_coverage = fixtures.get("cancelResultCoverage", {})
    cancel_rows = cancel_coverage.get("dispositions", [])
    require([row.get("cancelDisposition") for row in cancel_rows]
            == ["requested", "already_terminal", "not_cancellable", "not_found"],
            "cancelResultCoverage must enumerate every cancelDisposition in registry order")
    mapped_cancel_ids = {case_id for row in cancel_rows for key in ("validCases", "invalidCases")
                         for case_id in row.get(key, [])}
    business_cancel_ids = {case.get("id") for case in fixture_cases
                           if case.get("tool") == "cancel_execution" and case.get("target") == "result"
                           and "cancelDisposition" in case.get("instance", {}).get("data", {})}
    require(mapped_cancel_ids == business_cancel_ids,
            "every cancel_execution business-result fixture must be assigned to a disposition coverage row")
    not_sent_not_cancellable = fixture_by_id.get("cancel-not-cancellable-running-not-sent-invalid")
    require(not_sent_not_cancellable is not None
            and not_sent_not_cancellable.get("valid") is False
            and not_sent_not_cancellable.get("instance", {}).get("data", {}).get("executionStatus") == "running"
            and not_sent_not_cancellable.get("instance", {}).get("data", {}).get("providerCancellation") == "not_sent",
            "not_cancellable+not_sent needs a targeted running-state counterexample")
    for row in cancel_rows:
        disposition = row["cancelDisposition"]
        for key, expected_valid in (("validCases", True), ("invalidCases", False)):
            case_ids = row.get(key, [])
            require(case_ids, f"cancelDisposition={disposition} needs {key}")
            for case_id in case_ids:
                case = fixture_by_id.get(case_id)
                require(case is not None and case.get("tool") == "cancel_execution"
                        and case.get("target") == "result" and case.get("valid") is expected_valid
                        and case.get("instance", {}).get("data", {}).get("cancelDisposition") == disposition,
                        f"{disposition}: {key} must point to a matching cancel_execution result fixture")

    reference_cases = fixtures.get("referenceParticipationCases", [])
    require(len(reference_cases) == 8,
            "reference participation needs synthetic host-context positives and authorization-denial cases")
    expected_reference_ids = {
        "reference-preserve-existing-active-permission-same-binding-and-purpose-valid",
        "reference-existing-grant-does-not-carry-purpose-change-invalid",
        "reference-purpose-change-explicit-same-intent-opt-in-valid",
        "reference-role-change-without-opt-in-invalid",
        "reference-chat-opt-in-wrong-purpose-invalid",
        "reference-chat-opt-in-wrong-target-invalid",
        "reference-role-change-to-discussion-revokes-valid",
        "reference-stale-revision-denies-even-explicit-opt-in",
    }
    require({case.get("id") for case in reference_cases} == expected_reference_ids,
            "reference host-context cases must preserve the exact expected purpose/authorization coverage set")
    for case in reference_cases:
        allowed, rule = validate_reference_participation_case(case)
        require(allowed is case.get("expectedAllowed"),
                f"{case['id']}: expected host-context allowed={case.get('expectedAllowed')}, got {allowed} ({rule})")
        require(rule == case.get("expectedRule"),
                f"{case['id']}: expected host-context rule={case.get('expectedRule')}, got {rule}")

    status_coverage = fixtures.get("executionStatusCoverage", {})
    status_rows = status_coverage.get("statuses", [])
    require(status_coverage.get("statusEnum") == execution_statuses
            and [row.get("executionStatus") for row in status_rows] == execution_statuses,
            "executionStatusCoverage must include every enum value exactly once and in registry order")
    semantic_by_id = {case.get("id"): case for case in semantic_cases}
    for row in status_rows:
        status = row["executionStatus"]
        for coverage_key, expected_semantic in (("validCase", True), ("invalidCase", False)):
            case = semantic_by_id.get(row.get(coverage_key))
            require(case is not None and case.get("schemaValid") is True
                    and case.get("semanticValid") is expected_semantic
                    and case.get("instance", {}).get("data", {}).get("executionStatus") == status,
                    f"{status}: {coverage_key} must exercise the matching schema-valid semantic branch with expected={expected_semantic}")
        invalid_case = semantic_by_id[row["invalidCase"]]
        require(invalid_case.get("expectedRejectRule") == row.get("invalidRule")
                and row.get("invalidRule") == f"[status:{status}]",
                f"{status}: invalid fixture must prove rejection in its actual status-specific branch")

    original_cases = load(ORIGINAL_AGGREGATE_COUNTEREXAMPLE_PATH)
    original_by_label = {case["label"]: case["instance"] for case in original_cases["cases"]}
    original_fixture_ids = {
        "pending-output-hidden-by-error": "execution-error-pending-hidden-r3-original",
        "pending-output-hidden-by-blocked": "execution-blocked-pending-hidden-r3-original",
        "pending-output-hidden-by-denied": "execution-denied-pending-hidden-r3-original",
    }
    require(set(original_by_label) == set(original_fixture_ids),
            "original R3 aggregate attachment must contain exactly the three reviewed counterexamples")
    for source_label, fixture_id in original_fixture_ids.items():
        case = semantic_by_id.get(fixture_id)
        require(case is not None and case.get("instance") == original_by_label[source_label]
                and case.get("schemaValid") is True and case.get("semanticValid") is False,
                f"{fixture_id}: must preserve the original attached instance and be semantically rejected")

    counterexamples = load(COUNTEREXAMPLE_PATH)
    require(counterexamples.get("registryVersion") == registry["registryVersion"],
            "counterexamples must identify the registry version under test")
    for case in counterexamples["cases"]:
        tool = by_name[case["tool"]]
        require(case.get("schemaVersion") == tool["schemaVersion"],
                f"{case['id']}: counterexample must be pinned to the tool schemaVersion")
        schema = tool["inputSchema"] if case["target"] == "input" else tool["resultSchema"]
        legacy_valid = Draft202012Validator(schema).is_valid(case["r3RejectedEnvelope"])
        corrected_valid = Draft202012Validator(schema).is_valid(case["r3CorrectedResult"])
        require(legacy_valid is case["r3LegacyEnvelopeAccepted"],
                f"{case['id']}: unexpected R3 handling of the legacy-equivalent envelope")
        require(corrected_valid is case["r3CorrectedAccepted"],
                f"{case['id']}: corrected honest result did not validate")

    atomic_patch = next((case for case in fixture_cases
                         if case.get("id") == "patch-clear-source-and-mask-atomic-result-valid"), None)
    require(atomic_patch is not None and atomic_patch.get("valid") is True,
            "patch_creation_inputs needs a positive atomic source+mask receipt fixture")
    patch_data_fixture = atomic_patch["instance"]["data"]
    require(len(patch_data_fixture["beforeRefs"]) >= 2
            and len(patch_data_fixture["undo"]["restoreRefs"]) == len(patch_data_fixture["beforeRefs"])
            and set(patch_data_fixture["undo"]["affectedAttachmentIds"])
                == {ref["attachmentId"] for ref in patch_data_fixture["beforeRefs"]},
            "atomic clear fixture must restore every removed dependency attachment")

    required_fixture_outcomes = {
        "reverse-failed-partial-text-business-valid": True,
        "reverse-unknown-partial-text-returned-result-valid": True,
        "execution-partial-confirmed-cancelled-output-valid": True,
        "read-creation-ok-empty-bindings-valid": True,
        "read-creation-reference-purpose-valid": True,
        "read-creation-reference-missing-purpose-invalid": False,
        "prepare-effective-reference-purpose-valid": True,
        "prepare-preview-random-null-seed-valid": True,
        "prepare-preview-fixed-null-seed-invalid": False,
        "prepare-preview-random-number-seed-invalid": False,
        "patch-reference-purpose-and-undo-valid": True,
        "patch-set-reference-without-purpose-invalid": False,
        "patch-discussion-with-purpose-invalid": False,
        "prepare-reference-without-purpose-invalid": False,
        "cancel-not-found-minimal-without-fabricated-phase-valid": True,
        "cancel-not-found-with-fabricated-phase-invalid": False,
        "cancel-already-terminal-completed-valid": True,
        "cancel-already-terminal-running-invalid": False,
        "cancel-queued-race-resolved-locally-valid": True,
        "cancel-request-running-provider-request-valid": True,
        "cancel-request-phase-provider-mismatch-invalid": False,
        "cancel-request-dispatching-intent-provider-not-sent-valid": True,
        "cancel-request-dispatching-provider-cancel-before-send-invalid": False,
        "cancel-already-terminal-blocked-valid": True,
        "cancel-not-cancellable-blocked-invalid": False,
    }
    fixture_by_id = {case.get("id"): case for case in fixture_cases}
    for fixture_id, expected in required_fixture_outcomes.items():
        require(fixture_id in fixture_by_id and fixture_by_id[fixture_id].get("valid") is expected,
                f"missing or incorrectly classified targeted fixture: {fixture_id}")
    semantic_ids = {case["id"] for case in semantic_cases}
    require({
        "execution-completed-count-mismatch",
        "execution-queued-count-incomplete",
        "execution-ordinary-queued-none-pause-reason",
        "execution-unknown-priority-over-cancelled-output",
        "execution-partial-cannot-hide-unknown-cancellation-sibling",
        "execution-queued-cannot-hide-unknown-provider-without-dispatch-evidence",
        "execution-error-cannot-hide-unknown-output",
    }.issubset(semantic_ids),
            "execution semantic coverage must test expected count, ordinary queue, cancellation, and unknown priority")

    # Keep the human contract, registry and local links aligned.
    contracts_path = ROOT / "TOOL_CONTRACTS.md"
    require(contracts_path.is_file(), "missing TOOL_CONTRACTS.md")
    contracts = contracts_path.read_text(encoding="utf-8")
    contract_names = re.findall(r"^### `([^`]+)`$", contracts, re.MULTILINE)
    require(contract_names == EXPECTED, "TOOL_CONTRACTS.md headings must match registry order")
    contract_sections = re.split(r"(?m)^### `([^`]+)`\s*$", contracts)
    contract_blocks = {contract_sections[i]: contract_sections[i + 1]
                       for i in range(1, len(contract_sections), 2)}
    for name, tool in by_name.items():
        match = re.search(r"(?m)^\*\*职责与时机：\*\* (.*)$", contract_blocks[name])
        require(match is not None and match.group(1) == tool["description"],
                f"{name}: human duty text must match registry description")
    assert_registry_derived_contract_summaries(
        contracts, by_name, [entry["groupId"] for entry in registry["groupCatalog"]]
    )
    for required_link in ("README.md", "TOOLS_AND_FLOWS.md", "UI_SPEC.md", "SYSTEM_PROMPT.md",
                          "prototype-v3.2-r4.html", "tool-registry.json", "schema-fixtures/fixtures.json",
                          "source/r4-final-contract-audit.md", "schema-fixtures/counterexamples-r3.json"):
        require(f"]({required_link})" in contracts, f"TOOL_CONTRACTS.md should link {required_link}")
    for target in re.findall(r"\]\(([^)]+)\)", contracts):
        if target.startswith(("http://", "https://", "#")):
            continue
        local = (ROOT / target.split("#", 1)[0]).resolve()
        require(local.is_file(), f"broken contract link: {target}")

    print(f"OK: {len(tools)} tools; {checked} JSON Schema fixtures; {len(semantic_cases)} semantic cases; "
          f"{len(status_rows)} executionStatus branches each have valid+invalid semantic cases; "
          f"{len(original_fixture_ids)} original R3 counterexamples; {len(counterexamples['cases'])} old/new counterexamples; "
          f"{len(reference_cases)} synthetic reference authorization host-context cases; Draft 2020-12 host schemas.")
    print("No product handlers, external services, or paid APIs were called.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise
