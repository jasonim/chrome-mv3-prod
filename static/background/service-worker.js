importScripts("rednote-longform.js", "index.js");

// Read Article pages in the user's existing X session. Never send cookies or
// article contents to a third-party service.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.action !== "X_DIST_READ_ARTICLE") return false;
  let url;
  try {
    const source = new URL(sender.url);
    url = new URL(message.url);
    if (![source, url].every(value => value.protocol === "https:" &&
      ["x.com", "twitter.com"].includes(value.hostname)) ||
      !/^\/(?:i|\w+)\/article\/\d+\/?$/.test(url.pathname) &&
      !/^\/\w+\/status\/\d+\/article\/?$/.test(url.pathname)) throw new Error("Invalid article URL");
  } catch {
    respond({ok: false, error: "Invalid article URL"});
    return false;
  }

  (async () => {
    let tab;
    try {
      tab = await chrome.tabs.create({url: url.origin + url.pathname, active: false});
      const deadline = Date.now() + 20000;
      let previous = "";
      let stableSince = Date.now();
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        let article;
        try {
          const results = await chrome.scripting.executeScript({target: {tabId: tab.id},
            func: () => globalThis.XDistArticle?.readPage() || null});
          article = results[0]?.result;
        } catch {
          // The tab may still be navigating; a closed tab ends the request.
          await chrome.tabs.get(tab.id);
          continue;
        }
        if (!article?.articleLoaded) continue;
        const signature = JSON.stringify([article.text, article.media, article.articleBlocks]);
        if (signature !== previous) {
          previous = signature;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 1000) {
          respond({ok: true, article});
          return;
        }
      }
      respond({ok: false, error: "Article body did not load"});
    } catch {
      respond({ok: false, error: "Unable to load article"});
    } finally {
      if (tab?.id != null) await chrome.tabs.remove(tab.id).catch(() => {});
    }
  })();
  return true;
});
