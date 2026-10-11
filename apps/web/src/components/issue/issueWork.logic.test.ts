import { expect, it } from "vite-plus/test";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { buildIssueWorkPrompt, resolveIssueWorkDefaults } from "./issueWork.logic";

it("includes the issue title, complete markdown body, and URL in the unsent task", () => {
  expect(
    buildIssueWorkPrompt({
      title: "Repair remote builds",
      body: "## Reproduction\n\nRun `build` on the remote environment.\n\n- Keep local builds working.",
      url: "https://github.com/acme/remote/issues/10",
    }),
  ).toBe(
    "Work on this GitHub issue:\n\n# Repair remote builds\n\n## Reproduction\n\nRun `build` on the remote environment.\n\n- Keep local builds working.\n\nhttps://github.com/acme/remote/issues/10",
  );
});

it("uses the owning project's configured default agent and runtime mode", () => {
  const projectId = ProjectId.make("remote-project");
  const defaults = resolveIssueWorkDefaults(
    {
      ...DEFAULT_UNIFIED_SETTINGS,
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      defaultRuntimeMode: "full-access",
      projectSettingsOverrides: {
        [projectId]: {
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-opus-5",
          },
          defaultRuntimeMode: "approval-required",
        },
      },
    },
    [],
    { id: projectId },
  );
  expect(defaults).toEqual({
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    runtimeMode: "approval-required",
  });
});
