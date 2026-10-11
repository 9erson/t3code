import type { IssueDetail, ProjectId, ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveAppModelSelectionForInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";

export function buildIssueWorkPrompt(issue: Pick<IssueDetail, "title" | "body" | "url">) {
  return `Work on this GitHub issue:\n\n# ${issue.title}\n\n${issue.body}\n\n${issue.url}`;
}

/** Project overrides win; without a configured agent use the composer's first available instance. */
export function resolveIssueWorkDefaults(
  settings: UnifiedSettings,
  providers: ReadonlyArray<ServerProvider>,
  project: { id: ProjectId; defaultModelSelection?: ModelSelection | null },
) {
  const resolved = resolveProjectSettings(settings, project.id, project).settings;
  let modelSelection = resolved.defaultModelSelection;
  if (modelSelection === null) {
    const entry = sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    ).find((candidate) => candidate.enabled && candidate.isAvailable);
    const model = entry
      ? resolveAppModelSelectionForInstance(entry.instanceId, settings, providers, null)
      : null;
    if (entry && model) modelSelection = createModelSelection(entry.instanceId, model);
  }
  return { modelSelection, runtimeMode: resolved.defaultRuntimeMode };
}
