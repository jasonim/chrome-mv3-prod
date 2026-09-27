/* Runs the actual packaged extractor and React panel against browser DOM fixtures. */
(async () => {
  const results = [];
  const fixture = document.querySelector("#fixture");
  const extract = parcelRequire3937("fevKs").extractTweet;
  const panel = () => document.querySelector("#x-dist-panel-host").shadowRoot;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  function assert(condition, message) { if (!condition) throw new Error(message); }
  async function until(predicate) {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await pause(25);
    }
    throw new Error("Timed out waiting for the panel");
  }
  async function test(name, run) {
    try { await run(); results.push({name, ok: true}); }
    catch (error) { results.push({name, ok: false, error: error.stack || String(error)}); }
    document.querySelector("#results").textContent = JSON.stringify(results, null, 2);
  }
  const photo = id => `<div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/${id}?format=jpg&name=small"></div>`;
  const tweet = (body, id = "2101167448448004249") => `<article data-testid="tweet" id="tweet-${id}">
    <div data-testid="User-Name"><a href="/Mileson07">超级峰</a><a href="/Mileson07">@Mileson07</a></div>
    <a href="/Mileson07/status/${id}"><time datetime="2026-09-19T00:00:00Z"></time></a>
    ${body}<div role="group"><button data-testid="reply">回复</button></div></article>`;
  const reader = body => `<div data-testid="twitterArticleReadView">
    <h1 data-testid="twitter-article-title">Jev 新手教程</h1>
    <div data-testid="twitterArticleRichTextView">${body}</div>${photo("article-photo")}</div>`;
  const card = '<a href="https://x.com/i/article/2101166175178928128">阅读文章</a>' + photo("cover");
  function mount(html, path = "/Mileson07/status/2101167448448004249") {
    history.replaceState(null, "", path);
    fixture.innerHTML = html;
    return fixture.querySelector('article') || fixture.querySelector('[data-testid="twitterArticleReadView"]');
  }
  async function open(target) {
    const expected = extract(target);
    // Fixtures can change history while a panel is open. Close it before the
    // next case so the product's navigation-close timer cannot close that case.
    const close = panel().querySelector('button[aria-label="关闭"]');
    if (close) {
      close.click();
      await until(() => !panel().querySelector("textarea"));
    }
    await until(() => target.querySelector('[data-x-dist-btn] button'));
    target.querySelector('[data-x-dist-btn] button').click();
    await until(() => {
      const textarea = panel().querySelector("textarea");
      return textarea && (!expected.isArticle || !expected.articleLoaded || textarea.value === expected.text);
    });
    await pause(30);
  }
  const publishButton = () => Array.from(panel().querySelectorAll("button")).find(node => /分发到 \d+ 个平台/.test(node.textContent));
  const remote = {isArticle: true, articleLoaded: true, articleTitle: "完整文章标题", text: "完整文章标题\n\n后台加载的全文", media: []};
  await pause(100);

  await test("普通推文正文、图片及视频识别不变", () => {
    const target = mount(tweet('<div data-testid="tweetText" style="white-space:pre-wrap">普通正文\n第二行</div>' + photo("normal")));
    const value = extract(target);
    assert(value.text === "普通正文\n第二行", "normal text changed");
    assert(value.media.length === 1 && !value.isArticle && !value.hasVideo, "normal media changed");
    target.insertAdjacentHTML("beforeend", '<video poster="https://pbs.twimg.com/media/poster.jpg"></video>');
    assert(extract(target).hasVideo, "normal video detection changed");
  });
  await test("Article 标题、段落、列表、emoji 和代码缩进", () => {
    const target = mount(tweet(reader('<p>第一段<span>，继续</span><img src="https://abs.twimg.com/emoji/v2/1.svg" alt="🔥"></p><p>第二段<br>换行</p><ul><li>步骤一</li><li>步骤二</li></ul><pre><code>if (ok) {\n  run();\n}</code></pre>')));
    const value = extract(target);
    assert(value.articleLoaded && value.articleTitle === "Jev 新手教程", "title/body not detected");
    assert(value.text === "Jev 新手教程\n\n第一段，继续🔥\n\n第二段\n换行\n\n• 步骤一\n\n• 步骤二\n\nif (ok) {\n  run();\n}", "body formatting changed: " + value.text);
    assert(value.media.length === 1 && value.media[0].url.includes("article-photo"), "article photo missing");
  });
  await test("排除嵌入推文、隐藏内容和操作按钮，图片去重", () => {
    const target = mount(tweet(reader('<p>正文</p><button>关注</button><div hidden>隐藏正文</div>' + tweet('<div data-testid="tweetText">引用内容</div>' + photo("quoted"), "777") + photo("article-photo"))));
    const value = extract(target);
    assert(value.text === "Jev 新手教程\n\n正文", "unrelated content leaked");
    assert(value.media.length === 1, "quoted image leaked or duplicate retained");
  });
  await test("详情页的相邻正文仅绑定主帖，不串到评论", () => {
    mount(tweet("") + reader("<p>主文章正文</p>") + tweet('<div data-testid="tweetText">评论正文</div>', "999"));
    assert(extract(document.querySelector("#tweet-2101167448448004249")).text.includes("主文章正文"), "sibling reader missing");
    const comment = extract(document.querySelector("#tweet-999"));
    assert(comment.text === "评论正文" && !comment.isArticle, "comment inherited article");
  });
  await test("没有 richText 容器时支持 Draft.js 段落", () => {
    const target = mount(tweet('<div data-testid="twitterArticleReadView"><h1 data-testid="twitter-article-title">Draft 标题</h1><section data-block="true"><div data-block="true">第一段</div></section><section data-block="true">第二段</section></div>'));
    assert(extract(target).text === "Draft 标题\n\n第一段\n\n第二段", "Draft blocks missing or duplicated");
  });
  await test("多个富文本区段完整合并，加载中的正文不标记为完整", () => {
    const target = mount(tweet('<div data-testid="twitterArticleReadView"><h1>分段文章</h1><div data-testid="longformRichTextComponent"><p>第一段</p></div><div data-testid="longformRichTextComponent"><p>第二段</p></div></div>'));
    assert(extract(target).text === "分段文章\n\n第一段\n\n第二段", "multiple body containers lost text");
    target.querySelector('[data-testid="twitterArticleReadView"]').insertAdjacentHTML("beforeend", '<div role="progressbar"></div>');
    assert(!extract(target).articleLoaded, "loading body treated as complete");
  });
  await test("配图顺序包含封面、富文本内图片、区段间图片及重复引用", () => {
    const target = mount(tweet(`<div data-testid="twitterArticleReadView">${photo("cover")}<h1>图文长文</h1>
      <div data-testid="longformRichTextComponent"><p>第一段🔥</p><div role="button">${photo("inline")}查看图片</div><p>第二段</p></div>
      ${photo("between")}<div data-testid="longformRichTextComponent"><p>第三段</p>${photo("inline")}<pre>if (ok) {\n  run();\n}</pre></div>
      <div hidden>${photo("hidden")}</div><div data-testid="quoteTweet">${photo("quote")}</div></div>`));
    const value = extract(target);
    const order = value.articleBlocks.map(block => block.type === "text" ? block.text : new URL(block.url).pathname.split("/").pop());
    assert(JSON.stringify(order) === JSON.stringify(["cover", "第一段🔥", "inline", "第二段", "between", "第三段", "inline", "if (ok) {\n  run();\n}"]), "wrong text/image order: " + JSON.stringify(order));
    assert(value.media.length === 3, "hidden images included or repeated source downloaded twice");
  });
  await test("同一段中的图片保留前后文字边界", () => {
    const value = extract(mount(tweet(reader('<p>图前<img src="https://pbs.twimg.com/media/inline.jpg">图后</p>'))));
    assert(value.text === "Jev 新手教程\n\n图前\n\n图后", "inline photo joined unrelated text");
    assert(value.articleBlocks[0].text === "图前" && value.articleBlocks[1].type === "image" && value.articleBlocks[2].text === "图后", "inline photo position lost");
  });
  await test("未编辑的含图列表、缩进代码及隐藏副本可以直接准备长文", () => {
    const cases = [
      {html: `<div data-testid="longformRichTextComponent"><ul><li>${photo("first")}<p>步骤一</p></li><li>步骤二</li></ul></div>`, expected: "• 步骤一\n\n• 步骤二"},
      {html: `<div data-testid="longformRichTextComponent"><p>代码示例</p>${photo("code")}<pre>\n  run();\n    nested();\n</pre></div>`, expected: "代码示例\n\n  run();\n    nested();"},
      {html: `<div hidden><div data-testid="longformRichTextComponent"><p>隐藏副本</p></div></div>${photo("cover")}<div data-testid="longformRichTextComponent"><p>可见正文</p></div>`, expected: "可见正文"}
    ];
    for (const {html, expected} of cases) {
      const target = mount(tweet(`<div data-testid="twitterArticleReadView"><h1>测试标题</h1>${html}</div>`));
      const article = extract(target);
      assert(article.text === "测试标题\n\n" + expected, "canonical text lost content: " + article.text);
      const layout = XDistArticleMedia.layout({content: article.text, articleTitle: article.articleTitle, articleBlocks: article.articleBlocks, images: article.media});
      assert(layout.filter(block => block.type === "text").map(block => block.text).join("\n\n") === expected, "unchanged article rejected or rewritten");
      assert(layout.some(block => block.type === "image"), "images lost during alignment");
    }
  });
  await test("独立 Article 阅读页也有分发入口", async () => {
    const target = mount(reader("<p>独立阅读页正文</p>"), "/i/article/2101166175178928128");
    await open(target);
    assert(panel().querySelector("textarea").value === "Jev 新手教程\n\n独立阅读页正文", "standalone body missing");
    assert(panel().querySelector('input[type="text"]').value === "Jev 新手教程", "panel title missing");
  });
  await test("现有 React 面板显示全文并传入发布数据", async () => {
    sentMessages.length = 0;
    const target = mount(tweet(reader("<p>分发正文</p>")));
    await open(target);
    assert(panel().querySelector("textarea").value === "Jev 新手教程\n\n分发正文", "panel body missing");
    publishButton().click();
    await until(() => sentMessages.some(message => message.action === "X_DIST_OPEN_PUBLISH"));
    const payload = sentMessages.find(message => message.action === "X_DIST_OPEN_PUBLISH").data.data;
    assert(payload.content === "Jev 新手教程\n\n分发正文" && payload.title === "Jev 新手教程", "outbound article missing");
    assert(payload.isArticle && payload.articleTitle === "Jev 新手教程", "Article routing metadata missing");
    assert(payload.articleBlocks?.some(block => block.type === "image") && payload.articleBlocks[0].text === "分发正文", "ordered image metadata lost in panel");
  });
  await test("无图片 Article 可选小红书长文，长标题不截断", async () => {
    const title = "完整标题".repeat(20);
    sentMessages.length = 0;
    const target = mount(tweet(`<div data-testid="twitterArticleReadView"><h1 data-testid="twitter-article-title">${title}</h1><div data-testid="twitterArticleRichTextView"><p>无配图长文正文</p></div></div>`));
    await open(target);
    assert(panel().querySelector('input[type="text"]').value === title, "long title truncated");
    assert(panel().textContent.includes("小红书 · 长文写作"), "longform mode not identified");
    publishButton().click();
    await until(() => sentMessages.some(message => message.action === "X_DIST_OPEN_PUBLISH"));
    const payload = sentMessages.find(message => message.action === "X_DIST_OPEN_PUBLISH").data;
    assert(payload.platforms.some(item => item.name === "DYNAMIC_REDNOTE"), "text-only Article blocked for Xiaohongshu");
    assert(payload.data.title === title && payload.data.images.length === 0, "title or media changed");
  });
  await test("文章卡片加载全文期间禁止提交，完成后填入正文", async () => {
    let complete;
    messageHandler = message => message.action === "X_DIST_READ_ARTICLE" ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ok: false});
    const target = mount(tweet(card));
    await open(target);
    assert(panel().querySelector("textarea").disabled && publishButton().disabled, "loading not guarded");
    assert(panel().textContent.includes("正在读取文章正文"), "article loading label missing");
    complete({ok: true, article: remote});
    await until(() => panel().querySelector("textarea").value === remote.text);
    assert(!panel().querySelector("textarea").disabled, "loading not released");
  });
  await test("卡片解析失败给出提示，并阻止把摘要当作全文提交", async () => {
    sentMessages.length = 0;
    messageHandler = async () => ({ok: false});
    const target = mount(tweet('<div data-testid="tweetText">这只是文章摘要</div>' + card));
    await open(target);
    await until(() => !panel().querySelector("textarea").disabled);
    assert(panel().textContent.includes("文章正文读取失败"), "failure not shown");
    publishButton().click();
    await pause(50);
    assert(!sentMessages.some(message => message.action === "X_DIST_OPEN_PUBLISH"), "incomplete article submitted");
  });
  await test("切换帖子后迟到的文章响应不会覆盖新面板", async () => {
    let complete;
    messageHandler = message => message.action === "X_DIST_READ_ARTICLE" ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ok: false});
    await open(mount(tweet(card)));
    await open(mount(tweet('<div data-testid="tweetText">后来打开的帖子</div>' + photo("new"), "888")));
    complete({ok: true, article: remote});
    await pause(100);
    assert(panel().querySelector("textarea").value === "后来打开的帖子", "stale response overwrote current tweet");
  });
  await test("普通视频仍走原有视频解析流程", async () => {
    messageHandler = async message => message.action === "X_DIST_FETCH_TWEET_MEDIA" ?
      {ok: true, images: [], video: {kind: "video", url: "https://video.twimg.com/test.mp4", name: "test.mp4", type: "video/mp4"}} : {ok: false};
    await open(mount(tweet('<div data-testid="tweetText">视频正文</div><video></video>')));
    await until(() => !panel().querySelector("textarea").disabled);
    assert(panel().querySelector("textarea").value === "视频正文" && panel().textContent.includes("已识别：视频帖"), "video flow changed");
  });
  window.articleTestResults = results;
  window.articleTestsPassed = results.every(result => result.ok);
})();
