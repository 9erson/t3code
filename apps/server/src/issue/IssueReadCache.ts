import { IssueListResult, IssueOperationError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as ServerConfig from "../config.ts";

const codec = Schema.fromJsonString(
  Schema.Struct({ expiresAt: Schema.Finite, result: IssueListResult }),
);
export class IssueReadCache extends Context.Service<
  IssueReadCache,
  {
    readonly get: (
      key: string,
      lookup: Effect.Effect<IssueListResult, IssueOperationError>,
    ) => Effect.Effect<IssueListResult, IssueOperationError>;
    readonly invalidate: Effect.Effect<void>;
  }
>()("t3/issue/IssueReadCache") {}

/** Public construction lets service tests use the real cache over an isolated memory store. */
export const make = Effect.gen(function* () {
  const backing = yield* KeyValueStore.KeyValueStore;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  let enabled = true;
  return IssueReadCache.of({
    get: Effect.fn("IssueReadCache.get")(function* (key, lookup) {
      if (!enabled) return yield* lookup;
      const cachedLookup = yield* Effect.cached(lookup);
      return yield* Effect.gen(function* () {
        const digest = Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(key)));
        const now = yield* Clock.currentTimeMillis;
        const raw = yield* backing.get(digest);
        if (raw !== undefined) {
          const stored = yield* Schema.decodeEffect(codec)(raw);
          if (stored.expiresAt > now) return stored.result;
        }
        const result = yield* cachedLookup;
        // Errors and partial results must re-ask the failing hosts on the next read.
        if (
          result.errors.length === 0 &&
          result.providers.every(
            (provider) =>
              provider.configured || provider.detail === "This host cannot be browsed here yet.",
          )
        ) {
          if ((yield* backing.size) >= 64) yield* backing.clear;
          yield* backing.set(
            digest,
            yield* Schema.encodeEffect(codec)({ result, expiresAt: now + 30_000 }),
          );
        }
        return result;
      }).pipe(
        Effect.catchTags({
          PlatformError: () => cachedLookup,
          KeyValueStoreError: () => cachedLookup,
          SchemaError: () => cachedLookup,
        }),
        lock.withPermits(1),
      );
    }),
    invalidate: backing.clear.pipe(
      Effect.catch(() => {
        enabled = false;
        return Effect.logWarning("Issue read cache disabled after clearing failed");
      }),
      lock.withPermits(1),
      Effect.uninterruptible,
    ),
  });
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return Layer.effect(IssueReadCache, make).pipe(
      Layer.provide(
        KeyValueStore.layerFileSystem(path.join(config.providerStatusCacheDir, "issues")).pipe(
          Layer.catch(() => KeyValueStore.layerMemory),
        ),
      ),
    );
  }),
);
