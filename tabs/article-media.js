// Runs in the extension's publish page, where host permissions allow media reads.
(() => {
  "use strict";
  const normalize = text => String(text || "").replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ").replace(/\n+/g, "\n").trim();

  function layout(data, warnings = []) {
    const title = String(data.articleTitle || "").replace(/\r\n?/g, "\n").trim();
    let body = String(data.content || "").replace(/\r\n?/g, "\n").trim();
    if (title && body.startsWith(title + "\n\n")) body = body.slice(title.length).trimStart();
    const images = data.images || [];
    if (!images.length) return [{type: "text", text: body}];
    const blocks = Array.isArray(data.articleBlocks) ? data.articleBlocks : [];
    const sourceBody = blocks.filter(block => block.type === "text").map(block => block.text).join("\n\n");
    const uncertain = !Array.isArray(data.articleBlocks) || normalize(sourceBody) !== normalize(body);
    if (uncertain) warnings.push("配图位置无法确认，已按当前正文同步，并将所选图片放到文末，请手动调整位置。");
    const selected = new Set(images.map(item => item.url));
    const placed = new Set();
    const result = blocks.filter(block => !uncertain && block.type === "text" || block.type === "image" && selected.has(block.url))
      .map(block => {
        if (block.type === "image") placed.add(block.url);
        return {...block};
      });
    if (uncertain) result.unshift({type: "text", text: body});
    // Extra images explicitly selected in the panel (such as a generated card)
    // have no source position; append them after the article.
    for (const item of images) if (!placed.has(item.url)) {
      result.push({type: "image", url: item.url});
      placed.add(item.url);
    }
    return result;
  }

  async function fileData(item) {
    const response = await fetch(item.url, {signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    let blob = await response.blob();
    const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const isPNG = bytes.slice(0, 8).join() === "137,80,78,71,13,10,26,10";
    const isJPEG = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const isWebP = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    if (!isPNG && !isJPEG && !isWebP) throw new Error("文件不是可用的 PNG、JPEG 或 WebP 图片");
    if (blob.size > 10 * 1024 * 1024) throw new Error("图片超过长文编辑器的 10 MB 限制");
    if (isWebP) {
      // The current long-article paste handler accepts PNG/JPEG files only.
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("WebP 图片转换失败");
      } finally { bitmap.close(); }
    } else blob = new Blob([blob], {type: isPNG ? "image/png" : "image/jpeg"});
    if (blob.size > 10 * 1024 * 1024) throw new Error("转换后的图片超过 10 MB，请缩小图片后重试");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.readAsDataURL(blob);
    });
    const name = (item.name || "article-image").replace(/\.[^.]+$/, "") + (blob.type === "image/png" ? ".png" : ".jpg");
    return {sourceUrl: item.url, name, type: blob.type, size: blob.size, dataUrl};
  }

  async function prepare(data) {
    const articleWarnings = [];
    const articleLayout = layout(data, articleWarnings);
    const articleImages = [];
    const seen = new Set();
    let size = 0;
    // Download each selected source once, even if it occurs twice in the text.
    for (const item of data.images || []) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      try {
        const image = await fileData(item);
        if (size + image.size > 32 * 1024 * 1024) throw new Error("所选图片合计超过 32 MB");
        size += image.size;
        articleImages.push(image);
      } catch (error) {
        articleWarnings.push(`配图“${item.name || "未命名"}”准备失败：${error.message}。已跳过此图，继续同步正文和其他配图。`);
      }
    }
    const ready = new Set(articleImages.map(image => image.sourceUrl));
    return {...data, articleLayout: articleLayout.filter(block => block.type !== "image" || ready.has(block.url)), articleImages, articleWarnings};
  }
  globalThis.XDistArticleMedia = {layout, prepare};
})();
