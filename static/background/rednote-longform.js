// The fill function is serialized by chrome.scripting; keep its helpers inside it.
(() => {
  "use strict";

  async function fill(payload) {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const warnings = [];
    const normalize = text => String(text || "").replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ").replace(/\n+/g, "\n").trim();
    const visible = node => node && node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== "hidden" && !node.closest('[hidden], [aria-hidden="true"]');
    const find = selector => Array.from(document.querySelectorAll(selector)).find(visible);
    const titleField = () => find('textarea[placeholder="输入标题"], textarea[placeholder="请输入标题"]');
    const bodyField = () => find('.tiptap.ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"]');
    const button = labels => {
      for (const selector of ['.creator-tab, [role="tab"]', 'button, [role="button"], a', 'span']) {
        const node = Array.from(document.querySelectorAll(selector)).find(node =>
          visible(node) && !node.disabled && node.getAttribute("aria-disabled") !== "true" &&
          labels.includes(node.textContent.trim()) && !node.closest('[contenteditable="true"]'));
        if (node) return node;
      }
      return null;
    };
    function status(text, failed = false) {
      let box = document.getElementById("x-dist-longform-status");
      if (!box) {
        box = document.createElement("div");
        box.id = "x-dist-longform-status";
        box.setAttribute("role", "status");
        Object.assign(box.style, {position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483647",
          maxWidth: "380px", padding: "14px 18px", borderRadius: "12px", font: "14px/1.6 sans-serif",
          boxShadow: "0 4px 24px #0002", whiteSpace: "pre-wrap", maxHeight: "50vh", overflowY: "auto"});
        document.body.appendChild(box);
      }
      box.style.background = failed ? "#fff1f0" : warnings.length ? "#fff8e6" : "#effaf3";
      box.style.color = failed ? "#a12622" : warnings.length ? "#805500" : "#17653a";
      box.textContent = text + (warnings.length ? "\n\n配图提示（不影响正文同步）：\n" + warnings.join("\n") : "");
    }
    function warn(message) {
      if (!warnings.includes(message)) warnings.push(message);
      status("正在继续同步正文和配图…");
    }
    async function waitFor(get, label) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (/\/login(?:\/|$)/.test(location.pathname) || find('input[placeholder*="手机号"], input[placeholder*="验证码"]')) {
          throw new Error("请先登录小红书创作服务平台，再从 X 重新发起分发。");
        }
        const result = get();
        if (result) return result;
        await pause(150);
      }
      throw new Error(`未找到${label}。请确认账号可使用“写长文”，再从 X 重新发起分发。`);
    }
    function selectContents(editor) {
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    // TipTap attaches its editor instance to view.dom.editor. In MAIN world we
    // can check actual document transactions, independently of rendered controls.
    function partsOf(editor) {
      const parts = [];
      let text = "";
      const flush = () => {
        if (normalize(text)) parts.push({type: "text", text: normalize(text)});
        text = "";
      };
      const emojiText = value => String(value || "").replace(/^x-x-([\s\S]*)-x-x$/, "$1");
      const doc = editor.editor?.getJSON?.();
      if (doc?.type === "doc") {
        function read(node) {
          if (node.type === "text") { text += node.text || ""; return; }
          if (node.type === "hardBreak") { text += "\n"; return; }
          if (node.type === "redEmoji" || node.type === "shortEmoji") {
            text += emojiText(node.attrs?.shortcode || node.attrs?.["data-emoji"]);
            return;
          }
          if (node.type === "image") {
            flush();
            const images = node.attrs?.imgs?.length ? node.attrs.imgs : [{src: node.attrs?.src || ""}];
            for (const img of images) parts.push({type: "image", url: img.src});
            return;
          }
          const block = ["paragraph", "heading", "blockquote", "codeBlock", "listItem"].includes(node.type);
          if (block) text += "\n";
          for (const child of node.content || []) read(child);
          if (block) text += "\n";
        }
        read(doc);
        flush();
        return parts;
      }
      // Compatibility fallback when the site does not expose a TipTap instance.
      function walk(node) {
        if (node.nodeType === 3) { text += node.nodeValue; return; }
        if (node.nodeType !== 1) return;
        if (node.matches('[hidden], [aria-hidden="true"], .ProseMirror-separator')) return;
        if (node.matches('img[data-emoji-shortcode], img[data-emoji]')) {
          text += emojiText(node.getAttribute("data-emoji-shortcode") || node.getAttribute("data-emoji"));
          return;
        }
        if (node.matches('[data-dom-type="image"], .tt-image')) {
          flush();
          const images = node.matches('img') ? [node] : Array.from(node.querySelectorAll('img[data-dom-type="img"]'));
          for (const img of images) parts.push({type: "image", url: img.src});
          return;
        }
        if (node.matches('img')) { flush(); parts.push({type: "image", url: node.src}); return; }
        if (node.matches('button, [role="button"], [contenteditable="false"], [hidden], [aria-hidden="true"]')) return;
        if (node.tagName === "BR") { text += "\n"; return; }
        const block = /^(P|DIV|SECTION|H[1-6]|BLOCKQUOTE|PRE|LI)$/.test(node.tagName);
        if (block) text += "\n";
        for (const child of node.childNodes) walk(child);
        if (block) text += "\n";
      }
      for (const child of editor.childNodes) walk(child);
      flush();
      return parts;
    }
    const signature = parts => JSON.stringify(parts);
    // Images can split a paragraph or change its line breaks. Check that all
    // text is retained independently of image placement and paragraph boundaries.
    const textOf = parts => normalize(parts.filter(part => part.type === "text").map(part => part.text).join("\n")).replace(/\n/g, "");
    function addedImages(before, after) {
      const remaining = new Map();
      for (const part of before) if (part.type === "image") remaining.set(part.url, (remaining.get(part.url) || 0) + 1);
      return after.filter(part => {
        if (part.type !== "image") return false;
        const count = remaining.get(part.url) || 0;
        if (!count) return true;
        remaining.set(part.url, count - 1);
        return false;
      });
    }
    async function appendText(editor, content) {
      if (editor.editor?.commands?.insertContent) {
        // Explicit text nodes preserve literal characters, code spaces and line
        // breaks without invoking the site's Markdown/emoji paste substitutions.
        editor.editor.commands.insertContent(content.split("\n").map(line => ({type: "paragraph",
          content: line ? [{type: "text", text: line}] : []})));
        return;
      }
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", content);
      editor.dispatchEvent(new ClipboardEvent("paste", {bubbles: true, cancelable: true, clipboardData: clipboard}));
      await pause(200);
    }
    async function atEnd(editor) {
      if (editor.editor?.commands?.setTextSelection) {
        editor.editor.commands.setTextSelection(editor.editor.state.doc.content.size);
        editor.editor.commands.focus();
        return;
      }
      selectContents(editor);
      window.getSelection().collapseToEnd();
      // ProseMirror consumes selectionchange asynchronously before onPaste.
      document.dispatchEvent(new Event("selectionchange"));
      await pause(50);
    }
    async function checkParts(editor, expected, stage) {
      const deadline = Date.now() + 2500;
      let actual;
      do {
        actual = partsOf(editor);
        if (signature(actual) === signature(expected)) return actual;
        await pause(100);
      } while (Date.now() < deadline);
      const count = parts => ({text: parts.filter(part => part.type === "text").map(part => part.text).join("\n").length,
        images: parts.filter(part => part.type === "image").length});
      const wanted = count(expected), got = count(actual);
      if (textOf(actual) !== textOf(expected)) {
        throw new Error(`${stage}未完整写入（预期 ${wanted.text} 字/${wanted.images} 张图，实际 ${got.text} 字/${got.images} 张图）。已保留当前草稿，请检查正文。`);
      }
      warn(`${stage}：配图数量或位置与预期不一致（预期 ${wanted.images} 张，实际 ${got.images} 张），已继续同步，请手动检查。`);
      return actual;
    }
    async function fillImages(editor, input, title, content, data) {
      const layout = [];
      const sourceLayout = Array.isArray(data.articleLayout) ? data.articleLayout : [];
      for (const block of sourceLayout) {
        if (block.type === "text" && normalize(block.text)) {
          const last = layout[layout.length - 1];
          if (last?.type === "text") last.text += "\n\n" + block.text;
          else layout.push({type: "text", text: block.text});
        } else if (block.type === "image") layout.push({type: "image", url: block.url});
      }
      if (!Array.isArray(data.articleLayout) || normalize(layout.filter(block => block.type === "text").map(block => block.text).join("\n")) !== normalize(content)) {
        const images = Array.isArray(data.articleLayout) ? layout.filter(block => block.type === "image") :
          (data.images || []).map(item => ({type: "image", url: item.url}));
        layout.splice(0, layout.length, {type: "text", text: content}, ...images);
        warn("配图位置无法确认，已按当前正文同步，并将所选图片放到文末，请手动调整位置。");
      }
      const assets = new Map((Array.isArray(data.articleImages) ? data.articleImages : []).map(item => [item.sourceUrl, item]));
      const files = new Map();
      for (const block of layout) if (block.type === "image" && !files.has(block.url)) {
        const asset = assets.get(block.url);
        try {
          const match = asset?.dataUrl?.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/);
          if (!match) throw new Error("文件缺失或格式不受支持");
          const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
          if (bytes.length > 10 * 1024 * 1024) throw new Error("图片超过 10 MB");
          files.set(block.url, new File([bytes], asset.name, {type: match[1]}));
        } catch (error) {
          warn(`配图“${asset?.name || "未命名"}”无法上传：${error.message}。已跳过此图，继续同步正文。`);
        }
      }
      const key = signature([title, layout]);
      const previous = globalThis.__xDistLongformImages;
      const existing = partsOf(editor);
      if (previous?.editor === editor && previous.key === key && previous.done &&
          input.value === title && textOf(existing) === textOf([{type: "text", text: content}])) {
        for (const message of previous.warnings || []) if (!warnings.includes(message)) warnings.push(message);
        if (previous.signature !== signature(existing)) warn("配图状态已变化，已保留当前图片，请手动检查位置和上传结果。");
        Object.assign(previous, {signature: signature(existing), warnings: [...warnings]});
        return previous.count;
      }
      if (existing.length || input.value.trim() && input.value.trim() !== title) {
        throw new Error("当前长文已有内容，未覆盖。请保留现有内容，并从新的创作重新发起同步。");
      }
      if (previous?.editor === editor && previous.busy) throw new Error("配图正在同步，请等待当前任务完成。");
      const state = {editor, key, busy: true, done: false};
      globalThis.__xDistLongformImages = state;
      let expected = [];
      const total = layout.filter(block => block.type === "image").length;
      let count = 0;
      let imageIndex = 0;
      try {
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, title);
        input.dispatchEvent(new Event("input", {bubbles: true}));
        input.dispatchEvent(new Event("change", {bubbles: true}));
        for (const [index, block] of layout.entries()) {
          expected = await checkParts(editor, expected, "继续同步前");
          await atEnd(editor);
          if (block.type === "text") {
            await appendText(editor, block.text);
            const last = expected[expected.length - 1];
            if (last?.type === "text") last.text = normalize(last.text + "\n" + block.text);
            else expected.push({type: "text", text: normalize(block.text)});
          } else {
            imageIndex++;
            if (!files.has(block.url)) continue;
            status(`正在上传配图 ${imageIndex}/${total}，请暂时不要编辑正文…`);
            try {
              const clipboard = new DataTransfer();
              clipboard.items.add(files.get(block.url));
              // XHS starts uploads in onPaste without returning a handled flag.
              // A files-only clipboard gives ProseMirror no slice, so capturePaste
              // invokes onPaste again 50 ms later. Supply a valid empty slice.
              clipboard.setData("text/html", "<p></p>");
              editor.dispatchEvent(new ClipboardEvent("paste", {bubbles: true, cancelable: true, clipboardData: clipboard}));
              const deadline = Date.now() + 60000;
              let uploaded;
              while (Date.now() < deadline) {
                await pause(250);
                // Look throughout the document: a site upload can land at the
                // wrong position. Keep uploading once, then warn about placement.
                uploaded = addedImages(expected, partsOf(editor)).find(item => {
                  let url;
                  try { url = new URL(item.url); } catch { return false; }
                  if (!/^https?:$/.test(url.protocol) || !/(^|\.)(xhscdn\.com|xhsimg\.com|xiaohongshu\.com)$/.test(url.hostname)) return false;
                  return Array.from(editor.querySelectorAll('img')).some(img => img.src === url.href && img.complete && img.naturalWidth > 0);
                });
                if (uploaded) break;
              }
              if (uploaded) { expected.push(uploaded); count++; }
              else warn(`第 ${imageIndex}/${total} 张配图未确认上传成功，已继续同步后续内容，请手动检查或补图。`);
            } catch (error) {
              warn(`第 ${imageIndex}/${total} 张配图上传失败：${error.message}。已继续同步后续内容，请手动补图。`);
            }
          }
          expected = await checkParts(editor, expected, `第 ${index + 1} 步${block.type === "text" ? "文字" : "配图"}`);
        }
        editor.blur();
        await pause(300);
        expected = await checkParts(editor, expected, "最终检查");
        if (input.value !== title || textOf(expected) !== textOf([{type: "text", text: content}])) {
          throw new Error("标题或正文未能完整保留，请检查当前草稿。");
        }
        Object.assign(state, {done: true, signature: signature(expected), count, warnings: [...warnings]});
        return count;
      } finally { state.busy = false; }
    }
    try {
      const data = payload?.data || {};
      for (const message of data.articleWarnings || []) if (typeof message === "string" && !warnings.includes(message)) warnings.push(message);
      const title = String(data.title || data.articleTitle || "").trim();
      let content = String(data.content || "").replace(/\r\n?/g, "\n").trim();
      // The X panel includes the original title at the start for other platforms.
      // Xiaohongshu has a separate long-article title field.
      const originalTitle = String(data.articleTitle || "").replace(/\r\n?/g, "\n").trim();
      if (originalTitle && content.startsWith(originalTitle + "\n\n")) {
        content = content.slice(originalTitle.length).trimStart();
      }
      if (!title || !content) throw new Error("长文标题和正文不能为空，请回到 X 分发面板补充。");
      if (!(titleField() && bodyField())) {
        const tab = await waitFor(() => button(["写长文", "长文写作"]), "长文写作入口");
        tab.click();
        const next = await waitFor(() => titleField() && bodyField() ? "editor" : button(["新的创作", "新建长文"]), "新的创作按钮");
        if (next !== "editor") next.click();
      }
      const input = await waitFor(titleField, "长文标题输入框");
      const editor = await waitFor(bodyField, "长文正文编辑器");
      if (input.maxLength >= 0 && title.length > input.maxLength) throw new Error("标题超过当前编辑器限制，请回到 X 面板调整标题后重试。");
      if (data.images?.length || data.articleLayout?.some(block => block.type === "image") || warnings.length) {
        const count = await fillImages(editor, input, title, content, data);
        status(warnings.length ? `已填入标题和完整正文，已确认 ${count} 张配图上传。请按下方提示检查图片，再自行排版。` :
          `已填入标题、完整正文和 ${count} 张配图。请检查内容，再使用“一键排版”。`);
        return {ok: true, mode: "longform", stage: "filled", imageCount: count, warnings};
      }
      if (input.value.trim() && input.value.trim() !== title ||
          editor.querySelector('img, [data-dom-type="image"]') || normalize(editor.innerText) && normalize(editor.innerText) !== normalize(content)) {
        throw new Error("当前长文已有内容，未覆盖。请保留现有内容，并从新的创作重新发起同步。");
      }
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, title);
      input.dispatchEvent(new Event("input", {bubbles: true}));
      input.dispatchEvent(new Event("change", {bubbles: true}));

      if (normalize(editor.innerText) !== normalize(content)) {
        selectContents(editor);
        const clipboard = new DataTransfer();
        clipboard.setData("text/plain", content);
        editor.dispatchEvent(new ClipboardEvent("paste", {bubbles: true, cancelable: true, clipboardData: clipboard}));
        await pause(200);
        if (normalize(editor.innerText) !== normalize(content)) {
          // Native editing produces input/selection events understood by rich
          // text editors; direct innerHTML replacement would bypass their state.
          selectContents(editor);
          document.execCommand("insertText", false, content);
          await pause(200);
        }
      }
      editor.blur();
      await pause(200);
      if (input.value !== title || normalize(editor.innerText) !== normalize(content)) {
        throw new Error("标题或正文未能完整填入，请检查编辑页；本次未继续排版或发布。");
      }
      status("已填入标题和完整正文。请检查内容，再使用“一键排版”。");
      // Intentionally stop here, including when the general auto-publish toggle is on.
      return {ok: true, mode: "longform", stage: "filled"};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status(message, true);
      return {ok: false, error: message};
    }
  }

  function prepare(entry, payload) {
    if (entry.name !== "DYNAMIC_REDNOTE" || !payload.data?.isArticle) return entry;
    return {...entry, injectUrl: "https://creator.xiaohongshu.com/publish/publish?source=official",
      injectFunction: fill, platformName: "小红书 · 长文写作"};
  }

  async function inject(tabId, entry, payload) {
    const longform = entry.name === "DYNAMIC_REDNOTE" && payload.data?.isArticle;
    for (let attempt = 0; attempt < (longform ? 3 : 1); attempt++) {
      let results;
      try {
        results = await chrome.scripting.executeScript({target: {tabId}, ...(longform ? {world: "MAIN"} : {}), func: entry.injectFunction, args: [payload]});
      } catch (error) {
        if (!longform || attempt === 2 || !/frame|context|document|navigation/i.test(String(error))) throw error;
      }
      if (!longform) return results;
      const result = results?.[0]?.result;
      if (result) {
        if (!result.ok) throw new Error(result.error || "小红书长文未能完成填写，请检查打开的编辑页。");
        return results;
      }
      // Opening a new creation may replace the document while the injected
      // script is waiting. Retry in that document; fill() is idempotent.
      if (attempt < 2) {
        await chrome.tabs.get(tabId);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    throw new Error("小红书长文未能完成填写，请检查打开的编辑页后重新发起分发。");
  }
  globalThis.XDistRednoteLongform = {fill, prepare, inject};
})();
