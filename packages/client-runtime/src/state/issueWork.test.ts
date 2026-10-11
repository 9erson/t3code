import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  IssueOperationError,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type AuthSessionState,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createIssueWorkCommand } from "./issues.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make(
    AsyncResult.success<AuthSessionState>({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationOperateScope, AuthSourceControlWriteScope],
      permissions: [AuthOrchestrationOperateScope, AuthSourceControlWriteScope],
    }),
  ),
);
const remote = EnvironmentId.make("remote");
const primary = EnvironmentId.make("primary");
const input = {
  threadId: ThreadId.make("issue-thread"),
  projectId: ProjectId.make("owning-project"),
  title: "Repair remote builds",
  host: "github.com",
  repository: "acme/remote",
  number: 10,
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5" },
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
};

const harness = Effect.fn(function* (linkFailure = false) {
  const commands: Array<{ environmentId: EnvironmentId; command: OrchestrationV2Command }> = [];
  const links: Array<{ environmentId: EnvironmentId; threadId: ThreadId; number: number }> = [];
  const supervisor = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      return EnvironmentSupervisor.of({
        target: { environmentId, label: environmentId },
        session: yield* SubscriptionRef.make(
          Option.some({
            client: {
              [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
                Effect.sync(() => {
                  commands.push({ environmentId, command });
                  return { sequence: commands.length };
                }),
              [WS_METHODS.issuesLink]: (link: { threadId: ThreadId; number: number }) =>
                linkFailure
                  ? Effect.fail(
                      new IssueOperationError({ host: "github.com", reason: "transient" }),
                    )
                  : Effect.sync(() => {
                      links.push({ environmentId, ...link });
                    }),
            },
          } as unknown as RpcSession),
        ),
      } as unknown as EnvironmentSupervisor["Service"]);
    });
  const remoteSupervisor = yield* supervisor(remote);
  const primarySupervisor = yield* supervisor(primary);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry, {
        run: (environmentId, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor,
            environmentId === remote ? remoteSupervisor : primarySupervisor,
          ),
      } as EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return { registry, command: createIssueWorkCommand(runtime), commands, links };
});

it.effect(
  "creates and links an idle thread in the issue's remote project without starting a turn",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness();
        const result = yield* Effect.promise(() =>
          h.command.run(h.registry, { environmentId: remote, input }),
        );
        expect(result._tag).toBe("Success");
        expect(h.commands).toEqual([
          {
            environmentId: remote,
            command: {
              type: "thread.create",
              commandId: expect.any(String),
              createdBy: "user",
              creationSource: "web",
              threadId: "issue-thread",
              projectId: "owning-project",
              title: "Repair remote builds",
              modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            },
          },
        ]);
        expect(h.links).toEqual([
          {
            environmentId: remote,
            threadId: "issue-thread",
            host: "github.com",
            repository: "acme/remote",
            number: 10,
          },
        ]);
      }),
    ),
);

it.effect("removes the newly created thread when linking fails and reports the failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness(true);
      const result = yield* Effect.promise(() =>
        h.command.run(h.registry, { environmentId: remote, input }),
      );
      expect(result._tag).toBe("Failure");
      expect(h.commands).toMatchObject([
        { environmentId: "remote", command: { type: "thread.create", threadId: "issue-thread" } },
        { environmentId: "remote", command: { type: "thread.delete", threadId: "issue-thread" } },
      ]);
      expect(h.links).toEqual([]);
    }),
  ),
);

it.effect("requires the issue environment's source control grant before creating a thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* harness();
      const grant = h.registry.get(sessions(remote));
      h.registry.set(
        sessions(remote),
        AsyncResult.success({
          ...grant.value,
          scopes: [AuthOrchestrationOperateScope],
          permissions: [AuthOrchestrationOperateScope],
        }),
      );
      expect(h.registry.get(h.command.permissionAtom(primary))).toBe(true);
      expect(h.registry.get(h.command.permissionAtom(remote))).toBe(false);
      const result = yield* Effect.promise(() =>
        h.command.run(h.registry, { environmentId: remote, input }),
      );
      expect(result._tag).toBe("Failure");
      expect(h.commands).toEqual([]);
      expect(h.links).toEqual([]);
    }),
  ),
);
