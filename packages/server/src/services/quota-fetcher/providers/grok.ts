import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  ProviderUsage,
  ProviderUsageBalance,
  ProviderUsageDetail,
} from "../../../server/messages.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "../provider.js";
import {
  ApiNumberSchema,
  toneFromUsedPct,
  usedPctOf,
  fetchProviderApi,
  unavailableUsage,
} from "../usage.js";

const GrokUsageResponseSchema = z.object({
  config: z
    .object({
      monthlyLimit: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
      used: z
        .object({
          val: ApiNumberSchema.optional(),
        })
        .nullish(),
      billingPeriodEnd: z.string().nullish(),
    })
    .nullish(),
  usage: z
    .object({
      creditUsage: ApiNumberSchema.optional(),
    })
    .nullish(),
});

const GrokAuthEntrySchema = z.object({
  key: z.string().optional(),
  access_token: z.string().optional(),
  expires_at: z.string().optional(),
  refresh_token: z.string().optional(),
  oidc_issuer: z.string().optional(),
  oidc_client_id: z.string().optional(),
});

const GrokTokenResponseSchema = z.object({
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_in: ApiNumberSchema.optional(),
});

const GROK_TOKEN_EXPIRY_SKEW_MS = 60_000;
const GROK_DEFAULT_ISSUER = "https://auth.x.ai";

type GrokAuthEntry = z.infer<typeof GrokAuthEntrySchema>;

interface GrokQuotaProviderOptions {
  logger: Logger;
  fetch?: ProviderApiFetch;
}

export class GrokQuotaProvider implements ProviderUsageFetcher {
  readonly providerId = "grok";
  readonly displayName = "Grok";

  private readonly logger: Logger;
  private readonly fetchApi: ProviderApiFetch;

  constructor(options: GrokQuotaProviderOptions) {
    this.logger = options.logger;
    this.fetchApi = options.fetch ?? fetch;
  }

  async fetchUsage(): Promise<ProviderUsage> {
    const token =
      process.env["GROK_API_KEY"] || process.env["GROK_TOKEN"] || (await this.readGrokToken());

    if (!token) return unavailableUsage(this);

    const res = await fetchProviderApi(
      this.fetchApi,
      "https://cli-chat-proxy.grok.com/v1/billing",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-XAI-Token-Auth": "xai-grok-cli",
          Accept: "application/json",
        },
      },
    );

    if (!res.ok) {
      this.logger.debug({ status: res.status }, "Grok usage fetch failed");
      return unavailableUsage(this);
    }

    const resp = GrokUsageResponseSchema.parse(await res.json());
    const monthlyLimit = resp.config?.monthlyLimit?.val ?? null;
    const creditUsage = resp.config?.used?.val ?? resp.usage?.creditUsage ?? null;
    const balances: ProviderUsageBalance[] = [];
    if (monthlyLimit !== null || creditUsage !== null) {
      const remaining =
        monthlyLimit !== null && creditUsage !== null
          ? Math.max(0, monthlyLimit - creditUsage)
          : null;
      balances.push({
        id: "monthly_credits",
        label: "Monthly credits",
        used: creditUsage,
        remaining,
        limit: monthlyLimit,
        unit: "credits",
        tone: toneFromUsedPct(usedPctOf(creditUsage, monthlyLimit)),
      });
    }

    const details: ProviderUsageDetail[] = [];
    if (resp.config?.billingPeriodEnd) {
      details.push({
        id: "billing_period_end",
        label: "Billing period ends",
        value: resp.config.billingPeriodEnd.slice(0, 10),
      });
    }

    return {
      providerId: this.providerId,
      displayName: this.displayName,
      status: "available",
      planLabel: null,
      windows: [],
      balances,
      details,
      error: null,
    };
  }

  private async readGrokToken(): Promise<string | null> {
    for (const path of this.candidateAuthPaths()) {
      const token = await this.readTokenFromFile(path);
      if (token) return token;
    }
    return null;
  }

  private candidateAuthPaths(): string[] {
    const paths: string[] = [];
    if (process.env["GROK_AUTH_FILE"]) paths.push(process.env["GROK_AUTH_FILE"]);
    paths.push(join(homedir(), ".grok", "auth.json"));
    if (process.env["GROK_WSL_AUTH_FILE"]) paths.push(process.env["GROK_WSL_AUTH_FILE"]);
    return paths;
  }

  private async readTokenFromFile(path: string): Promise<string | null> {
    if (!existsSync(path)) return null;
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      raw = parsed as Record<string, unknown>;
    } catch {
      return null;
    }

    const entries: Array<{ topKey: string | null; entry: GrokAuthEntry }> = [];
    const flat = GrokAuthEntrySchema.safeParse(raw);
    if (flat.success && (flat.data.access_token || flat.data.key)) {
      entries.push({ topKey: null, entry: flat.data });
    }
    for (const [topKey, value] of Object.entries(raw)) {
      const parsed = GrokAuthEntrySchema.safeParse(value);
      if (parsed.success && (parsed.data.access_token || parsed.data.key)) {
        entries.push({ topKey, entry: parsed.data });
      }
    }

    for (const { entry } of entries) {
      const token = tokenFromAuthEntry(entry);
      if (token) return token;
    }
    for (const { topKey, entry } of entries) {
      if (!entry.refresh_token) continue;
      const token = await this.refreshEntry(path, raw, topKey, entry);
      if (token) return token;
    }
    return null;
  }

  private async refreshEntry(
    path: string,
    raw: Record<string, unknown>,
    topKey: string | null,
    entry: GrokAuthEntry,
  ): Promise<string | null> {
    const issuer =
      entry.oidc_issuer ?? (topKey?.includes("::") ? topKey.split("::")[0] : null) ??
      GROK_DEFAULT_ISSUER;
    const clientId =
      entry.oidc_client_id ?? (topKey?.includes("::") ? topKey.split("::")[1] : undefined);
    try {
      const discoRes = await fetchProviderApi(
        this.fetchApi,
        `${issuer}/.well-known/openid-configuration`,
        { headers: { Accept: "application/json" } },
      );
      if (!discoRes.ok) return null;
      const tokenEndpoint = z
        .object({ token_endpoint: z.string() })
        .parse(await discoRes.json()).token_endpoint;

      const res = await fetchProviderApi(this.fetchApi, tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: entry.refresh_token as string,
          ...(clientId ? { client_id: clientId } : {}),
        }).toString(),
      });
      if (!res.ok) return null;
      const tok = GrokTokenResponseSchema.parse(await res.json());
      if (!tok.access_token) return null;

      const target = topKey ? raw[topKey] : raw;
      if (!target || typeof target !== "object" || Array.isArray(target)) return null;
      const record = target as Record<string, unknown>;
      record["key"] = tok.access_token;
      if (tok.refresh_token) record["refresh_token"] = tok.refresh_token;
      record["expires_at"] = new Date(
        Date.now() + Number(tok.expires_in ?? 3600) * 1000,
      ).toISOString();
      await fs.writeFile(path, JSON.stringify(raw, null, 2));
      return tok.access_token;
    } catch {
      return null;
    }
  }
}

function tokenFromAuthEntry(entry: GrokAuthEntry): string | null {
  const token = entry.access_token ?? entry.key ?? null;
  if (!token) return null;
  if (entry.expires_at) {
    const expiresAt = Date.parse(entry.expires_at);
    if (!Number.isNaN(expiresAt) && expiresAt <= Date.now() + GROK_TOKEN_EXPIRY_SKEW_MS) {
      return null;
    }
  }
  return token;
}
