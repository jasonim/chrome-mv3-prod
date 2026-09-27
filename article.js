// Loaded before the packaged content script. No X credentials or external API required.
(() => {
  "use strict";
  const TWEET = 'article[data-testid="tweet"]';
  const ROOT = '[data-testid="twitterArticleReadView"]';
  const RICH = '[data-testid="twitterArticleRichTextView"], [data-testid="longformRichTextComponent"]';
  const TITLE = '[data-testid="twitter-article-title"], [data-testid="twitterArticleTitle"]';
  const EXCLUDE = 'script, style, button, [role="button"], [aria-hidden="true"], [hidden], [data-testid="quoteTweet"], article[data-testid="tweet"], [data-testid="User-Name"], [data-x-dist-article-toolbar]';

  function articleURL(value) {
    try {
      const url = new URL(value, location.origin);
      if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname)) return null;
      if (!/^\/(?:i|[\w]+)\/article\/\d+\/?$/.test(url.pathname) &&
          !/^\/[\w]+\/status\/\d+\/article\/?$/.test(url.pathname)) return null;
      return url.origin + url.pathname;
    } catch { return null; }
  }

  function ownNodes(scope, selector) {
    return Array.from(scope.querySelectorAll(selector)).filter(node => {
      const owner = node.closest(TWEET);
      return !node.closest('[data-testid="quoteTweet"]') && (!owner || owner === scope || owner.contains(scope));
    });
  }

  function readerFor(tweet, base) {
    if (tweet.matches(ROOT)) return tweet;
    const local = ownNodes(tweet, ROOT)[0];
    if (local) return local;
    // On status pages X can render the reader beside the main tweet. Replies
    // must never inherit the main article, even when its normal text is empty.
    const status = location.pathname.match(/^\/[\w]+\/status\/(\d+)(?:\/article)?\/?$/);
    if (!status || status[1] !== base.tweetId) return null;
    const column = tweet.closest('[data-testid="primaryColumn"]');
    return column ? ownNodes(column, ROOT)[0] || null : null;
  }

  function plainText(container, onImage) {
    const copy = container.cloneNode(true);
    const codeBlocks = [];
    const imageMarkers = [];
    const originalImages = container.querySelectorAll('img');
    copy.querySelectorAll('img').forEach((img, index) => {
      img.src = originalImages[index].currentSrc || originalImages[index].src;
    });
    copy.querySelectorAll(EXCLUDE).forEach(node => {
      // Article photos can be wrapped in a clickable viewer. Keep those photos,
      // but never inherit hidden content, quoted posts or button labels.
      if (node.matches('[role="button"]') && !node.matches('[hidden], [aria-hidden="true"], [data-testid="quoteTweet"], [data-testid="User-Name"]')) {
        node.replaceWith(...Array.from(node.querySelectorAll('img')).filter(img => imageItem(img)));
      } else node.remove();
    });
    copy.querySelectorAll(TITLE).forEach(node => node.remove());
    copy.querySelectorAll('img').forEach(node => {
      // X renders emoji as images; photographs' alt descriptions are not body text.
      const item = imageItem(node);
      let replacement = item ? "\n\n" : /\/emoji\//.test(node.getAttribute("src") || "") ? node.alt : "";
      if (item && onImage) {
        replacement = onImage(item);
        imageMarkers.push(replacement.trim());
      }
      node.replaceWith(replacement);
    });
    const block = /^(P|DIV|SECTION|H[1-6]|BLOCKQUOTE|PRE|UL|OL|LI)$/;
    function walk(node) {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1) return "";
      if (node.tagName === "BR") return "\n";
      if (node.tagName === "PRE") {
        const index = codeBlocks.push(node.textContent.replace(/^\n|\n$/g, "")) - 1;
        return `\n\n\uE000${index}\uE001\n\n`;
      }
      const value = Array.from(node.childNodes, walk).join("");
      if (node.tagName === "LI") {
        const prefix = node.parentElement?.tagName === "OL"
          ? `${Array.from(node.parentElement.children).indexOf(node) + 1}. ` : "• ";
        let rest = value.trim(), before = "", marker;
        // A photo before the first word is a block, not part of the bullet text.
        while ((marker = imageMarkers.find(marker => rest.startsWith(marker)))) {
          before += marker + "\n\n";
          rest = rest.slice(marker.length).trimStart();
        }
        return `\n${before}${rest ? prefix + rest : ""}\n`;
      }
      return block.test(node.tagName) ? `\n\n${value}\n\n` : value;
    }
    return walk(copy).replace(/\r/g, "").replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n").trim()
      .replace(/\uE000(\d+)\uE001/g, (_, index) => codeBlocks[Number(index)]);
  }

  function imageItem(img) {
    if (img.closest('[hidden], [aria-hidden="true"], [data-testid="quoteTweet"], [data-testid="User-Name"], [data-x-dist-article-toolbar]')) return null;
    try {
      const url = new URL(img.currentSrc || img.src);
      if (url.protocol !== "https:" || url.hostname !== "pbs.twimg.com" || !/^\/(media|card_img)\//.test(url.pathname)) return null;
      const format = url.searchParams.get("format") || url.pathname.split(".").pop();
      const type = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
      url.searchParams.set("name", "orig");
      const original = url.href;
      url.searchParams.set("name", "small");
      return {kind: "image", url: original, thumbUrl: url.href,
        name: `${url.pathname.split("/").pop().split(".")[0]}.${type.split("/")[1]}`, type};
    } catch { /* An unloaded image has no usable URL yet. */ }
    return null;
  }

  function imageItems(scope) {
    const items = new Map();
    for (const img of ownNodes(scope, 'img')) {
      const item = imageItem(img);
      if (item) items.set(item.url, item);
    }
    return [...items.values()];
  }

  function articleBlocks(reader, textRoots) {
    const result = [];
    let marker = "\uE002X_DIST_IMAGE_";
    while (reader.textContent.includes(marker)) marker += "_";
    function visit(node) {
      if (node.nodeType !== 1) return;
      if (node !== reader && node.matches(EXCLUDE + ", " + TITLE) && !node.matches('[role="button"]')) return;
      if (node.matches('[hidden], [aria-hidden="true"]')) return;
      if (textRoots.includes(node)) {
        const images = [];
        const text = plainText(node, item => `\n\n${marker}${images.push(item) - 1}\uE003\n\n`);
        const parts = text.split(new RegExp(`(${marker}\\d+\uE003)`));
        for (const part of parts) {
          if (part.startsWith(marker)) result.push({type: "image", url: images[Number(part.slice(marker.length, -1))].url});
          // Only remove separators. Spaces restored from PRE blocks are code
          // indentation, including at the start of a segment after a picture.
          else if (part.trim()) result.push({type: "text", text: part.replace(/^\n+|\n+$/g, "")});
        }
        return;
      }
      if (node.tagName === "IMG") {
        const item = imageItem(node);
        if (item) result.push({type: "image", url: item.url});
        return;
      }
      for (const child of node.children) visit(child);
    }
    visit(reader);
    return result;
  }

  function read(reader) {
    const rich = ownNodes(reader, RICH).filter(node => !node.parentElement.closest(RICH));
    const titleNode = ownNodes(reader, TITLE)[0] || ownNodes(reader, 'h1').find(node => !node.closest(RICH));
    const articleTitle = (titleNode?.textContent || "").trim();
    // Only consume known body containers or Draft.js content blocks. Reading
    // the whole view would include author controls, recommendations and replies.
    const blocks = rich.length ? [] : ownNodes(reader, '[data-block="true"]')
      .filter(node => !node.parentElement.closest('[data-block="true"]'));
    // The panel and image positions must describe one serialization of the DOM.
    // Separate passes used to disagree on lists, hidden roots and code spaces.
    const ordered = articleBlocks(reader, rich.length ? rich : blocks);
    const body = ordered.filter(block => block.type === "text").map(block => block.text).join("\n\n");
    const text = body ? [articleTitle, body].filter(Boolean).join("\n\n") : "";
    const author = ownNodes(reader, '[data-testid="User-Name"]')[0];
    const authorLinks = author ? Array.from(author.querySelectorAll("a")) : [];
    const authorHandle = authorLinks.map(node => node.textContent.trim()).find(value => value.startsWith("@")) || "";
    const authorName = authorLinks.map(node => node.textContent.trim()).find(value => value && !value.startsWith("@")) || "";
    const avatar = ownNodes(reader, '[data-testid="Tweet-User-Avatar"] img')[0];
    const date = ownNodes(reader, 'time[datetime]')[0]?.getAttribute("datetime");
    return {isArticle: true, articleTitle, articleBlocks: ordered, articleLoaded: Boolean(body) &&
      !reader.querySelector('[role="progressbar"], [aria-busy="true"]'), text, media: imageItems(reader), authorName, authorHandle,
      ...(avatar ? {avatarUrl: avatar.src} : {}),
      ...(date ? {dateText: new Date(date).toLocaleDateString("zh-CN", {year: "numeric", month: "long", day: "numeric"})} : {})};
  }

  function merge(base, article) {
    const media = new Map();
    // Article media is authoritative when the whole view is available, so an
    // embedded tweet's media from the legacy extractor cannot leak into it.
    for (const item of article.media || base.media) media.set(item.url, item);
    return {...base, ...article, media: [...media.values()], hasVideo: false,
      authorName: article.authorName || base.authorName,
      authorHandle: article.authorHandle || base.authorHandle};
  }

  function extract(tweet, base) {
    if (tweet.matches(ROOT)) {
      // The legacy extractor can otherwise mistake an embedded tweet for the
      // article's author, permalink and engagement counts.
      base = {...base, tweetId: location.pathname.match(/(?:status|article)\/(\d+)/)?.[1] || null,
        tweetUrl: location.href, authorName: "", authorHandle: "", avatarUrl: null,
        verified: false, dateText: "", stats: {replies: "", retweets: "", likes: "", bookmarks: "", views: ""}};
    }
    const reader = readerFor(tweet, base);
    const link = ownNodes(tweet, 'a[href]').map(node => articleURL(node.getAttribute("href"))).find(Boolean);
    const rich = ownNodes(tweet, RICH)[0];
    const title = ownNodes(tweet, TITLE)[0];
    if (!reader && !rich && !link && !title) return base;
    const article = reader || rich ? read(reader || tweet) : {
      isArticle: true, articleLoaded: false, articleTitle: title?.textContent.trim() || ""
    };
    const url = link || articleURL(location.href) ||
      (base.tweetUrl ? `${base.tweetUrl}/article` : null);
    return {...merge(base, article), articleURL: url};
  }

  async function load(base) {
    if (!base.isArticle || base.articleLoaded) return base;
    try {
      if (!base.articleURL) throw new Error("未找到文章全文链接");
      const response = await chrome.runtime.sendMessage({action: "X_DIST_READ_ARTICLE", url: base.articleURL});
      if (!response?.ok || !response.article?.articleLoaded) throw new Error(response?.error || "未读取到文章正文");
      return merge(base, response.article);
    } catch {
      return {...base, articleError: "文章正文读取失败。请打开文章全文，等待加载完成后重新点击分发，或手动粘贴正文。"};
    }
  }

  function targets() {
    const tweets = Array.from(document.querySelectorAll(TWEET));
    for (const reader of document.querySelectorAll(ROOT)) {
      if (reader.closest(TWEET)) continue;
      if (!reader.querySelector('[data-x-dist-article-toolbar]')) {
        reader.setAttribute("data-x-dist-article-root", "1");
        const toolbar = document.createElement("div");
        toolbar.setAttribute("data-x-dist-article-toolbar", "1");
        toolbar.setAttribute("role", "group");
        reader.prepend(toolbar);
      }
      tweets.push(reader);
    }
    return tweets;
  }

  globalThis.XDistArticle = {extract, load, targets, readPage() {
    const reader = document.querySelector(ROOT);
    return reader ? read(reader) : null;
  }};
})();
