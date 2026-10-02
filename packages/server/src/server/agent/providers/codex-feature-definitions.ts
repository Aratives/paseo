import type { AgentFeature, AgentFeatureToggle } from "../agent-sdk-types.js";

export const CODEX_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Priority inference at increased usage",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export const CODEX_ULTRAFAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "ultrafast_mode",
  label: "Ultrafast",
  description: "Fastest available responses for latency-sensitive work",
  tooltip: "Toggle ultrafast mode",
  icon: "zap",
};

export const CODEX_PLAN_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "plan_mode",
  label: "Plan",
  description: "Switch Codex into planning-only collaboration mode",
  tooltip: "Toggle plan mode",
  icon: "list-todo",
};

function normalizeCodexModelId(modelId: string | null | undefined): string | null {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

/**
 * Per-model service tiers reported by codex app-server `model/list`
 * (`serviceTiers` plus `additionalSpeedTiers`). Recorded per model so Fast and
 * Ultrafast are offered exactly where codex advertises them, instead of being
 * gated on a hardcoded model list that silently goes stale on new releases.
 */
const CODEX_MODEL_SERVICE_TIERS = new Map<string, string[]>();
type CodexModelServiceTierRegistry = ReadonlyMap<string, readonly string[]>;

function codexModelServiceTierIds(
  modelId: string | null | undefined,
  registry: CodexModelServiceTierRegistry,
): readonly string[] {
  const normalizedModelId = normalizeCodexModelId(modelId);
  return normalizedModelId ? (registry.get(normalizedModelId) ?? []) : [];
}

/**
 * Call with the raw `model/list` response. The parsed schema does not carry
 * `serviceTiers`, so a validated object would arrive without them.
 */
function resolveCodexModelEntryId(model: { id?: unknown; model?: unknown }): string | null {
  if (typeof model?.id === "string") {
    return model.id;
  }
  return typeof model?.model === "string" ? model.model : null;
}

function codexServiceTierValues(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === "string" ? [value] : [];
}

function resolveCodexServiceTierIds(model: {
  serviceTiers?: unknown;
  additionalSpeedTiers?: unknown;
}): string[] {
  const tierIds: string[] = [];
  const advertised = codexServiceTierValues(model?.serviceTiers);
  for (const tier of advertised) {
    const raw = typeof tier === "string" ? tier : (tier as { id?: unknown } | null | undefined)?.id;
    const tierId = normalizeCodexModelId(typeof raw === "string" ? raw : null);
    if (tierId) {
      tierIds.push(tierId);
    }
  }
  const additional = codexServiceTierValues(model?.additionalSpeedTiers);
  for (const tier of additional) {
    const tierId = normalizeCodexModelId(typeof tier === "string" ? tier : null);
    if (tierId) {
      tierIds.push(tierId);
    }
  }
  return tierIds;
}

export function registerCodexModelServiceTiers(
  models:
    | readonly (
        | { id?: unknown; model?: unknown; serviceTiers?: unknown; additionalSpeedTiers?: unknown }
        | null
        | undefined
      )[]
    | null
    | undefined,
  registry: Map<string, string[]> = CODEX_MODEL_SERVICE_TIERS,
): void {
  if (!Array.isArray(models)) {
    return;
  }
  registry.clear();
  for (const model of models) {
    const modelId = normalizeCodexModelId(resolveCodexModelEntryId(model));
    if (!modelId) {
      continue;
    }
    if (model?.serviceTiers === undefined && model?.additionalSpeedTiers === undefined) {
      registry.delete(modelId);
      continue;
    }
    const tierIds: string[] = [];
    for (const tierId of resolveCodexServiceTierIds(model)) {
      if (!tierIds.includes(tierId)) {
        tierIds.push(tierId);
      }
    }
    registry.set(modelId, tierIds);
  }
}

export function codexModelSupportsFastMode(
  modelId: string | null | undefined,
  registry: CodexModelServiceTierRegistry = CODEX_MODEL_SERVICE_TIERS,
): boolean {
  const normalizedModelId = normalizeCodexModelId(modelId);
  if (!normalizedModelId) {
    return false;
  }
  return codexModelServiceTierIds(normalizedModelId, registry).includes("fast");
}

export function codexModelSupportsUltrafastMode(
  modelId: string | null | undefined,
  registry: CodexModelServiceTierRegistry = CODEX_MODEL_SERVICE_TIERS,
): boolean {
  return codexModelServiceTierIds(modelId, registry).includes("ultrafast");
}

export function buildCodexFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
  ultrafastModeEnabled?: boolean;
  planModeEnabled: boolean;
  planModeAvailable?: boolean;
  serviceTiers?: CodexModelServiceTierRegistry;
}): AgentFeature[] {
  const features: AgentFeature[] = [];

  if (codexModelSupportsFastMode(input.modelId, input.serviceTiers)) {
    features.push({
      ...CODEX_FAST_MODE_FEATURE,
      value: input.fastModeEnabled === true,
    });
  }

  if (codexModelSupportsUltrafastMode(input.modelId, input.serviceTiers)) {
    features.push({
      ...CODEX_ULTRAFAST_MODE_FEATURE,
      value: input.ultrafastModeEnabled === true,
    });
  }

  if (input.planModeAvailable !== false) {
    features.push({
      ...CODEX_PLAN_MODE_FEATURE,
      value: input.planModeEnabled,
    });
  }

  return features;
}
