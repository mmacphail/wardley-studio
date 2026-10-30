import { test, expect } from "@playwright/test";

test("feature discovery, UI and API agree; map editing works with chat disabled", async ({
  page,
}, testInfo) => {
  const enabled = testInfo.config.metadata.chatExpected !== false;
  await page.goto("/");
  await page.waitForFunction(() => !!window.wardleyApi);
  const features = await page.evaluate(() =>
    window.wardleyApi!.request("GET", "/api/v1/features"),
  );
  expect(features.body).toEqual({ chat: enabled, chatCompiled: enabled });
  await expect(page.locator('[data-action="chat"]')).toHaveCount(
    enabled ? 1 : 0,
  );
  if (!enabled) {
    await expect(page.locator("#chat-panel")).toHaveCount(0);
    const responses = await page.evaluate(async () => {
      const api = window.wardleyApi!;
      return Promise.all([
        api.request("GET", "/api/v1/routes"),
        api.request("GET", "/api/v1/openapi.json"),
        api.request("GET", "/api/v1/chat"),
        api.request("POST", "/api/v1/chat/connect"),
        api.request("PATCH", "/api/v1/chat", { open: true }),
        api.request("POST", "/api/v1/actions/chat"),
      ]);
    });
    expect(
      (responses[0].body as any[]).some((r) => r.path.includes("/chat")),
    ).toBe(false);
    expect(
      Object.keys((responses[1].body as any).paths).some((p) =>
        p.includes("/chat"),
      ),
    ).toBe(false);
    expect(responses.slice(2).every((r) => r.status === 404)).toBe(true);
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .some((r) => /\/src\/chat(?:-markdown)?\.ts/.test(r.name)),
      ),
    ).toBe(false);
    expect(
      await page.evaluate(() => localStorage.getItem("wardley-chat-v1")),
    ).toBeNull();
  }
  const edited = await page.evaluate(() =>
    window.wardleyApi!.request(
      "PATCH",
      "/api/v1/maps/coffee-shop/components/experience",
      { label: "Feature flag check" },
    ),
  );
  expect(edited.status).toBe(200);
  await expect(page.locator('[data-node="experience"]')).toHaveAttribute(
    "aria-label",
    /Feature flag check/,
  );
  const snapshot = await page.evaluate(() =>
    window.wardleyApi!.request("GET", "/api/v1/current-map/snapshot"),
  );
  expect(snapshot.status).toBe(200);
  expect((snapshot.body as any).dataUrl).toMatch(/^data:image\/png;base64,/);
});
