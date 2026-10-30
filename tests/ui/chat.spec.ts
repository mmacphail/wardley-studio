import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    let notify: (event: any) => void = () => {};
    let counter = 0;
    const mock = {
      mode: "edit",
      threadParams: null as any,
      resumeParams: null as any,
      replies: [] as any[],
      openedLinks: [] as string[],
      interrupted: false,
      turnId: "",
      emit: (event: any) => notify(event),
    };
    (window as any).__chatMock = mock;
    window.__WARDLEY_CHAT_TRANSPORT__ = {
      listen: async (callback) => {
        notify = callback;
      },
      load: async () =>
        JSON.parse(localStorage.getItem("test-chat-history") ?? "null"),
      save: async (history) => {
        localStorage.setItem("test-chat-history", JSON.stringify(history));
      },
      openLogin: async () => {},
      openLink: async (url) => {
        mock.openedLinks.push(url);
      },
      rpc: async (method, params: any) => {
        if (method === "account/read")
          return { account: { type: "chatgpt", planType: "plus" } };
        if (method === "model/list")
          return {
            data: [
              {
                id: "test-model",
                model: "test-model",
                displayName: "Test model",
                isDefault: true,
                defaultReasoningEffort: "medium",
              },
            ],
          };
        if (method === "thread/start") {
          mock.threadParams = params;
          return { thread: { id: "chat-thread" } };
        }
        if (method === "thread/resume") {
          mock.resumeParams = params;
          return { thread: { id: "chat-thread" } };
        }
        if (method === "turn/start") {
          const turnId = `turn-${++counter}`;
          mock.turnId = turnId;
          setTimeout(() => {
            notify({
              method: "turn/started",
              params: { threadId: "chat-thread", turn: { id: turnId } },
            });
            notify({
              method: "item/agentMessage/delta",
              params: {
                threadId: "chat-thread",
                itemId: `message-${turnId}`,
                delta: "I’ll update the map.",
              },
            });
            if (mock.mode === "hold") return;
            notify({
              id: counter + 100,
              method: "item/tool/call",
              params: {
                threadId: "chat-thread",
                turnId,
                callId: `tool-${turnId}`,
                tool:
                  mock.mode === "snapshot" ? "get_map_snapshot" : "control_app",
                arguments: {
                  method: mock.mode.startsWith("snapshot") ? "GET" : "PATCH",
                  path: mock.mode.startsWith("snapshot")
                    ? "/api/v1/current-map/snapshot"
                    : mock.mode === "connection"
                      ? "/api/v1/connection"
                      : mock.mode === "blocked"
                        ? "/api/v1/chat/messages?query=1"
                        : "/api/v1/maps/coffee-shop/components/experience",
                  body: { label: "Updated by assistant", stage: 2 },
                },
              },
            });
          }, 20);
          if (mock.mode === "queued")
            return new Promise((resolve) =>
              setTimeout(() => resolve({ turn: { id: turnId } }), 700),
            );
          return { turn: { id: turnId } };
        }
        if (method === "turn/interrupt") {
          mock.interrupted = true;
          setTimeout(
            () =>
              notify({
                method: "turn/completed",
                params: {
                  threadId: "chat-thread",
                  turn: { id: mock.turnId, status: "interrupted" },
                },
              }),
            20,
          );
          return {};
        }
        if (method === "account/login/start")
          return {
            loginId: "login",
            userCode: "TEST-CODE",
            verificationUrl: "https://auth.openai.com/codex/device",
          };
        return {};
      },
      reply: async (id, result: any) => {
        mock.replies.push({ id, result });
        notify({
          method: "item/completed",
          params: {
            threadId: "chat-thread",
            item: {
              type: "agentMessage",
              id: `message-${mock.turnId}`,
              text: result.success
                ? "Updated the component and its stage."
                : "The tool was blocked.",
            },
          },
        });
        notify({
          method: "turn/completed",
          params: {
            threadId: "chat-thread",
            turn: { id: mock.turnId, status: "completed" },
          },
        });
      },
    };
  });
  await page.goto("/");
  await page.locator('[data-action="chat"]').click();
  await expect(page.locator("#chat-account")).toContainText("ChatGPT · plus");
});

test("assistant cannot change workspace connections or access credentials", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => !!window.wardleyApi);
  await page.evaluate(() => {
    (window as any).__chatMock.mode = "connection";
  });
  await page.evaluate(() =>
    window.wardleyApi!.request("POST", "/api/v1/chat/messages", {
      text: "Change connection",
    }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).__chatMock.replies.length))
    .toBeGreaterThan(0);
  expect(
    JSON.stringify(
      await page.evaluate(() => (window as any).__chatMock.replies),
    ),
  ).toContain("This route is not available");
});

test("chat streams tool actions into the live map, saves and supports Undo", async ({
  page,
}) => {
  const original = await page
    .locator('[data-node="experience"]')
    .getAttribute("transform");
  await page
    .locator("#chat-input")
    .fill("Rename the experience component and move it to Product.");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-messages")).toContainText(
    "Updated the component and its stage.",
  );
  await expect(page.locator('[data-node="experience"]')).toHaveAttribute(
    "aria-label",
    /Updated by assistant.*Product \(\+ rental\)/,
  );
  await expect(page.locator("#chat-panel")).toBeVisible();
  await expect(page.locator("#chat-send")).toBeEnabled();
  const tools = await page.evaluate(() =>
    (window as any).__chatMock.threadParams.dynamicTools.map(
      (tool: any) => tool.name,
    ),
  );
  expect(tools).toEqual([
    "get_map_snapshot",
    "get_current_map",
    "list_app_routes",
    "control_app",
  ]);
  await page.screenshot({
    path: "test-results/chat.png",
    animations: "disabled",
  });
  await page.locator('[data-action="undo"]').click();
  await expect(page.locator('[data-node="experience"]')).toHaveAttribute(
    "transform",
    original!,
  );
  await expect(page.locator("#chat-messages")).toContainText(
    "Updated the component",
  );
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("test-chat-history")!).messages
            .length,
      ),
    )
    .toBeGreaterThan(2);
  await page.reload();
  await page.locator('[data-action="chat"]').click();
  await expect(page.locator("#chat-messages")).toContainText(
    "Updated the component",
  );
  await page.locator('[data-chat="reset"]').click();
  await expect(page.locator(".chat-message")).toHaveCount(0);
});

test("read-only chat and route boundaries prevent unauthorized tool actions", async ({
  page,
}) => {
  await page.locator("#chat-edits").uncheck();
  await page.locator("#chat-input").fill("Suggest a change.");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-messages")).toContainText(
    "Map editing is disabled",
  );
  await expect(page.locator('[data-node="experience"]')).toHaveAttribute(
    "aria-label",
    /In-store experience/,
  );
  await expect(page.locator("#chat-send")).toBeEnabled();
  await page.locator("#chat-edits").check();
  await page.evaluate(() => {
    (window as any).__chatMock.mode = "blocked";
  });
  await page.locator("#chat-input").fill("Do a task.");
  await page.locator("#chat-send").click();
  await expect(page.locator("#chat-messages")).toContainText(
    "This route is not available",
  );
  expect(
    await page.evaluate(() =>
      (window as any).__chatMock.replies.every(
        (reply: any) => !reply.result.success,
      ),
    ),
  ).toBe(true);
});

test("Stop interrupts generation; draft and sidebar survive editor redraws", async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as any).__chatMock.mode = "hold";
  });
  await page.locator("#chat-input").fill("Think about this map.");
  await page.locator("#chat-input").press("Enter");
  await expect(page.locator('[data-chat="stop"]')).toBeVisible();
  await page.locator("#chat-input").fill("A follow-up draft");
  await page.locator('[data-action="drawer-components"]').click();
  await expect(page.locator("#chat-input")).toHaveValue("A follow-up draft");
  await page.locator('[data-chat="stop"]').click();
  await expect(page.locator("#chat-send")).toBeEnabled();
  expect(
    await page.evaluate(() => (window as any).__chatMock.interrupted),
  ).toBe(true);
  await page.setViewportSize({ width: 1050, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator("#chat-input")).toBeInViewport();
  await page.locator('[data-chat="close"]').click();
  await expect(page.locator("#chat-panel")).toBeHidden();
  await expect(page.locator('[data-action="chat"]')).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("Stop cancels a tool queued behind an API-started chat turn", async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as any).__chatMock.mode = "queued";
    (window as any).__pendingChat = window.wardleyApi!.request(
      "POST",
      "/api/v1/chat/messages",
      { text: "Update the map." },
    );
  });
  await expect(page.locator(".chat-message.tool")).toContainText("running");
  await page.locator('[data-chat="stop"]').click();
  await expect(page.locator(".chat-message.tool")).toContainText(
    "stopped before this action ran",
  );
  await expect(page.locator('[data-node="experience"]')).toHaveAttribute(
    "aria-label",
    /In-store experience/,
  );
  await expect(page.locator("#chat-send")).toBeEnabled();
});

test("assistant Markdown renders while streaming and after history reload", async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as any).__chatMock.mode = "hold";
  });
  await page.locator("#chat-input").fill("Describe the repair map.");
  await page.locator("#chat-send").click();
  await expect(page.locator(".chat-message.assistant")).toBeVisible();
  const reply = page.locator('[data-message="markdown-reply"]');
  const emitDelta = async (delta: string) =>
    page.evaluate((delta) => {
      (window as any).__chatMock.emit({
        method: "item/agentMessage/delta",
        params: { threadId: "chat-thread", itemId: "markdown-reply", delta },
      });
    }, delta);
  await emitDelta("The map focuses on **Repair my");
  await expect(reply).toContainText("Repair my");
  await emitDelta(" car** with *six activities*.");
  await expect(reply.locator("strong")).toHaveText("Repair my car");
  await expect(reply.locator("em")).toHaveText("six activities");
  const text =
    'The map focuses on **Repair my car** with *six activities*.\n\n### Activities\n\n1. Identify the vehicle\n2. Diagnose\n   - Check `fault codes`\n\n> Confirm the work.\n\n```json\n{"stage": 2}\n```\n\n| Component | Stage |\n| --- | --- |\n| Repair | Product |\n\n[Reference](https://example.com/map)\n\n<script>window.markdownInjected = true</script>\n\n<img src="https://example.com/tracker" onerror="window.markdownInjected = true">\n\n[Unsafe](javascript:alert(1))\n\n![Diagram](https://example.com/image.png)';
  await page.evaluate((text) => {
    const mock = (window as any).__chatMock;
    mock.emit({
      method: "item/completed",
      params: {
        threadId: "chat-thread",
        item: { type: "agentMessage", id: "markdown-reply", text },
      },
    });
    mock.emit({
      method: "turn/completed",
      params: {
        threadId: "chat-thread",
        turn: { id: mock.turnId, status: "completed" },
      },
    });
  }, text);
  await expect(reply.locator("h3")).toHaveText("Activities");
  await expect(reply.locator("ol > li")).toHaveCount(2);
  await expect(reply.locator("ul code")).toHaveText("fault codes");
  await expect(reply.locator("blockquote")).toContainText("Confirm the work.");
  await expect(reply.locator("pre code")).toContainText('{"stage": 2}');
  await expect(reply.locator("td")).toHaveText(["Repair", "Product"]);
  await expect(reply.locator("script, img")).toHaveCount(0);
  await expect(reply.locator("a")).toHaveCount(1);
  await reply.getByRole("link", { name: "Reference" }).click();
  expect(
    await page.evaluate(() => (window as any).__chatMock.openedLinks),
  ).toEqual(["https://example.com/map"]);
  expect(
    await page.evaluate(() => (window as any).markdownInjected),
  ).toBeUndefined();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("test-chat-history") ?? "{}",
          ).messages?.find((m: any) => m.id === "markdown-reply")?.text,
      ),
    )
    .toBe(text);
  await page.reload();
  await page.locator('[data-action="chat"]').click();
  await expect(reply.locator("strong")).toHaveText("Repair my car");
  await page.setViewportSize({ width: 1050, height: 700 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await reply.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/chat-markdown.png",
    animations: "disabled",
  });
});

test("web search tracks activity, preserves sources, and applies preferences on resume", async ({
  page,
}) => {
  await page.evaluate(() => {
    (window as any).__chatMock.mode = "hold";
  });
  await page.locator("#chat-edits").uncheck();
  await expect(page.locator("#chat-web-search")).toBeChecked();
  await page.locator("#chat-input").fill("Research vehicle repair services.");
  await page.locator("#chat-send").click();
  await expect(page.locator(".chat-message.assistant")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).__chatMock.threadParams.config.web_search,
    ),
  ).toBe("live");
  await expect(page.locator("#chat-web-search")).toBeDisabled();
  const blocked = await page.evaluate(() =>
    window.wardleyApi!.request("PATCH", "/api/v1/chat", { webSearch: false }),
  );
  expect(blocked.status).toBe(409);
  await page.evaluate(() => {
    (window as any).__chatMock.emit({
      method: "item/started",
      params: {
        threadId: "chat-thread",
        item: {
          type: "webSearch",
          id: "search-1",
          query: "vehicle repair services",
          action: {
            type: "search",
            queries: ["vehicle repair services", "repair supply chain"],
          },
        },
      },
    });
  });
  const search = page.locator('[data-message="search-1"]');
  await expect(search).toContainText("running");
  await expect(search).toContainText(
    "Search: vehicle repair services; repair supply chain",
  );
  await page.evaluate(() => {
    const mock = (window as any).__chatMock;
    mock.emit({
      method: "item/completed",
      params: {
        threadId: "chat-thread",
        item: {
          type: "webSearch",
          id: "search-1",
          query: "vehicle repair services",
          action: { type: "search", query: "vehicle repair services" },
        },
      },
    });
    mock.emit({
      method: "item/completed",
      params: {
        threadId: "chat-thread",
        item: {
          type: "webSearch",
          id: "search-2",
          query: "",
          action: { type: "openPage", url: "https://example.com/repair" },
        },
      },
    });
    mock.emit({
      method: "item/completed",
      params: {
        threadId: "chat-thread",
        item: {
          type: "agentMessage",
          id: "research-reply",
          text: "Repair depends on diagnosis and parts. [Source](https://example.com/repair)",
        },
      },
    });
    mock.emit({
      method: "turn/completed",
      params: {
        threadId: "chat-thread",
        turn: { id: mock.turnId, status: "completed" },
      },
    });
  });
  await expect(search).toContainText("done");
  await expect(page.locator('[data-message="search-1"]')).toHaveCount(1);
  await expect(page.locator('[data-message="search-2"]')).toContainText(
    "Open page: https://example.com/repair",
  );
  await page.getByRole("link", { name: "Source", exact: true }).click();
  expect(
    await page.evaluate(() => (window as any).__chatMock.openedLinks),
  ).toEqual(["https://example.com/repair"]);
  await expect(page.locator('[data-node="experience"]')).toHaveAttribute(
    "aria-label",
    /In-store experience/,
  );
  const changed = await page.evaluate(() =>
    window.wardleyApi!.request("PATCH", "/api/v1/chat", { webSearch: false }),
  );
  expect(changed.status).toBe(200);
  await expect(page.locator("#chat-web-search")).not.toBeChecked();
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("test-chat-history") ?? "{}")
            .webSearch,
      ),
    )
    .toBe(false);
  await page.reload();
  await page.locator('[data-action="chat"]').click();
  await expect(page.locator("#chat-web-search")).not.toBeChecked();
  await expect(
    page.getByRole("link", { name: "Source", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).__chatMock.mode = "hold";
  });
  await page
    .locator("#chat-input")
    .fill("Summarize without further searching.");
  await page.locator("#chat-send").click();
  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as any).__chatMock.resumeParams?.config.web_search,
      ),
    )
    .toBe("disabled");
  await page.locator('[data-chat="stop"]').click();
  await expect(page.locator("#chat-send")).toBeEnabled();
  await page.locator("#chat-web-search").check();
  await page.locator("#chat-input").fill("Search again.");
  await page.locator("#chat-send").click();
  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as any).__chatMock.resumeParams?.config.web_search,
      ),
    )
    .toBe("live");
  await page.evaluate(() => {
    (window as any).__chatMock.emit({
      method: "item/started",
      params: {
        threadId: "chat-thread",
        item: { type: "webSearch", id: "search-interrupted", query: "repair" },
      },
    });
  });
  await page.locator('[data-chat="stop"]').click();
  await expect(
    page.locator('[data-message="search-interrupted"]'),
  ).toContainText("interrupted");
});

test("snapshot tools send real image content, including through existing control_app threads", async ({
  page,
}) => {
  await page.locator("#chat-edits").uncheck();
  for (const mode of ["snapshot", "snapshot-route"]) {
    await page.evaluate((mode) => {
      (window as any).__chatMock.mode = mode;
    }, mode);
    await page
      .locator("#chat-input")
      .fill("Inspect the map layout without editing it.");
    await page.locator("#chat-send").click();
    await expect(page.locator("#chat-send")).toBeEnabled();
    const result = await page.evaluate(
      () => (window as any).__chatMock.replies.at(-1).result,
    );
    expect(result.success).toBe(true);
    expect(result.contentItems.map((item: any) => item.type)).toEqual([
      "inputText",
      "inputImage",
    ]);
    expect(result.contentItems[1].imageUrl).toMatch(
      /^data:image\/png;base64,iVBOR/,
    );
    const metadata = JSON.parse(result.contentItems[0].text).body;
    expect(metadata.mapId).toBe("coffee-shop");
    expect(metadata.width).toBe(1650);
    expect(metadata.components.length).toBeGreaterThan(0);
    expect(metadata.dataUrl).toBeUndefined();
    await expect(page.locator('[data-node="experience"]')).toHaveAttribute(
      "aria-label",
      /In-store experience/,
    );
  }
  await expect
    .poll(async () =>
      page.evaluate(() => localStorage.getItem("test-chat-history")),
    )
    .not.toBeNull();
  expect(
    await page.evaluate(() => localStorage.getItem("test-chat-history")),
  ).not.toContain("data:image/png");
});
