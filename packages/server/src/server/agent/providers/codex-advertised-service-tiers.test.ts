import { describe, expect, test } from "vitest";
import type { AgentSessionConfig } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CodexAppServerAgentClient, CodexAppServerAgentSession } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";
import { buildCodexFeatures } from "./codex-feature-definitions.js";

function harness(
  model: string,
  advertisement: Record<string, unknown>,
  featureValues?: Record<string, unknown>,
) {
  const appServer = createFakeCodexAppServer({
    "model/list": () => ({ data: [{ id: model, isDefault: true, ...advertisement }] }),
  });
  const config: AgentSessionConfig = {
    provider: "codex",
    cwd: "/tmp/codex-advertisement-test",
    model,
    featureValues,
  };
  const session = new CodexAppServerAgentSession(
    config,
    null,
    createTestLogger(),
    async () => appServer.child,
  );
  return { session, appServer, config };
}

describe("Codex advertised service tiers", () => {
  test("a model change persists the cleared tier when the session is saved and recreated", async () => {
    const first = harness(
      "saved-tier-model",
      { additionalSpeedTiers: ["ultrafast"] },
      { ultrafast_mode: true },
    );
    try {
      await first.session.connect();
      await first.session.setModel("model-without-tiers");
      await first.session.setModel("saved-tier-model");
      expect(first.session.features).toContainEqual(
        expect.objectContaining({ id: "ultrafast_mode", value: false }),
      );
      const saved = JSON.parse(JSON.stringify(first.config)) as AgentSessionConfig;
      const restored = harness(
        saved.model!,
        { additionalSpeedTiers: ["ultrafast"] },
        saved.featureValues,
      );
      try {
        await restored.session.connect();
        expect(restored.session.features).toContainEqual(
          expect.objectContaining({ id: "ultrafast_mode", value: false }),
        );
        await restored.session.startTurn("hello");
        await expect(restored.appServer.waitForTurnStart()).resolves.not.toMatchObject({
          serviceTier: expect.anything(),
        });
      } finally {
        await restored.session.close();
      }
    } finally {
      await first.session.close();
    }
  });

  test.each([
    ["object-array", { serviceTiers: [{ id: "fast" }, { id: "ultrafast" }] }],
    ["string-array", { serviceTiers: ["fast", "ultrafast"] }],
    ["additional-array", { additionalSpeedTiers: ["fast", "ultrafast"] }],
  ])(
    "offers and sends the tiers from %s on the session connection",
    async (shape, advertisement) => {
      const { session, appServer } = harness(`advertised-${shape}`, advertisement);
      try {
        await session.connect();
        expect(session.features).toEqual([
          expect.objectContaining({ id: "fast_mode", value: false }),
          expect.objectContaining({ id: "ultrafast_mode", value: false }),
        ]);
        expect(
          session.features.every(
            (feature) => feature.type !== "toggle" || typeof feature.value === "boolean",
          ),
        ).toBe(true);
        await session.setFeature("ultrafast_mode", true);
        await session.startTurn("hello");
        await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
          serviceTier: "ultrafast",
        });
        appServer.assertNoErrors();
      } finally {
        await session.close();
      }
    },
  );

  test.each([
    ["service-scalar", { serviceTiers: "fast" }],
    ["additional-scalar", { additionalSpeedTiers: "fast" }],
  ])("accepts the scalar tier form from %s", async (shape, advertisement) => {
    const { session, appServer } = harness(`advertised-${shape}`, advertisement);
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "fast_mode", value: false }),
      );
      appServer.assertNoErrors();
    } finally {
      await session.close();
    }
  });

  test.each([
    ["string-array", { serviceTiers: ["fast", "ultrafast"] }],
    ["additional-scalar", { additionalSpeedTiers: "fast" }],
  ])("keeps model discovery when the raw advertisement uses %s", async (shape, advertisement) => {
    const model = `catalog-${shape}`;
    const appServer = createFakeCodexAppServer({
      "model/list": () => ({ data: [{ id: model, ...advertisement }] }),
    });
    const provider = new CodexAppServerAgentClient(createTestLogger());
    const internals = provider as unknown as {
      spawnAppServer: () => Promise<typeof appServer.child>;
      autoReviewEnabledPromise: Promise<boolean>;
    };
    internals.spawnAppServer = async () => appServer.child;
    internals.autoReviewEnabledPromise = Promise.resolve(false);
    const catalog = await provider.fetchCatalog({ cwd: "/tmp" });
    expect(catalog.models.map((entry) => entry.id)).toContain(model);
    appServer.assertNoErrors();
  });

  test("restores Ultrafast after the session obtains its own advertisement", async () => {
    const { session, appServer } = harness(
      "fresh-restored-ultrafast",
      { additionalSpeedTiers: ["ultrafast"] },
      { ultrafast_mode: true },
    );
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "ultrafast_mode", value: true }),
      );
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        serviceTier: "ultrafast",
      });
    } finally {
      await session.close();
    }
  });

  test("preserves raw tier fields through the catalog's narrower schema", async () => {
    const model = "catalog-raw-tier-fields";
    const appServer = createFakeCodexAppServer({
      "model/list": () => ({
        data: [{ id: model, serviceTiers: [{ id: "fast" }], additionalSpeedTiers: ["ultrafast"] }],
      }),
    });
    const provider = new CodexAppServerAgentClient(createTestLogger());
    const internals = provider as unknown as {
      spawnAppServer: () => Promise<typeof appServer.child>;
      autoReviewEnabledPromise: Promise<boolean>;
    };
    internals.spawnAppServer = async () => appServer.child;
    internals.autoReviewEnabledPromise = Promise.resolve(false);
    const catalog = await provider.fetchCatalog({ cwd: "/tmp" });
    expect(catalog.models.map((entry) => entry.id)).toContain(model);
    expect(
      buildCodexFeatures({
        modelId: model,
        fastModeEnabled: false,
        planModeEnabled: false,
        planModeAvailable: false,
      }),
    ).toEqual([
      expect.objectContaining({ id: "fast_mode", value: false }),
      expect.objectContaining({ id: "ultrafast_mode", value: false }),
    ]);
    appServer.assertNoErrors();
  });

  test("does not coerce a string false into an enabled speed toggle", async () => {
    const { session, appServer } = harness(
      "boolean-speed-toggle",
      { serviceTiers: [{ id: "fast" }] },
      { fast_mode: "false" },
    );
    try {
      await session.connect();
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "fast_mode", value: false }),
      );
      await session.setFeature("fast_mode", "false");
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "fast_mode", value: false }),
      );
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.not.toMatchObject({
        serviceTier: expect.anything(),
      });
    } finally {
      await session.close();
    }
  });

  test("an explicit empty advertisement overrides the historical Fast list", async () => {
    const { session } = harness("gpt-5.4", { serviceTiers: [] }, { fast_mode: true });
    try {
      await session.connect();
      expect(session.features.map((feature) => feature.id)).not.toContain("fast_mode");
      await expect(session.setFeature("fast_mode", true)).rejects.toThrow("not available");
    } finally {
      await session.close();
    }
  });

  test("fails closed for a historically fast model without a tier advertisement", async () => {
    const { session, appServer } = harness("gpt-5.4", {}, { fast_mode: true });
    try {
      await session.connect();
      expect(session.features.map((feature) => feature.id)).not.toContain("fast_mode");
      await expect(session.setFeature("fast_mode", true)).rejects.toThrow("not available");
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.not.toMatchObject({
        serviceTier: expect.anything(),
      });
    } finally {
      await session.close();
    }
  });

  test("keeps different seats' advertisements separate, including empty tier sets", async () => {
    const first = harness("seat-specific-model", { serviceTiers: [{ id: "fast" }] });
    const second = harness("seat-specific-model", { serviceTiers: [] });
    try {
      await first.session.connect();
      await second.session.connect();
      expect(second.session.features.map((feature) => feature.id)).not.toContain("fast_mode");
      expect(first.session.features).toContainEqual(
        expect.objectContaining({ id: "fast_mode", value: false }),
      );
    } finally {
      await first.session.close();
      await second.session.close();
    }
  });

  test("a failed model/list cannot grant or restore a historically fast capability", async () => {
    const appServer = createFakeCodexAppServer({
      "model/list": () => ({ __jsonRpcError: { code: -32603, message: "catalog unavailable" } }),
    });
    const session = new CodexAppServerAgentSession(
      { provider: "codex", cwd: "/tmp", model: "gpt-5.4", featureValues: { fast_mode: true } },
      null,
      createTestLogger(),
      async () => appServer.child,
    );
    try {
      await session.connect();
      expect(session.features.map((feature) => feature.id)).not.toContain("fast_mode");
      await expect(session.setFeature("fast_mode", true)).rejects.toThrow("not available");
      appServer.assertNoErrors();
    } finally {
      await session.close();
    }
  });

  test("disabling an inactive speed toggle preserves the active speed tier", async () => {
    const { session, appServer } = harness("exclusive-speed-toggles", {
      additionalSpeedTiers: ["fast", "ultrafast"],
    });
    try {
      await session.connect();
      await session.setFeature("fast_mode", true);
      await session.setFeature("ultrafast_mode", true);
      await session.setFeature("fast_mode", false);
      expect(session.features).toContainEqual(
        expect.objectContaining({ id: "ultrafast_mode", value: true }),
      );
      await session.startTurn("hello");
      await expect(appServer.waitForTurnStart()).resolves.toMatchObject({
        serviceTier: "ultrafast",
      });
    } finally {
      await session.close();
    }
  });
});
