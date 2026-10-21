/**
 * StudyForge — minimal, safe Markdown renderer.
 *
 * AI output is untrusted text, so everything is HTML-escaped first and only a
 * small, fixed set of Markdown constructs is converted afterwards. Only http,
 * https and mailto links are allowed.
 */
(function (StudyForge) {
  "use strict";

  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char]);
  }

  function inline(text) {
    let out = escapeHtml(text);

    // Protect inline code before applying any other rule.
    const code = [];
    out = out.replace(/`([^`]+)`/g, (match, content) => {
      code.push(content);
      return `\u0000${code.length - 1}\u0000`;
    });

    out = out.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    out = out.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");

    return out.replace(/\u0000(\d+)\u0000/g, (match, index) => `<code>${code[Number(index)]}</code>`);
  }

  function render(markdown) {
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    let paragraph = [];
    let list = null; // { tag, items }
    let inCode = false;
    let codeLines = [];
    let quote = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      html.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    };
    const flushList = () => {
      if (!list) return;
      html.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
      list = null;
    };
    const flushQuote = () => {
      if (!quote.length) return;
      html.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      quote = [];
    };
    const flushAll = () => {
      flushParagraph();
      flushList();
      flushQuote();
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, "");

      if (inCode) {
        if (/^```/.test(line)) {
          html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
          inCode = false;
          codeLines = [];
        } else {
          codeLines.push(rawLine);
        }
        continue;
      }

      if (/^```/.test(line)) {
        flushAll();
        inCode = true;
        continue;
      }

      if (!line.trim()) {
        flushAll();
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushAll();
        const level = Math.min(heading[1].length + 1, 6); // page already owns h1
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(line)) {
        flushAll();
        html.push("<hr>");
        continue;
      }

      const quoteLine = line.match(/^>\s?(.*)$/);
      if (quoteLine) {
        flushParagraph();
        flushList();
        quote.push(quoteLine[1]);
        continue;
      }
      flushQuote();

      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (bullet || ordered) {
        flushParagraph();
        const tag = bullet ? "ul" : "ol";
        if (list && list.tag !== tag) flushList();
        if (!list) list = { tag, items: [] };
        list.items.push((bullet || ordered)[1].replace(/^\s+/, ""));
        continue;
      }

      if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += " " + line.trim();
        continue;
      }

      flushList();
      paragraph.push(line.trim());
    }

    if (inCode && codeLines.length) {
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    }
    flushAll();
    return html.join("\n");
  }

  StudyForge.md = { render, escapeHtml, inline };
})((window.StudyForge = window.StudyForge || {}));
