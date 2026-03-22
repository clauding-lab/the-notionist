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
        // Only use external images; Notion file URLs expire after ~1 hour
        const imgUrl =
          block.image.type === "external"
            ? block.image.external?.url
            : null;
        if (imgUrl) {
          const caption = richTextToHtml(block.image.caption);
          html += `<figure><img src="${imgUrl}" alt="${caption || ""}" loading="lazy"><figcaption>${caption}</figcaption></figure>`;
        }
        break;

      case "bookmark":
        const bmUrl = block.bookmark.url;
        if (bmUrl) {
          html += `<p><a href="${bmUrl}" target="_blank" rel="noopener">${bmUrl}</a></p>`;
        }
        break;

      case "code":
        html += `<pre><code>${richTextToHtml(
          block.code.rich_text
        )}</code></pre>`;
        break;

      case "toggle":
        html += `<details><summary>${richTextToHtml(
          block.toggle.rich_text
        )}</summary>${renderChildren(block)}</details>`;
        break;

      default:
        // Skip unsupported block types silently
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
        and: [
          {
            property: "Type",
            select: { is_not_empty: true },
          },
          {
            or: [
              { property: "Type", select: { equals: "Clippings" } },
              { property: "Type", select: { equals: "References" } },
            ],
          },
          {
            property: "Status",
            status: { does_not_equal: "Archive" },
          },
        ],
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
      console.log(`  \u2713 ${title.substring(0, 50)}...`);
    } catch (err) {
      console.warn(`  \u2717 Failed to fetch content for: ${title}`);
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
