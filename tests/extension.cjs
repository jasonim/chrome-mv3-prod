// Optional real-extension integration check; requires Playwright and Chromium.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");

(async () => {
  const extension = path.resolve(__dirname, "..");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "x-article-extension-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {channel: "chromium"}),
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.background.service_worker, "static/background/service-worker.js");
    assert.equal(manifest.content_scripts[0].js[0], "article.js");
    const header = '<div data-testid="User-Name"><a href="/Mileson07">超级峰</a><a href="/Mileson07">@Mileson07</a></div><a href="/Mileson07/status/123"><time datetime="2026-09-19"></time></a>';
    const reader = '<div data-testid="twitterArticleReadView"><h1 data-testid="twitter-article-title">扩展全文测试</h1><div data-testid="twitterArticleRichTextView"><p>第一段正文。</p><p>第二段正文。</p></div></div>';
    const wrap = content => `<!doctype html><html><meta charset="utf-8"><style>body{background:white;color:black;font-family:sans-serif}</style><main data-testid="primaryColumn"><article data-testid="tweet">${header}${content}<div role="group"><button data-testid="reply">回复</button></div></article></main></html>`;
    await context.route("https://x.com/**", route => route.fulfill({status: 200, contentType: "text/html",
      body: route.request().url().includes("/article/") || route.request().url().endsWith("/article")
        ? wrap(reader) : wrap('<a href="https://x.com/i/article/456">阅读文章</a>')}));
    const page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(12000);
    const expected = "扩展全文测试\n\n第一段正文。\n\n第二段正文。";
    await page.goto("https://x.com/Mileson07/status/123/article");
    await page.locator('[data-x-dist-btn] button').first().click();
    await page.waitForFunction(text => document.querySelector("#x-dist-panel-host")?.shadowRoot.querySelector("textarea")?.value === text, expected);
    assert.equal(await page.locator('#x-dist-panel-host input[type="text"]').inputValue(), "扩展全文测试");
    console.log("PASS: real content scripts extract an Article into the React panel");

    const newTabs = [];
    const navigationErrors = [];
    context.on("page", tab => {
      newTabs.push(tab);
      // Chrome extension-created tabs can navigate before Playwright attaches
      // its network routes. Navigate again once attached to serve the fixture.
      tab.goto("https://x.com/i/article/456").catch(error => navigationErrors.push(String(error)));
    });
    await page.goto("https://x.com/Mileson07/status/123");
    await page.locator('[data-x-dist-btn] button').first().click();
    try {
      await page.waitForFunction(text => document.querySelector("#x-dist-panel-host")?.shadowRoot.querySelector("textarea")?.value === text, expected, {timeout: 25000});
    } catch (error) {
      console.error("Article load diagnostics:", JSON.stringify(await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        return Promise.all(tabs.map(async tab => ({url: tab.url, status: tab.status,
          details: await chrome.scripting.executeScript({target: {tabId: tab.id}, func: () => ({
            ready: document.readyState, helper: Boolean(globalThis.XDistArticle), article: globalThis.XDistArticle?.readPage(),
            panel: document.querySelector("#x-dist-panel-host")?.shadowRoot.querySelector("textarea")?.value,
            alerts: Array.from(document.querySelector("#x-dist-panel-host")?.shadowRoot.querySelectorAll("span") || []).map(node => node.textContent).filter(text => text.includes("读取"))
          })}).catch(error => String(error))})));
      }), null, 2));
      throw error;
    }
    for (let i = 0; i < 30 && newTabs.some(tab => !tab.isClosed()); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(newTabs.length, 1);
    assert.deepEqual(navigationErrors, []);
    assert.ok(newTabs.every(tab => tab.isClosed()), "temporary article tab was not closed");
    assert.equal(await page.locator("#x-dist-panel-host textarea").isDisabled(), false);
    assert.equal(page.url(), "https://x.com/Mileson07/status/123");
    if (process.env.X_ARTICLE_SCREENSHOT) await page.screenshot({path: process.env.X_ARTICLE_SCREENSHOT});
    console.log("PASS: native MV3 messages load a card's full article and close its background tab");
  } finally {
    if (context) await context.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
