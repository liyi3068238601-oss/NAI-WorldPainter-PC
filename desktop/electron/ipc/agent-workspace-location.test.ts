import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => runtime.userData },
  shell: { openPath: vi.fn() },
}));

import { WORLDPAINTER_AGENT_WORKSPACE_DIRECTORY } from "../../shared/worldpainter-product";
import { AGENT_WORKSPACE_VERSION } from "../../src/agent/types";
import { getAgentWorkspaceLocation, resetAgentWorkspaceLocationForTests } from "./agent-workspace-location";

let root = "";
const previousPortableDirectory = process.env.PORTABLE_EXECUTABLE_DIR;

afterEach(() => {
  resetAgentWorkspaceLocationForTests();
  if (previousPortableDirectory === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
  else process.env.PORTABLE_EXECUTABLE_DIR = previousPortableDirectory;
  if (root) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("worldpainter-agent-location-")) {
      throw new Error("Unexpected fixture root");
    }
    fs.rmSync(root, { recursive: true, force: true });
    root = "";
  }
});

describe("Agent workspace product location", () => {
  it("uses a WorldPainter default and snapshots the previous app-data directory without modifying it", () => {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "worldpainter-agent-location-"));
    runtime.userData = root;
    const legacy = path.join(root, "LangbaiWorkspace");
    fs.mkdirSync(legacy);
    const legacyFile = path.join(legacy, "agent-workspace.json");
    const original = JSON.stringify({ version: AGENT_WORKSPACE_VERSION, conversations: [] });
    fs.writeFileSync(legacyFile, original);

    const location = getAgentWorkspaceLocation();
    expect(location.migratedFromLegacy).toBe(true);
    expect(location.sourcePath).toBe(legacy);
    expect(location.path).not.toBe(legacy);
    expect(location.path).not.toContain("Langbai");
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(original);

    resetAgentWorkspaceLocationForTests();
    const reopened = getAgentWorkspaceLocation();
    expect(reopened.path).toBe(location.path);
    expect(reopened.migratedFromLegacy).toBe(false);
  });

  it("creates a new profile under the WorldPainter workspace folder", () => {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "worldpainter-agent-location-"));
    runtime.userData = root;

    const location = getAgentWorkspaceLocation();
    expect(location.path).toBe(path.join(root, WORLDPAINTER_AGENT_WORKSPACE_DIRECTORY));
    expect(fs.existsSync(path.join(root, "LangbaiWorkspace"))).toBe(false);
  });
});
