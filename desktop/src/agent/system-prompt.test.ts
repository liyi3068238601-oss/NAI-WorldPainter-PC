import { expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt";

it("does not inject the full memory collection into the system prompt", () => {
  const prompt = buildAgentSystemPrompt({
    memories: [{
      id: "private-note", title: "Only on retrieval", trigger: "Only on retrieval",
      content: "M4 memory sentinel", scope: "global", type: "other", source: "manual",
      createdAt: "2026-10-15", updatedAt: "2026-10-15",
    }],
  });
  expect(prompt).not.toContain("M4 memory sentinel");
  expect(prompt).not.toContain("User-approved durable memory:");
});
