const {test} = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const script = fs.readFileSync(path.join(__dirname, "../static/background/service-worker.js"), "utf8");

function harness(options = {}) {
  let listener, now = 0, reads = 0;
  const created = [], removed = [], responses = [], imports = [];
  const context = {
    URL, Date: {now: () => now},
    importScripts: (...names) => imports.push(...names),
    setTimeout: (callback, delay) => { now += delay; queueMicrotask(callback); },
    chrome: {
      runtime: {onMessage: {addListener: callback => { listener = callback; }}},
      tabs: {
        create: async options => { created.push(options); return {id: 42}; },
        get: async () => { if (options.closed) throw new Error("tab closed"); return {id: 42}; },
        remove: async id => { removed.push(id); }
      },
      scripting: {executeScript: async request => {
        assert.equal(request.target.tabId, 42);
        if (options.closed) throw new Error("tab closed");
        return [{result: options.read?.(++reads) || null}];
      }}
    }
  };
  vm.runInNewContext(script, context);
  return {created, removed, responses, imports,
    async request(message = {action: "X_DIST_READ_ARTICLE", url: "https://x.com/i/article/123"}, source = "https://x.com/home") {
      const pending = listener(message, {url: source}, response => responses.push(response));
      await new Promise(resolve => setImmediate(resolve));
      return pending;
    }};
}

test("loads the existing worker and ignores unrelated messages", async () => {
  const h = harness();
  assert.deepEqual(h.imports, ["rednote-longform.js", "index.js"]);
  assert.equal(await h.request({action: "X_DIST_FETCH_TWEET_MEDIA"}), false);
  assert.equal(h.created.length, 0);
});

test("waits for article content to settle, then closes only its own inactive tab", async () => {
  const h = harness({read: count => count < 3 ? null :
    {articleLoaded: true, text: count < 5 ? "first paragraph" : "complete article", media: []}});
  assert.equal(await h.request(), true);
  assert.equal(h.created[0].active, false);
  assert.equal(h.responses[0].article.text, "complete article");
  assert.deepEqual(h.removed, [42]);
});

test("times out on an unloaded or login page and closes the temporary tab", async () => {
  const h = harness();
  await h.request();
  assert.equal(h.responses[0].ok, false);
  assert.deepEqual(h.removed, [42]);
});

test("handles the temporary tab being closed without an unhandled rejection", async () => {
  const h = harness({closed: true});
  await h.request();
  assert.equal(h.responses[0].ok, false);
  assert.deepEqual(h.removed, [42]);
});

test("rejects other sites, script URLs and non-article routes before creating a tab", async () => {
  for (const url of ["https://example.com/i/article/123", "https://x.com.evil.test/i/article/123",
    "javascript:alert(1)", "https://x.com/home", "https://x.com/i/article/123/media/1"]) {
    const h = harness();
    await h.request({action: "X_DIST_READ_ARTICLE", url});
    assert.equal(h.created.length, 0, url);
    assert.equal(h.responses[0].ok, false, url);
  }
});

test("rejects callers outside X and supports the status/article route", async () => {
  const blocked = harness();
  await blocked.request(undefined, "https://example.com");
  assert.equal(blocked.created.length, 0);
  const h = harness({read: () => ({articleLoaded: true, text: "body", media: []})});
  await h.request({action: "X_DIST_READ_ARTICLE", url: "https://x.com/Mileson07/status/123/article?test=1"});
  assert.equal(h.created[0].url, "https://x.com/Mileson07/status/123/article");
  assert.equal(h.responses[0].ok, true);
});
