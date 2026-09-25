import { afterEach, describe, expect, it, vi } from "vitest";
import { getIpInfo, getIpRefreshWarning, selectIpClassification } from "../ipInfo";

describe("IP refresh results", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("retains the exact query address when the backend returns canonical IPv6", async () => {
    const original = "2606:4700:4700:0:0:0:0:AAAA";
    const canonical = "2606:4700:4700::aaaa";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: {
        uuid: "node", schema_version: 6, excluded: false, excluded_reason: null,
        address: { value: canonical, family: 6 }, location: {}, network: {},
        reputation: { available: false, signals: {}, method: { id: "unavailable", status: "unavailable" } },
        capabilities: { media_unlock: false, ai_unlock: false },
        provider: { id: "net-coffee", name: "Net.Coffee", homepage: "https://ip.net.coffee", base_source: "net-coffee", security_data_available: false },
      },
      meta: { cache: "hit", stale: false, updated_at: "", expires_at: "", stale_until: "", warning: null },
    }))));
    const result = await getIpInfo("node", original);
    expect(result.data.address.value).toBe(canonical);
    expect(result.queryAddress).toBe(original);
  });
  const unknown = { type: "unknown" as const, label: null, geolocated_country_code: null, registered_country_code: null, confidence: null, source: "unavailable" };
  const native = { ...unknown, type: "native" as const, label: "原生 IP" };
  it("uses a valid profile classification when the fallback base is unknown", () => {
    expect(selectIpClassification(unknown, native)).toBe(native);
    expect(selectIpClassification(native, unknown)).toBe(native);
  });
  const success = {
    ok: true, data: { excluded: false }, meta: { stale: false, warning: null },
    related: { latency: { meta: { stale: false, warning: null }, data: { latency: { available_count: 5 } } } },
  };
  it("reports stale base and partial latency failure despite HTTP success", () => {
    expect(getIpRefreshWarning(success)).toBeNull();
    expect(getIpRefreshWarning({ ...success, meta: { stale: true, warning: "provider_timeout", latency_warning: "provider_timeout" } })).toContain("基础信息未能更新");
    expect(getIpRefreshWarning({ ...success, related: undefined })).toContain("全球延迟");
    expect(getIpRefreshWarning({ ...success, related: { latency: { ...success.related.latency, meta: { stale: true, warning: "provider_timeout" } } } })).toContain("全球延迟");
    expect(() => getIpRefreshWarning({ ok: false })).toThrow();
  });
});
