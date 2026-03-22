const { Client } = require("@notionhq/client");
const fs = require("fs");
const path = require("path");

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

// Recursively fetch all block children
async function fetchBlockChildren(blockId) {
  const blocks = [];
  let cursor = undefined;

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });

    for (const block of response.results) {
      if (block.has_children) {
        block.children = await fetchBlockChildren(block.id);
      }
      blocks.push(block);
    }

    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

async function getPageContent(pageId) {
  const blocks = await fetchBlockChildren(pageId);
  return blocksToHtml(blocks);
}

function richTextToHtml(richTexts) {
  if (!richTexts || !richTexts.length) return "";
  return richTexts
    .map((rt) => {
      let text = rt.plain_text || "";
      // Escape HTML
      text = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      if (rt.annotations) {
        if (rt.annotations.bold) text = `<strong>${text}</strong>`;
        if (rt.annotations.italic) text = `<em>${text}</em>`;
        if (rt.annotations.underline) text = `<u>${text}</u>`;
        if (rt.annotations.strikethrough) text = `<s>${text}</s>`;
        if (rt.annotations.code) text = `<code>${text}</code>`;
      }

      if (rt.href) {
        text = `<a href="${rt.href}" target="_blank" rel="noopener">${text}</a>`;
      }

      return text;
    })
    .join("");
}

function renderChildren(block) {
  if (block.children && block.children.length) {
    return blocksToHtml(block.children);
  }
  return "";
}

function blocksToHtml(blocks) {
  let html = "";

  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        const pText = richTextToHtml(block.paragraph.rich_text);
        if (pText) html += `<p>${pText}</p>`;
        break;

      case "heading_1":
        html += `<h2>${richTextToHtml(block.heading_1.rich_text)}</h2>`;
        break;

      case "heading_2":
        html += `<h3>${richTextToHtml(block.heading_2.rich_text)}</h3>`;
        break;

      case "heading_3":
        html += `<h4>${richTextToHtml(block.heading_3.rich_text)}</h4>`;
        break;

      case "bulleted_list_item":
        html += `<ul><li>${richTextToHtml(
          block.bulleted_list_item.rich_text
        )}${renderChildren(block)}</li></ul>`;
        break;

      case "numbered_list_item":
        html += `<ol><li>${richTextToHtml(
          block.numbered_list_item.rich_text
        )}${renderChildren(block)}</li></ol>`;
        break;

      case "to_do":
        const checked = block.to_do.checked ? "checked" : "";
        html += `<ul><li><input type="checkbox" disabled ${checked}> ${richTextToHtml(
          block.to_do.rich_text
        )}${renderChildren(block)}</li></ul>`;
        break;

      case "quote":
        html += `<blockquote>${richTextToHtml(
          block.quote.rich_text
        )}${renderChildren(block)}</blockquote>`;
        break;

      case "callout":
        const icon = block.callout.icon?.emoji || "\u{1F4A1}";
        html += `<div class="callout"><span class="callout-icon">${icon}</span><div>${richTextToHtml(
          block.callout.rich_text
        )}${renderChildren(block)}</div></div>`;
        break;

      case "divider":
        html += `<hr>`;
        break;

      case "image":
        // Use external images directly; Notion file URLs expire but are
        // the only option for uploaded images, so include them too
        const imgUrl =
          block.image.type === "external"
            ? block.image.external?.url
            : block.image.file?.url;
        if (imgUrl) {
          const caption = richTextToHtml(block.image.caption);
          html += `<figure><img src="${imgUrl}" alt="${caption || ""}" loading="lazy"><figcaption>${caption}</figcaption></figure>`;
        }
        break;

      case "video":
        const vidUrl =
          block.video.type === "external"
            ? block.video.external?.url
            : block.video.file?.url;
        if (vidUrl) {
          // YouTube/Vimeo embeds
          if (vidUrl.includes("youtube.com") || vidUrl.includes("youtu.be")) {
            const vid = vidUrl.match(/(?:v=|youtu\.be\/)([^&?]+)/)?.[1];
            if (vid) html += `<figure><iframe src="https://www.youtube.com/embed/${vid}" allowfullscreen style="width:100%;aspect-ratio:16/9;border:none"></iframe></figure>`;
          } else {
            html += `<p><a href="${vidUrl}" target="_blank" rel="noopener">[Video]</a></p>`;
          }
        }
        break;

      case "embed":
        const embedUrl = block.embed?.url;
        if (embedUrl) {
          html += `<p><a href="${embedUrl}" target="_blank" rel="noopener">${embedUrl}</a></p>`;
        }
        break;

      case "bookmark":
        const bmUrl = block.bookmark.url;
        if (bmUrl) {
          const bmCaption = richTextToHtml(block.bookmark.caption);
          html += `<p><a href="${bmUrl}" target="_blank" rel="noopener">${bmCaption || bmUrl}</a></p>`;
        }
        break;

      case "link_preview":
        const lpUrl = block.link_preview?.url;
        if (lpUrl) {
          html += `<p><a href="${lpUrl}" target="_blank" rel="noopener">${lpUrl}</a></p>`;
        }
        break;

      case "code":
        const lang = block.code.language || "";
        html += `<pre><code class="language-${lang}">${richTextToHtml(
          block.code.rich_text
        )}</code></pre>`;
        break;

      case "toggle":
        html += `<details><summary>${richTextToHtml(
          block.toggle.rich_text
        )}</summary>${renderChildren(block)}</details>`;
        break;

      // Container blocks — just render their children
      case "column_list":
      case "column":
      case "synced_block":
        html += renderChildren(block);
        break;

      // Table support
      case "table":
        html += `<table>${renderChildren(block)}</table>`;
        break;

      case "table_row":
        html += "<tr>";
        if (block.table_row?.cells) {
          for (const cell of block.table_row.cells) {
            html += `<td>${richTextToHtml(cell)}</td>`;
          }
        }
        html += "</tr>";
        break;

      case "child_page":
        html += `<p><strong>${block.child_page?.title || "Page"}</strong></p>`;
        html += renderChildren(block);
        break;

      case "child_database":
        // Skip child databases
        break;

      case "equation":
        html += `<p class="equation">${block.equation?.expression || ""}</p>`;
        break;

      case "table_of_contents":
      case "breadcrumb":
      case "link_to_page":
        // Skip navigation-only blocks
        break;

      case "pdf":
      case "file":
        const fileUrl =
          block[block.type]?.type === "external"
            ? block[block.type]?.external?.url
            : block[block.type]?.file?.url;
        if (fileUrl) {
          html += `<p><a href="${fileUrl}" target="_blank" rel="noopener">[${block.type.toUpperCase()}]</a></p>`;
        }
        break;

      default:
        console.warn(`    ⚠ Unknown block type: ${block.type}`);
        // Try to render children if present
        html += renderChildren(block);
        break;
    }
  }

  // Merge adjacent list items
  html = html
    .replace(/<\/ul>\s*<ul>/g, "")
    .replace(/<\/ol>\s*<ol>/g, "");

  return html;
}

async function fetchArticles() {
  const allResults = [];
  let cursor = undefined;

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      filter: {
        property: "Status",
        status: { does_not_equal: "Archive" },
      },
      sorts: [{ property: "Created", direction: "descending" }],
    });

    allResults.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;
  } while (cursor);

  console.log(`Found ${allResults.length} articles. Fetching content...`);

  const articles = [];

  for (const page of allResults) {
    const props = page.properties;

    const titleProp = props["Name"];
    const title =
      titleProp?.title?.map((t) => t.plain_text).join("") || "Untitled";

    const url = props["URL"]?.url || null;

    let domain = null;
    if (url) {
      try {
        domain = new URL(url).hostname.replace("www.", "");
      } catch {}
    }

    const type = props["Type"]?.select?.name || null;
    const status = props["Status"]?.status?.name || null;
    const tags =
      props["Subject Tags"]?.multi_select?.map((t) => t.name) || [];
    const created = props["Created"]?.created_time || null;
    const lastEdited = props["Last edited"]?.last_edited_time || null;

    // Fetch page content
    let content = "";
    try {
      content = await getPageContent(page.id);
      const blockCount = (content.match(/<(p|h[2-4]|li|blockquote|figure|pre|div|tr|details)/g) || []).length;
      console.log(`  \u2713 ${title.substring(0, 50)}... (${content.length} chars, ${blockCount} blocks)`);
    } catch (err) {
      console.warn(`  \u2717 Failed to fetch content for: ${title} — ${err.message}`);
    }

    articles.push({
      id: page.id,
      title,
      url,
      domain,
      notionUrl: `https://notion.so/${page.id.replace(/-/g, "")}`,
      type,
      status,
      tags,
      created,
      lastEdited,
      content,
    });

    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 150));
  }

  const feed = {
    generated: new Date().toISOString(),
    count: articles.length,
    articles,
  };

  const outPath = path.join(__dirname, "..", "public", "feed.json");
  fs.writeFileSync(outPath, JSON.stringify(feed, null, 2));
  console.log(`\n\u2713 Wrote ${articles.length} articles to feed.json`);
}

fetchArticles().catch((err) => {
  console.error("Failed to fetch articles:", err);
  process.exit(1);
});
