import type { AgentFeature, AgentFeatureToggle } from "../agent-sdk-types.js";

// Codex Fast is distinct from API Priority processing. Keep model support aligned with
// https://developers.openai.com/codex/speed and https://developers.openai.com/codex/models.
const CODEX_FAST_MODE_SUPPORTED_MODELS = new Set([
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
]);

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

function codexModelServiceTierIds(modelId: string | null | undefined): string[] {
  const normalizedModelId = normalizeCodexModelId(modelId);
  return normalizedModelId ? (CODEX_MODEL_SERVICE_TIERS.get(normalizedModelId) ?? []) : [];
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

function resolveCodexServiceTierIds(model: {
  serviceTiers?: unknown;
  additionalSpeedTiers?: unknown;
}): string[] {
  const tierIds: string[] = [];
  const advertised = Array.isArray(model?.serviceTiers) ? model.serviceTiers : [];
  for (const tier of advertised) {
    const raw = (tier as { id?: unknown } | null | undefined)?.id;
    const tierId = normalizeCodexModelId(typeof raw === "string" ? raw : null);
    if (tierId) {
      tierIds.push(tierId);
    }
  }
  const additional = Array.isArray(model?.additionalSpeedTiers) ? model.additionalSpeedTiers : [];
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
): void {
  if (!Array.isArray(models)) {
    return;
  }
  for (const model of models) {
    const modelId = normalizeCodexModelId(resolveCodexModelEntryId(model));
    if (!modelId) {
      continue;
    }
    const tierIds: string[] = [];
    for (const tierId of resolveCodexServiceTierIds(model)) {
      if (!tierIds.includes(tierId)) {
        tierIds.push(tierId);
      }
    }
    if (tierIds.length > 0) {
      CODEX_MODEL_SERVICE_TIERS.set(modelId, tierIds);
    }
  }
}

export function codexModelSupportsFastMode(modelId: string | null | undefined): boolean {
  const normalizedModelId = normalizeCodexModelId(modelId);
  if (!normalizedModelId) {
    return false;
  }
  return (
    codexModelServiceTierIds(normalizedModelId).includes("fast") ||
    CODEX_FAST_MODE_SUPPORTED_MODELS.has(normalizedModelId)
  );
}

export function codexModelSupportsUltrafastMode(modelId: string | null | undefined): boolean {
  return codexModelServiceTierIds(modelId).includes("ultrafast");
}

export function buildCodexFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
  ultrafastModeEnabled?: boolean;
  planModeEnabled: boolean;
  planModeAvailable?: boolean;
}): AgentFeature[] {
  const features: AgentFeature[] = [];

  if (codexModelSupportsFastMode(input.modelId)) {
    features.push({
      ...CODEX_FAST_MODE_FEATURE,
      value: input.fastModeEnabled === true,
    });
  }

  if (codexModelSupportsUltrafastMode(input.modelId)) {
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
