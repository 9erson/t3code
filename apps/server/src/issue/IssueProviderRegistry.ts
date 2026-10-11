import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { SourceControlProviderKind } from "@t3tools/contracts";
import type { IssueProviderApi } from "@t3tools/source-control-core/server/IssueProvider";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";

export class IssueProviderRegistry extends Context.Service<
  IssueProviderRegistry,
  {
    readonly get: (kind: SourceControlProviderKind) => IssueProviderApi | null;
  }
>()("t3/issue/IssueProviderRegistry") {}

export const layer = Layer.effect(
  IssueProviderRegistry,
  Effect.gen(function* () {
    const instances = yield* Effect.forEach(
      BuiltInDrivers.BUILT_IN_SOURCE_CONTROL_DRIVERS,
      (driver) => driver.make,
    );
    const providers = new Map(
      instances.flatMap((instance) =>
        instance.issues == null ? [] : [[instance.issues.kind, instance.issues] as const],
      ),
    );
    return IssueProviderRegistry.of({ get: (kind) => providers.get(kind) ?? null });
  }),
).pipe(Layer.provide(BuiltInDrivers.layer));
