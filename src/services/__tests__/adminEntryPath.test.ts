import { afterEach, describe, expect, it, vi } from "vitest";
import { getAdminEntryPath } from "@/services/api";

function response(data: unknown) {
  return new Response(JSON.stringify({ status: "success", data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("admin-path plugin entry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the active plugin's private path, including nested paths", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([
        { short: "admin-path", enabled: true, running: true },
      ]))
      .mockResolvedValueOnce(response({ data: { adminPath: "/ops/console/" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAdminEntryPath()).resolves.toBe("/ops/console");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/admin/plugin/list",
      "/api/admin/plugin/configuration?short=admin-path",
    ]);
  });

  it("keeps /admin when the plugin is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAdminEntryPath()).resolves.toBe("/admin");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps /admin when the plugin is stopped", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([
      { short: "admin-path", enabled: true, running: false },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAdminEntryPath()).resolves.toBe("/admin");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects paths that could navigate away from the site", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response([
        { short: "admin-path", enabled: true, running: true },
      ]))
      .mockResolvedValueOnce(response({ data: { adminPath: "https://elsewhere.example" } })));

    await expect(getAdminEntryPath()).resolves.toBe("/admin");
  });
});
