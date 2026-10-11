import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type IssueDetail } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { useMemo, useRef, useState } from "react";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useClientSettings, mergeEnvironmentSettings } from "~/hooks/useSettings";
import { newThreadId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readProjects, useServerConfigs } from "~/state/entities";
import { issueEnvironment, workOnIssueCommand } from "~/state/issues";
import { useEnvironmentsWithScope } from "~/state/session";
import { environmentServerConfigsAtom } from "~/state/server";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { environmentThreadShells } from "~/state/threads";
import { waitForAtomValue } from "~/state/waitForAtomValue";
import { toastManager } from "../ui/toast";
import type { IssueSelection } from "./issueSelection.logic";
import { buildIssueWorkPrompt, resolveIssueWorkDefaults } from "./issueWork.logic";

/** Both issue entry points leave the task unsent in the owning environment's composer. */
export function useWorkOnIssue() {
  const router = useRouter();
  const configs = useServerConfigs();
  const clientSettings = useClientSettings();
  const environments = useMemo(
    () => [...configs.keys()].map((environmentId) => ({ environmentId })),
    [configs],
  );
  const canOperate = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const canLink = useAtomValue(
    useMemo(
      () =>
        Atom.make(
          (get) =>
            new Set(
              environments
                .filter(({ environmentId }) =>
                  get(workOnIssueCommand.permissionAtom(environmentId)),
                )
                .map(({ environmentId }) => environmentId),
            ),
        ),
      [environments],
    ),
  );
  const run = useOrchestrationCommand(workOnIssueCommand, { reportFailure: false });
  const inFlight = useRef(false);
  const [pending, setPending] = useState<IssueSelection | null>(null);
  const available = (selection: IssueSelection) =>
    configs.get(selection.environmentId)?.environment.capabilities.issues === true &&
    canOperate.has(selection.environmentId) &&
    canLink.has(selection.environmentId);

  const workOnIssue = async (selection: IssueSelection, loadedDetail?: IssueDetail) => {
    if (inFlight.current || !available(selection)) return;
    inFlight.current = true;
    setPending(selection);
    try {
      const { environmentId, projectId, host, repository, number } = selection;
      const detail =
        loadedDetail ??
        (await Effect.runPromise(
          AtomRegistry.getResult(
            appAtomRegistry,
            issueEnvironment.detail({
              environmentId,
              input: { projectId, host, repository, number },
            }),
          ),
        ));
      // Re-read after the detail request: scope and defaults belong to this physical project,
      // even when another environment has a project for the same repository.
      const project = readProjects().find(
        (entry) => entry.environmentId === environmentId && entry.id === projectId,
      );
      const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
      if (!project || !config) throw new Error("The issue's project is no longer connected.");
      const defaults = resolveIssueWorkDefaults(
        mergeEnvironmentSettings(config.settings, clientSettings),
        config.providers,
        project,
      );
      if (!defaults.modelSelection)
        throw new Error("Configure an agent in this environment before working on the issue.");
      const threadRef = scopeThreadRef(environmentId, newThreadId());
      const result = await run({
        environmentId,
        input: {
          ...selection,
          threadId: threadRef.threadId,
          title: detail.title,
          modelSelection: defaults.modelSelection,
          runtimeMode: defaults.runtimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const store = useComposerDraftStore.getState();
      store.setPrompt(threadRef, buildIssueWorkPrompt(detail));
      store.setModelSelection(threadRef, defaults.modelSelection, { replaceOptions: true });
      // Wait for the linked projection, so opening the thread also paints its issue chip.
      const visible = await waitForAtomValue({
        registry: appAtomRegistry,
        atom: environmentThreadShells.threadShellAtom(threadRef),
        predicate: (thread) =>
          thread?.issues?.some(
            (issue) =>
              issue.host.toLowerCase() === host.toLowerCase() &&
              issue.repository.toLowerCase() === repository.toLowerCase() &&
              issue.number === number,
          ) === true,
        timeoutMs: 5_000,
      });
      await router.navigate({ to: "/$environmentId/$threadId", params: threadRef });
      if (!visible)
        toastManager.add({
          type: "warning",
          title: "Thread created; waiting for the connection",
          description:
            "The issue is linked and the prompt is saved. Reconnect if the thread does not appear.",
        });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not work on this issue",
        description: error instanceof Error ? error.message : "Try again after reconnecting.",
      });
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };
  return { available, pending, workOnIssue };
}
