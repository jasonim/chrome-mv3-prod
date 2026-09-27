// Real TipTap transactions + native MV3 dispatch, with all website traffic mocked.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {createRequire} = require("node:module");

(async () => {
  const root = path.resolve(__dirname, "..");
  const depsRoot = process.env.EDITOR_TEST_DEPS || root;
  const deps = createRequire(path.join(depsRoot, "package.json"));
  const {outputFiles} = await deps("esbuild").build({bundle: true, write: false, format: "iife",
    stdin: {resolveDir: depsRoot, contents: `
      import {Editor, Extension, Node, nodePasteRule} from '@tiptap/core';
      import StarterKit from '@tiptap/starter-kit';
      import {Plugin} from '@tiptap/pm/state';
      import {Fragment, Slice} from '@tiptap/pm/model';
      window.startEditor = () => {
        const settings = window.fixtureSettings;
        document.querySelector('#workspace').innerHTML = '<textarea class="d-text" placeholder="输入标题"></textarea><div id="editor"></div><button id="format">一键排版</button><button id="next">下一步</button><button id="publish">发布</button>';
        const input = document.querySelector('textarea');
        input.value = settings.initialTitle || '';
        if (settings.titleLimit) input.maxLength = settings.titleLimit;
        window.titleModel = input.value;
        input.addEventListener('input', () => { window.titleModel = input.value; });
        for (const action of ['format', 'next', 'publish']) document.getElementById(action).onclick = () => window.actions[action]++;
        const limit = Extension.create({name:'fixtureLimit', addProseMirrorPlugins() {
          return settings.bodyLimit ? [new Plugin({filterTransaction: tr => tr.doc.textContent.length <= settings.bodyLimit})] : [];
        }});
        // Match the published Xiaohongshu write editor's image node shape and
        // async onPaste behavior (not a consuming handlePaste override).
        // With files alone, ProseMirror's capturePaste calls onPaste twice.
        // Upload traffic is mocked below.
        const picture = Node.create({name:'image', group:'block', atom:true,
          addAttributes(){return {imgs:{default:[]}};},
          parseHTML(){return [{tag:'div[data-dom-type="image"]'}];},
          renderHTML({node}){return ['div', {'data-dom-type':'image','class':'tt-image'}, ...node.attrs.imgs.map(img =>
            ['div', {'data-dom-type':'img-wrapper'}, ['img', {'data-dom-type':'img', src:img.src}]])];}
        });
        const emoji = Node.create({name:'redEmoji', group:'inline', inline:true, atom:true,
          addAttributes(){return {shortcode:{default:'[微笑]'}};},
          parseHTML(){return [{tag:'img[data-emoji-shortcode]'}];},
          renderHTML({node}){return ['img',{'data-emoji-shortcode':node.attrs.shortcode,src:'https://sns-webpic-qc.xhscdn.com/emoji.png',alt:node.attrs.shortcode}];},
          renderText({node}){return node.attrs.shortcode;},
          addPasteRules(){return [nodePasteRule({find:/\\[微笑\\]/g,type:this.type,getAttributes:()=>({shortcode:'[微笑]'})})];}
        });
        window.editor = new Editor({element:document.getElementById('editor'), extensions:[StarterKit, limit, picture, emoji],
          content:settings.initialContent || '<p></p>',
          // Match XHS's removal of empty/trailing pasted paragraphs, including
          // the Slice.empty result used when pasting only an empty paragraph.
          editorProps:{transformPasted(slice){
            const content=[], pending=[];
            slice.content.forEach(node => {
              const empty=node.type.name==='paragraph' && Array.from(node.content.content).every(child =>
                child.type.name==='hardBreak' || child.isText && !child.text.replace(/[\\s\\u200B-\\u200D\\uFEFF]/g,''));
              if (empty) { if (pending.length<2) pending.push(node); return; }
              content.push(...pending,node); pending.length=0;
            });
            if (!content.length) return Slice.empty;
            const fragment=Fragment.fromArray(content), open=Slice.maxOpen(fragment,true);
            return new Slice(fragment,Math.min(slice.openStart,open.openStart),pending.length ? 0 : Math.min(slice.openEnd,open.openEnd));
          }},
          onPaste(event){
            event.preventDefault();
            const files=Array.from(event.clipboardData?.files || []);
            window.pasteFiles=(window.pasteFiles||0)+files.length;
            for (const file of files) {
              fetch('/fixture-upload?attempt='+window.pasteFiles,{method:'POST',body:file}).then(async response => {
                if (!response.ok) throw new Error('upload failed');
                const {url}=await response.json();
                const editor=window.editor;
                const nodes=[{type:'image',attrs:{imgs:[{src:url}]}},{type:'paragraph'}];
                if (settings.duplicateImages) nodes.unshift({type:'image',attrs:{imgs:[{src:url}]}});
                const position=settings.imagePlacement==='start' ? 0 : editor.state.selection.to;
                editor.chain().insertContentAt(position,nodes).run();
              }).catch(() => {
                // Advance only the injected adapter's deadline, avoiding a real
                // minute of waiting when testing a rejected image upload.
                const now=Date.now.bind(Date); Date.now=()=>now()+61000;
              });
            }
          },
          onUpdate({editor}){window.savedDocument=editor.getJSON();}
        });
        if (settings.hideModel) window.editor.view.dom.editor = undefined;
      };
      if (window.fixtureSettings.direct) window.startEditor();
      else document.getElementById('long-tab').onclick = () => {
        window.actions.longTab++;
        document.querySelector('#workspace').innerHTML = '<button id="new">新的创作</button>';
        document.getElementById('new').onclick = () => { window.actions.newCreation++; setTimeout(window.startEditor, 100); };
      };
    `}});
  const editorBundle = outputFiles[0].text;
  const adapter = await fs.readFile(path.join(root, "static/background/rednote-longform.js"), "utf8");
  const mediaHelper = await fs.readFile(path.join(root, "tabs/article-media.js"), "utf8");
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "xhs-longform-browser-"));
  const title = "X Article 完整长标题：" + "长文写作同步验证".repeat(8);
  const body = '第一段：emoji 🔥，HTML 原文 <img src="bad" onerror="alert(1)"> & 特殊字符。\n\n' +
    Array.from({length: 100}, (_, i) => `第 ${i + 1} 段：完整正文不得截断。${"这是长文内容。".repeat(8)}`).join("\n\n") +
    '\n\n代码：\nif (ok) {\n  run();\n}\n\n最后一段。';
  const payload = {isAutoPublish: true, data: {isArticle: true, articleTitle: title, title, content: title + "\n\n" + body, images: []}};
  const normalize = text => text.replace(/\u00a0/g, " ").replace(/\n+/g, "\n").trim();
  let context, fixtureSettings = {}, websitePublishes = 0;
  const mediaDownloads = [];
  const uploads = [];
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const image = name => ({url: `https://pbs.twimg.com/media/${name}.png?name=orig`, name: `${name}.png`, type: "image/png"});
  let sourceHasImages = false;
  function fixture() {
    return `<!doctype html><meta charset="utf-8"><title>小红书长文编辑器测试</title>
      <style>body{font:16px/1.7 sans-serif;margin:30px;background:#fff}.ProseMirror{white-space:pre-wrap;border:1px solid #ccc;padding:16px}textarea{width:90%;height:80px}button{padding:8px;margin:8px}</style>
      ${fixtureSettings.login ? '<input placeholder="手机号"><input placeholder="验证码">' : ""}<div class="creator-tab" id="long-tab" style="${fixtureSettings.login ? "display:none" : ""}">写长文</div><div class="creator-tab">上传图文</div><div id="workspace"></div>
      <script>window.fixtureSettings=${JSON.stringify(fixtureSettings)};window.actions={longTab:0,newCreation:0,format:0,next:0,publish:0};</script>
      <script src="/fixture-editor.js"></script>`;
  }
  try {
    context = await chromium.launchPersistentContext(profile, {headless: true,
      ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {channel: "chromium"}),
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--host-resolver-rules=MAP * ~NOTFOUND"]});
    await context.route(/^https?:/, async route => {
      const url = new URL(route.request().url());
      if (url.hostname === "creator.xiaohongshu.com") {
        if (url.pathname === "/fixture-upload") {
          uploads.push(route.request().postDataBuffer());
          const uploadNumber=uploads.length;
          if (fixtureSettings.uploadDelay) await new Promise(resolve => setTimeout(resolve, fixtureSettings.uploadDelay));
          return route.fulfill({status: fixtureSettings.uploadFails || fixtureSettings.failFirstUpload && url.searchParams.get('attempt')==='1' ? 500 : 200, contentType: "application/json",
            body: JSON.stringify({url: `https://sns-webpic-qc.xhscdn.com/uploaded/${uploadNumber}.png`})});
        }
        if (route.request().method() !== "GET") { websitePublishes++; return route.abort(); }
        return route.fulfill({status: 200, contentType: url.pathname === "/fixture-editor.js" ? "application/javascript" : "text/html",
          body: url.pathname === "/fixture-editor.js" ? editorBundle : fixture()});
      }
      if (url.hostname === "x.com") {
        const escaped = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const photo = name => `<img src="${image(name).url}" alt="article photo">`;
        return route.fulfill({status: 200, contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><article data-testid="tweet"><div data-testid="User-Name"><a href="/tester">Tester</a><a href="/tester">@tester</a></div><a href="/tester/status/123"><time datetime="2026-09-21"></time></a><div data-testid="twitterArticleReadView">${sourceHasImages ? photo("cover") : ""}<h1 data-testid="twitter-article-title">${escaped(title)}</h1><div data-testid="twitterArticleRichTextView">${body.split("\n\n").map((text, index) => (text.startsWith("代码：") ? `<pre><code>${escaped(text)}</code></pre>` : `<p>${escaped(text).replace(/\n/g, "<br>")}</p>`) + (sourceHasImages && [0, 50].includes(index) ? photo("inline") : "")).join("")}${sourceHasImages ? photo("end") : ""}</div></div><div role="group"><button data-testid="reply">回复</button></div></article>`});
      }
      if (url.hostname === "pbs.twimg.com") {
        if (["fetch", "xhr"].includes(route.request().resourceType())) mediaDownloads.push(url.href);
        return route.fulfill({status: url.pathname.includes("broken") ? 404 : 200, contentType: "image/png", headers: {"access-control-allow-origin": "*"}, body: pixel});
      }
      if (url.hostname === "sns-webpic-qc.xhscdn.com") return route.fulfill({status: 200, contentType: "image/png", body: pixel});
      return route.abort();
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    async function run(settings, value = payload, url = "https://creator.xiaohongshu.com/publish/publish") {
      fixtureSettings = settings;
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForFunction(() => Boolean(window.startEditor));
      await page.addScriptTag({content: adapter});
      await page.addScriptTag({content: mediaHelper});
      if (value.data.images?.length && !settings.skipPreparation) value = await page.evaluate(async value =>
        ({...value, data: await window.XDistArticleMedia.prepare(value.data)}), value);
      const result = await page.evaluate(value => window.XDistRednoteLongform.fill(value), value);
      return {page, result, prepared: value};
    }
    let {page, result} = await run({});
    assert.ok(result.ok, result.error);
    assert.equal(await page.evaluate(() => window.titleModel), title);
    assert.equal(normalize(await page.evaluate(() => window.editor.getText())), normalize(body));
    assert.deepEqual(await page.evaluate(() => window.actions), {longTab: 1, newCreation: 1, format: 0, next: 0, publish: 0});
    assert.equal(await page.locator('.ProseMirror img').count(), 0, "body markup was interpreted as HTML");
    console.log(`PASS: long title and ${body.length}-character body enter actual TipTap state; no format/next/publish action`);
    result = await page.evaluate(value => window.XDistRednoteLongform.fill(value), payload);
    assert.ok(result.ok);
    assert.equal(normalize(await page.evaluate(() => window.editor.getText())), normalize(body));
    await page.close();
    console.log("PASS: repeated fill does not duplicate article content");

    ({page, result} = await run({direct: true, initialTitle: "我的现有草稿", initialContent: "<p>保留已有内容</p>"}));
    assert.equal(result.ok, false);
    assert.equal(await page.locator("textarea").inputValue(), "我的现有草稿");
    assert.equal(await page.evaluate(() => window.editor.getText()), "保留已有内容");
    await page.close();
    console.log("PASS: existing draft remains unchanged");

    ({page, result} = await run({direct: true, titleLimit: 10}));
    assert.equal(result.ok, false);
    assert.match(result.error, /标题超过/);
    await page.close();
    ({page, result} = await run({direct: true, bodyLimit: 20}));
    assert.equal(result.ok, false);
    assert.match(result.error, /未能完整填入/);
    assert.equal(await page.evaluate(() => window.actions.publish), 0);
    await page.close();
    console.log("PASS: title limits and rejected editor transactions report failure without publishing");

    ({page, result} = await run({}, payload, "https://creator.xiaohongshu.com/login"));
    assert.equal(result.ok, false);
    assert.match(result.error, /登录/);
    await page.close();
    ({page, result} = await run({login: true}));
    assert.equal(result.ok, false);
    assert.match(result.error, /登录/);
    await page.close();
    console.log("PASS: missing login on both login and publish URLs produces an actionable error");

    const imageBody = '第一段：[微笑] 🔥 <img src="fake">\n\n第二段：图片之后\n\n最后一段';
    const imagePayload = {isAutoPublish: true, data: {isArticle: true, title, articleTitle: title,
      content: title + "\n\n" + imageBody, images: [image("cover"), image("inline")], articleBlocks: [
        {type: "image", url: image("cover").url}, {type: "text", text: '第一段：[微笑] 🔥 <img src="fake">'},
        {type: "image", url: image("inline").url}, {type: "text", text: "第二段：图片之后"},
        {type: "image", url: image("inline").url}, {type: "text", text: "最后一段"}
      ]}};
    let prepared;
    ({page, result, prepared} = await run({}, imagePayload));
    assert.ok(result.ok, result.error);
    assert.equal(result.imageCount, 3);
    assert.equal(await page.evaluate(() => window.pasteFiles), 3, "onPaste handled a source placement more than once");
    assert.equal(uploads.length, 3, "one source placement triggered multiple uploads");
    const document = await page.evaluate(() => window.editor.getJSON());
    assert.deepEqual(document.content.filter(node => node.type === "image").map(node => node.attrs.imgs[0].src), uploads.map((_, i) => `https://sns-webpic-qc.xhscdn.com/uploaded/${i + 1}.png`));
    assert.equal(normalize(await page.evaluate(() => window.editor.getText())), normalize(imageBody));
    assert.deepEqual(await page.evaluate(() => window.savedDocument), document);
    const placed = document.content.filter(node => node.type === "image" || node.content?.length).map(node => node.type === "image" ? "image" : node.content.map(item => item.text || "").join(""));
    assert.deepEqual(placed, ["image", '第一段：[微笑] 🔥 <img src="fake">', "image", "第二段：图片之后", "image", "最后一段"]);
    assert.ok(uploads.every(bytes => bytes.equals(pixel)), "uploaded bytes differ from downloaded source");
    result = await page.evaluate(value => window.XDistRednoteLongform.fill(value), prepared);
    assert.ok(result.ok, result.error);
    assert.equal(uploads.length, 3, "repeat fill uploaded duplicate pictures");
    assert.deepEqual(await page.evaluate(() => window.editor.getJSON()), document);
    assert.equal(await page.evaluate(() => window.actions.publish + window.actions.format + window.actions.next), 0);
    await page.evaluate(() => {
      let from;
      window.editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text.includes('[微笑]')) from = pos + node.text.indexOf('[微笑]');
      });
      window.editor.commands.insertContentAt({from, to:from+4}, {type:'redEmoji',attrs:{shortcode:'[微笑]'}});
    });
    assert.equal(await page.locator('.ProseMirror img[data-emoji-shortcode]').count(), 1);
    result = await page.evaluate(value => window.XDistRednoteLongform.fill(value), prepared);
    assert.ok(result.ok, result.error);
    assert.equal(uploads.length, 3, "inline emoji was mistaken for a new article picture");
    await page.close();
    console.log("PASS: cover and repeated inline images upload in order and persist in TipTap state; repeat fill does not duplicate");

    ({page, result} = await run({hideModel: true}, imagePayload));
    assert.ok(result.ok, result.error);
    assert.equal(result.imageCount, 3);
    assert.equal(await page.evaluate(() => window.pasteFiles), 3, "DOM fallback pasted a file more than once");
    assert.equal(normalize(await page.evaluate(() => window.editor.getText())), normalize(imageBody));
    assert.equal(await page.locator('.ProseMirror img[data-emoji-shortcode]').count(), 1);
    await page.close();
    console.log("PASS: emoji images are text in both document-model and DOM fallback verification");

    const uploadsBefore=uploads.length;
    ({page, result} = await run({uploadDelay: 400}, {...imagePayload, data: {...imagePayload.data,
      content: title + "\n\n两张相邻的相同配图", images: [image("inline")], articleBlocks: [
        {type: "image", url: image("inline").url}, {type: "image", url: image("inline").url},
        {type: "text", text: "两张相邻的相同配图"}
      ]}}));
    assert.ok(result.ok, result.error);
    assert.equal(result.imageCount, 2);
    assert.equal(uploads.length-uploadsBefore, 2, "slow uploads were repeated or intentional duplicate placements were lost");
    assert.equal(await page.evaluate(() => window.pasteFiles), 2);
    assert.deepEqual(await page.evaluate(() => window.editor.getJSON().content.filter(node => node.type==='image'||node.content?.length).map(node => node.type)), ['image','image','paragraph']);
    assert.equal(await page.evaluate(() => window.editor.getText().trim()), "两张相邻的相同配图");
    await page.close();
    console.log("PASS: file paste uploads once per placement, including slow uploads and adjacent copies of the same image");

    for (const settings of [{imagePlacement: "start"}, {duplicateImages: true}]) {
      let warningPayload;
      ({page, result, prepared: warningPayload} = await run(settings, imagePayload));
      assert.ok(result.ok, result.error);
      assert.match(result.warnings.join('\n'), /配图数量或位置/);
      assert.equal(normalize(await page.evaluate(() => window.editor.getText())), normalize(imageBody));
      assert.equal(await page.locator('.tt-image img').count(), settings.duplicateImages ? 6 : 3);
      assert.match(await page.locator('#x-dist-longform-status').innerText(), /已填入标题和完整正文.*\n[\s\S]*配图提示/);
      const before=uploads.length;
      const repeated=await page.evaluate(value => window.XDistRednoteLongform.fill(value), warningPayload);
      assert.ok(repeated.ok, repeated.error);
      assert.deepEqual(repeated.warnings, result.warnings, "repeat fill discarded image warnings");
      assert.equal(uploads.length, before, "repeat fill retried warning-only images");
      await page.evaluate(() => {
        let position;
        window.editor.state.doc.descendants((node, pos) => { if (node.type.name==='image') position=pos; });
        window.editor.commands.deleteRange({from:position,to:position+1});
      });
      const changed=await page.evaluate(value => window.XDistRednoteLongform.fill(value), warningPayload);
      assert.ok(changed.ok, changed.error);
      assert.match(changed.warnings.join('\n'), /配图状态已变化/);
      assert.equal(uploads.length, before, "a later image state change restarted uploads");
      assert.equal(await page.evaluate(() => window.actions.publish + window.actions.format + window.actions.next), 0);
      await page.close();
    }
    console.log("PASS: wrong image positions and extra images only warn, retain the full body, and stay idempotent");

    ({page, result} = await run({}, {...imagePayload, data: {...imagePayload.data, images: [image("inline")]}}));
    assert.ok(result.ok, result.error);
    assert.equal(result.imageCount, 2, "deselected cover was uploaded");
    await page.close();
    ({page, result} = await run({direct: true, initialContent: {type: "doc", content: [{type: "image", attrs: {imgs: [{src: "https://sns-webpic-qc.xhscdn.com/existing.png"}]}}, {type: "paragraph"}]}}, imagePayload));
    assert.equal(result.ok, false);
    assert.match(result.error, /已有内容/);
    assert.equal(await page.locator('.tt-image img').count(), 1);
    await page.close();
    ({page, result} = await run({uploadFails: true}, imagePayload));
    assert.ok(result.ok, result.error);
    assert.match(result.warnings.join('\n'), /配图未确认上传成功/);
    assert.equal(result.imageCount, 0);
    assert.equal(normalize(await page.evaluate(() => window.editor.getText())), normalize(imageBody));
    assert.equal(await page.evaluate(() => window.actions.publish + window.actions.format + window.actions.next), 0);
    await page.close();
    ({page, result} = await run({failFirstUpload: true}, imagePayload));
    assert.ok(result.ok, result.error);
    assert.match(result.warnings.join('\n'), /第 1\/3 张配图未确认上传成功/);
    assert.equal(result.imageCount, 2, "a failed cover prevented later image uploads");
    assert.equal(normalize(await page.evaluate(() => window.editor.getText())), normalize(imageBody));
    await page.close();
    ({page, result} = await run({direct: true, bodyLimit: 5}, imagePayload));
    assert.equal(result.ok, false);
    assert.match(result.error, /第 2 步文字未完整写入.*预期.*实际/);
    assert.equal(await page.locator('.tt-image img').count(), 1, "already uploaded cover was removed after text rejection");
    assert.equal(await page.evaluate(() => window.actions.publish + window.actions.format + window.actions.next), 0);
    await page.close();
    console.log("PASS: failed uploads warn and continue text/later images; existing drafts and real text failures remain protected");

    for (const data of [
      {...prepared.data, articleImages: []},
      {...prepared.data, content: prepared.data.content + "新增正文"}
    ]) {
      ({page, result} = await run({skipPreparation: true}, {...prepared, data}));
      assert.ok(result.ok, result.error);
      assert.ok(result.warnings.length, "missing assets or stale positions were silently ignored");
      assert.equal(normalize(await page.evaluate(() => window.editor.getText())), normalize(data.content.slice(title.length).trim()));
      await page.close();
    }
    ({page, result} = await run({}, {...imagePayload, data: {...imagePayload.data, images: [image("cover"), image("broken"), image("inline")]}}));
    assert.ok(result.ok, result.error);
    assert.match(result.warnings.join('\n'), /准备失败.*404/);
    assert.equal(result.imageCount, 3, "one failed download removed other source placements");
    assert.equal(normalize(await page.evaluate(() => window.editor.getText())), normalize(imageBody));
    await page.close();
    console.log("PASS: invalid prepared images, stale positions and partial download failures preserve the current body");

    ({page} = await run({}));
    const edited = await page.evaluate(data => window.XDistArticleMedia.prepare({...data, content: data.content + "修改正文"}), imagePayload.data);
    assert.match(edited.articleWarnings.join('\n'), /配图位置无法确认/);
    assert.equal(edited.articleLayout[0].text, imageBody + "修改正文");
    assert.deepEqual(edited.articleLayout.slice(1).map(block => block.type), ["image", "image", "image"]);
    const missingLayout = await page.evaluate(data => window.XDistArticleMedia.prepare({...data, articleBlocks: undefined}), imagePayload.data);
    assert.match(missingLayout.articleWarnings.join('\n'), /配图位置无法确认/);
    assert.equal(missingLayout.articleLayout[0].text, imageBody);
    const broken = await page.evaluate(data => window.XDistArticleMedia.prepare({...data, images: [{url: "https://pbs.twimg.com/media/broken.png", name: "broken.png"}]}), imagePayload.data);
    assert.match(broken.articleWarnings.join('\n'), /准备失败.*404/);
    assert.equal(broken.articleImages.length, 0);
    assert.equal(broken.articleLayout.some(block => block.type === 'image'), false);
    const converted = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 3;
      canvas.getContext('2d').fillRect(0, 0, 2, 3);
      const url = canvas.toDataURL('image/webp');
      const data = await window.XDistArticleMedia.prepare({content: 'text', articleBlocks: [{type: 'text', text: 'text'}, {type: 'image', url}], images: [{url, name: 'test.webp'}]});
      const blob = await (await fetch(data.articleImages[0].dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      return {type: blob.type, width: bitmap.width, height: bitmap.height};
    });
    assert.deepEqual(converted, {type: "image/png", width: 2, height: 3});
    await page.close();
    console.log("PASS: changed text/missing positions append pictures with warnings, failed downloads are skipped; WebP keeps its dimensions");

    const publishBundle = await fs.readFile(path.join(root, "tabs/publish.4d5f7725.js"), "utf8");
    async function popup(syncData) {
      const tab = await context.newPage();
      tab.on("pageerror", error => console.error("Popup fixture error:", error.message));
      await tab.goto("https://creator.xiaohongshu.com/publish/publish");
      await tab.setContent('<meta charset="utf-8"><div id="__plasmo"></div>');
      await tab.evaluate(syncData => {
        window.outbound = [];
        window.chrome.runtime = {sendMessage: async message => {
          window.outbound.push(message);
          return message.action === "X_DIST_PUBLISH_REQUEST_SYNC_DATA" ? {syncData} : {tabs: []};
        }};
      }, syncData);
      await tab.addScriptTag({content: mediaHelper});
      await tab.addScriptTag({content: publishBundle});
      await tab.evaluate(() => document.dispatchEvent(new Event("DOMContentLoaded")));
      return tab;
    }
    const beforeDownloads = mediaDownloads.length;
    page = await popup({...imagePayload, platforms: [{name: "DYNAMIC_REDNOTE"}, {name: "DYNAMIC_OKJIKE"}]});
    await page.waitForFunction(() => window.outbound.some(message => message.action === "X_DIST_PUBLISH_NOW"), null, {timeout: 10000}).catch(async error => {
      console.error("Popup diagnostics:", await page.evaluate(() => ({text: document.body.innerText, messages: window.outbound.map(message => message.action)})));
      throw error;
    });
    const mixed = await page.evaluate(async () => {
      const {data} = window.outbound.find(message => message.action === "X_DIST_PUBLISH_NOW").data;
      return {layout: data.articleLayout, assets: data.articleImages.length, files: await Promise.all(data.images.map(async image =>
        ({url: image.url.startsWith('blob:'), type: image.type, size: (await (await fetch(image.url)).blob()).size})))};
    });
    assert.equal(mixed.assets, 2);
    assert.equal(mixed.layout.filter(block => block.type === "image").length, 3);
    assert.equal(mediaDownloads.length - beforeDownloads, 2, "mixed dispatch re-downloaded image sources");
    assert.deepEqual(mixed.files, [{url: true, type: "image/png", size: pixel.length}, {url: true, type: "image/png", size: pixel.length}]);
    await page.close();
    page = await popup({...imagePayload, platforms: [{name: "DYNAMIC_REDNOTE"}], data: {...imagePayload.data, images: [image("broken")]}});
    await page.waitForFunction(() => window.outbound.some(message => message.action === "X_DIST_PUBLISH_NOW"));
    assert.match(await page.locator('body').innerText(), /准备失败/);
    assert.equal(await page.evaluate(() => window.outbound.find(message => message.action === "X_DIST_PUBLISH_NOW").data.data.articleImages.length), 0);
    await page.close();
    const partialDownloads=mediaDownloads.length;
    page = await popup({...imagePayload, platforms: [{name: "DYNAMIC_REDNOTE"}, {name: "DYNAMIC_OKJIKE"}], data: {...imagePayload.data, images: [image("broken"), image("inline")]}});
    await page.waitForFunction(() => window.outbound.some(message => message.action === "X_DIST_PUBLISH_NOW"));
    assert.equal(await page.evaluate(() => window.outbound.find(message => message.action === "X_DIST_PUBLISH_NOW").data.data.images.length), 1);
    assert.equal(mediaDownloads.length-partialDownloads, 2, "mixed dispatch re-downloaded a failed image source");
    await page.close();
    console.log("PASS: actual publish UI reports image warnings and dispatches remaining media after partial/all download failures");

    const routing = await worker.evaluate(() => {
      const prepare = globalThis.XDistRednoteLongform.prepare;
      const normal = {name: "DYNAMIC_REDNOTE", injectUrl: "normal"};
      const video = {name: "VIDEO_REDNOTE", injectUrl: "video"};
      return {normal: prepare(normal, {data: {}}) === normal, video: prepare(video, {data: {isArticle: true}}) === video,
        article: prepare(normal, {data: {isArticle: true}}).platformName};
    });
    assert.deepEqual(routing, {normal: true, video: true, article: "小红书 · 长文写作"});
    console.log("PASS: normal image/video dispatch is unchanged");

    // Verify the real X panel -> publish popup -> service worker -> Xiaohongshu flow.
    fixtureSettings = {};
    mediaDownloads.length = 0;
    uploads.length = 0;
    await worker.evaluate(() => chrome.storage.local.set({"x-dist-selected-platforms": ["rednote"], "x-dist-auto-publish": true}));
    const source = await context.newPage();
    context.on("page", async tab => {
      // Extension-created tabs may navigate before Playwright attaches its routes.
      await tab.waitForURL(url => url.href !== "about:blank", {timeout: 3000}).catch(() => {});
      if (!tab.isClosed() && (tab.url().startsWith("https://creator.xiaohongshu.com/") || tab.url().startsWith("chrome-error:"))) await tab.goto("https://creator.xiaohongshu.com/publish/publish?source=official").catch(() => {});
    });
    await source.goto("https://x.com/tester/status/123");
    await source.locator('[data-x-dist-btn] button').click();
    await source.locator('#x-dist-panel-host input[type="text"]').waitFor();
    assert.equal(await source.locator('#x-dist-panel-host input[type="text"]').inputValue(), title);
    await source.getByRole("button", {name: "分发到 1 个平台", exact: true}).click();
    let target;
    for (let i = 0; i < 200; i++) {
      target = context.pages().find(tab => tab.url().startsWith("https://creator.xiaohongshu.com/"));
      if (target) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(target, "Xiaohongshu tab did not open");
    try {
      await target.locator('#x-dist-longform-status').filter({hasText: "已填入标题和完整正文"}).waitFor({timeout: 25000});
    } catch (error) {
      for (const tab of context.pages()) console.error('Page diagnostics:', tab.url(), await tab.evaluate(() => ({
        status: document.querySelector('#x-dist-longform-status')?.textContent,
        actions: window.actions,
        editor: Boolean(window.editor),
        text: document.body.innerText.slice(0, 800)
      })).catch(String));
      throw error;
    }
    assert.equal(await target.evaluate(() => window.titleModel), title);
    assert.equal(normalize(await target.evaluate(() => window.editor.getText())), normalize(body));
    assert.deepEqual(await target.evaluate(() => window.actions), {longTab: 1, newCreation: 1, format: 0, next: 0, publish: 0});
    assert.deepEqual(mediaDownloads, []);
    assert.equal(websitePublishes, 0);
    if (process.env.XHS_SCREENSHOT) await target.screenshot({path: process.env.XHS_SCREENSHOT});
    console.log("PASS: real extension fills the long-article editor from X without images, media downloads or publishing");
    await target.close();
    sourceHasImages = true;
    await source.reload();
    await source.locator('[data-x-dist-btn] button').click();
    await source.getByRole("button", {name: "分发到 1 个平台", exact: true}).click();
    target = null;
    for (let i = 0; i < 200; i++) {
      target = context.pages().find(tab => tab.url().startsWith("https://creator.xiaohongshu.com/"));
      if (target) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(target, "image article did not reach Xiaohongshu");
    await target.locator('#x-dist-longform-status').filter({hasText: "完整正文和 4 张配图"}).waitFor({timeout: 30000}).catch(async error => {
      for (const tab of context.pages()) console.error("Image dispatch diagnostics:", tab.url(), await tab.evaluate(() => ({
        text: document.body.innerText.slice(-1200), actions: window.actions, filePastes: window.pasteFiles,
        images: Array.from(document.querySelectorAll('.ProseMirror img'), img => ({src: img.src, complete: img.complete, width: img.naturalWidth}))
      })).catch(String));
      throw error;
    });
    assert.equal(normalize(await target.evaluate(() => window.editor.getText())), normalize(body));
    assert.equal(await target.evaluate(() => window.titleModel), title);
    assert.equal(await target.locator('.tt-image img').count(), 4);
    assert.equal(await target.evaluate(() => globalThis.__xDistLongformImages?.done), true, "longform did not run beside the actual editor instance");
    assert.equal(uploads.length, 4);
    assert.equal(new Set(mediaDownloads).size, 3);
    assert.equal(mediaDownloads.length, 3, "repeated source downloaded more than once");
    const finalDocument = await target.evaluate(() => window.editor.getJSON());
    assert.deepEqual(await target.evaluate(() => window.savedDocument), finalDocument);
    const order = finalDocument.content.filter(node => node.type === "image" || node.content?.length).map(node => node.type === "image" ? "image" : node.content.map(item => item.text || "").join(""));
    assert.equal(order[0], "image");
    assert.equal(order[2], "image");
    assert.equal(order[53], "image");
    assert.equal(order.at(-1), "image");
    assert.equal(await target.evaluate(() => window.actions.publish + window.actions.format + window.actions.next), 0);
    assert.equal(websitePublishes, 0);
    if (process.env.XHS_SCREENSHOT) await target.screenshot({path: process.env.XHS_SCREENSHOT});
    console.log("PASS: native X panel -> popup downloads -> MAIN world editor -> uploaded inline images, with full body/order and no publishing");
  } finally {
    if (context) await context.close();
    await fs.rm(profile, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
