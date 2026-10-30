import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:8790";
const screenshotDir =
  process.env.QA_SCREENSHOT_DIR || resolve("docs/screenshots");
await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL
    ? { channel: process.env.PLAYWRIGHT_CHANNEL }
    : {}),
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1536, height: 1024 },
  permissions: ["clipboard-read", "clipboard-write"],
  acceptDownloads: true,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
const checks = [];
async function check(name, action) {
  await action();
  checks.push({ name, passed: true });
  console.log("PASS", name);
}
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await check("identity and meaningful first screen", async () => {
    assert.match(await page.title(), /知页 PaperTrail/);
    await page.getByRole("heading", { name: "从资料中，找到答案。" }).waitFor();
    await page
      .getByRole("button", { name: "检索", exact: true })
      .waitFor({ state: "visible" });
    await page.waitForFunction(
      () => !document.querySelector(".search-button")?.disabled,
    );
    assert.equal(await page.locator("vite-error-overlay").count(), 0);
  });
  await check(
    "hybrid search opens original source with exact title",
    async () => {
      await page.getByRole("button", { name: "检索", exact: true }).click();
      await page.locator(".result").first().waitFor();
      await page.waitForFunction(
        () => !document.querySelector(".source-panel .muted"),
      );
      assert.ok(await page.locator(".source-content").innerText());
      assert.equal(
        await page.locator(".result-title").first().innerText(),
        await page.locator(".source-title h3").innerText(),
      );
    },
  );
  await page.screenshot({
    path: resolve(screenshotDir, "search-desktop.png"),
    fullPage: false,
  });
  await check("copy citation and export original text with trace", async () => {
    await page.getByRole("button", { name: "复制引用", exact: true }).click();
    assert.match(
      await page.evaluate(() => navigator.clipboard.readText()),
      /PaperTrail:[a-f0-9]{32}_\d+/,
    );
    const downloadEvent = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出结果", exact: true }).click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), "检索结果.md");
  });
  await check("bookmark survives browser reload", async () => {
    const button = page.locator(".save-button").first();
    if ((await button.getAttribute("aria-pressed")) === "true") {
      await button.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector(".save-button")
            ?.getAttribute("aria-pressed") === "false",
      );
    }
    await button.click();
    await page.waitForFunction(
      () =>
        document.querySelector(".save-button")?.getAttribute("aria-pressed") ===
        "true",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /阅读清单/ }).click();
    await page.locator(".result").first().waitFor();
    assert.ok((await page.locator(".result").count()) >= 1);
  });
  await check(
    "keyword mode and empty state update real rendered results",
    async () => {
      await page.getByRole("button", { name: "检索资料", exact: true }).click();
      await page
        .getByRole("button", { name: "关键词检索", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "检索问题" })
        .fill("unfindablezzzz987654321");
      await page.getByRole("button", { name: "检索", exact: true }).click();
      await page
        .getByRole("heading", { name: "没有找到匹配的段落。" })
        .waitFor();
    },
  );
  await check(
    "semantic search and source filter use submitted controls",
    async () => {
      const docs = await (
        await page.request.get(base + "/api/documents")
      ).json();
      const id = docs.find((d) => d.title === "RAG 实践笔记").id;
      await page.getByLabel("资料范围").selectOption(id);
      await page.getByRole("button", { name: "语义检索", exact: true }).click();
      await page
        .getByRole("textbox", { name: "检索问题" })
        .fill("如何避免模型编造事实");
      const requestEvent = page.waitForRequest((r) =>
        r.url().endsWith("/api/search"),
      );
      await page.getByRole("button", { name: "检索", exact: true }).click();
      const data = (await requestEvent).postDataJSON();
      assert.equal(data.mode, "semantic");
      assert.equal(data.documentId, id);
      await page.locator(".result").first().waitFor();
      await page.waitForFunction(
        () => !document.querySelector(".search-button")?.disabled,
      );
    },
  );
  await check(
    "upload handles Chinese filename and reports duplicate",
    async () => {
      await page.getByRole("button", { name: "导入资料", exact: true }).click();
      const file = {
        name: "浏览器验证笔记.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          "浏览器验收专用资料。\n\n来源定位支持文件名和段落号。",
        ),
      };
      await page.getByLabel("选择资料文件").setInputFiles(file);
      await page.getByRole("button", { name: "导入并建立索引" }).click();
      await page.locator(".import-success").waitFor();
      assert.match(
        await page.locator(".import-success").innerText(),
        /浏览器验证笔记.txt/,
      );
      await page.waitForFunction(
        () =>
          !document.querySelector(".dialog-footer .primary")?.disabled ||
          !document.querySelector(".busy"),
      );
      await page.getByLabel("选择资料文件").setInputFiles(file);
      await page.getByRole("button", { name: "导入并建立索引" }).click();
      await page
        .getByText("浏览器验证笔记.txt：已存在，已跳过", { exact: true })
        .waitFor();
      await page.getByRole("button", { name: "关闭导入", exact: true }).click();
      assert.equal(await page.locator("dialog:visible").count(), 0);
    },
  );
  await check(
    "stored script is escaped in result and original preview",
    async () => {
      await page.getByLabel("资料范围").selectOption("");
      await page
        .getByRole("button", { name: "关键词检索", exact: true })
        .click();
      await page.getByRole("textbox", { name: "检索问题" }).fill("script");
      await page.getByRole("button", { name: "检索", exact: true }).click();
      await page.locator(".result").first().waitFor();
      await page.waitForFunction(() =>
        document
          .querySelector(".source-content")
          ?.textContent.includes("<script>"),
      );
      assert.equal(
        await page.evaluate(() => window.__papertrail_xss),
        undefined,
      );
    },
  );
  await page.getByRole("button", { name: "混合检索", exact: true }).click();
  await page
    .getByRole("textbox", { name: "检索问题" })
    .fill("如何减少检索增强生成中的幻觉？");
  await page.getByRole("button", { name: "检索", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector(".search-button")?.disabled,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await check(
    "mobile navigation and search fit without horizontal overflow",
    async () => {
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      );
      assert.ok(
        await page
          .getByRole("button", { name: "导入资料", exact: true })
          .isVisible(),
      );
      await page.getByRole("button", { name: "我的文献", exact: true }).click();
      await page.locator(".document-row").first().waitFor();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      );
      await page.getByRole("button", { name: "检索资料", exact: true }).click();
      await page
        .getByRole("button", { name: "查看原文", exact: true })
        .first()
        .click();
      await page.waitForFunction(() => {
        const panel = document.querySelector(".source-panel");
        // Near the document bottom the browser cannot align the panel at y=0;
        // the preview heading must still be visible in the upper viewport.
        return (
          panel &&
          panel.getBoundingClientRect().top >= 0 &&
          panel.getBoundingClientRect().top < window.innerHeight / 2
        );
      });
      await page.getByRole("button", { name: "关闭原文预览" }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  );
  await page.screenshot({
    path: resolve(screenshotDir, "search-mobile.png"),
    fullPage: false,
  });
  await check("no console or runtime errors", async () =>
    assert.deepEqual(errors, []),
  );
  await writeFile(
    resolve(screenshotDir, "browser-verification.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base,
        method: "Playwright Chromium",
        channel: process.env.PLAYWRIGHT_CHANNEL || "chromium",
        reason: "Browser plugin not available",
        viewports: ["1536x1024", "390x844"],
        checks,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
