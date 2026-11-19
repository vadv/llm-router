// Safe Markdown rendering for chat messages and tool cards.
// Rules: GFM only, no raw HTML, no image rendering, http(s) links only.

import { CopyButton } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import type { Element } from "hast";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { LanguageFn } from "highlight.js";
import { memo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { safeHttpUrl } from "../model-key";
import "highlight.js/styles/github-dark.css";

// Only these languages are registered; fences in any other language stay
// plain. `html` is an alias registered by the `xml` grammar. Automatic
// language detection stays off, so unmarked code blocks stay plain too.
const codeLanguages: Record<string, LanguageFn> = {
  bash,
  css,
  javascript,
  json,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

function nodeText(node: Element): string {
  return node.children
    .map((child) =>
      child.type === "text"
        ? child.value
        : child.type === "element"
          ? nodeText(child)
          : "",
    )
    .join("");
}

function codeFence(node: Element | undefined): { language: string; text: string } | null {
  const code = node?.children.find(
    (child): child is Element =>
      child.type === "element" && child.tagName === "code",
  );
  if (!code) return null;
  const classes = Array.isArray(code.properties?.className)
    ? (code.properties.className as unknown[])
    : [];
  const marked = classes.find(
    (cls): cls is string => typeof cls === "string" && cls.startsWith("language-"),
  );
  return { language: marked?.slice("language-".length) ?? "", text: nodeText(code) };
}

function CodePre({
  node,
  children,
}: ComponentPropsWithoutRef<"pre"> & { node?: Element }) {
  const fence = codeFence(node);
  return (
    <div className="chat-code">
      <div className="chat-code-head">
        <span className="chat-code-lang">{fence?.language || "code"}</span>
        <CopyButton value={fence?.text ?? ""} timeout={1200}>
          {({ copied, copy }) => (
            <button
              type="button"
              className="chat-copy"
              onClick={copy}
              aria-label={copied ? "Copied" : "Copy code"}
            >
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
              Copy
            </button>
          )}
        </CopyButton>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function MarkdownLink({
  href,
  children,
}: ComponentPropsWithoutRef<"a"> & { node?: Element }) {
  return <SafeLink href={href}>{children}</SafeLink>;
}

const markdownComponents: Components = {
  pre: CodePre,
  a: MarkdownLink,
  // External images are not rendered in chat Markdown.
  img: () => null,
};

// Shared by Markdown links and card links: only http(s) becomes an
// anchor, anything else degrades to plain text.
export function SafeLink({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  const safe = typeof href === "string" ? safeHttpUrl(href) : null;
  if (!safe) {
    return <span className="chat-unsafe-url">{children}</span>;
  }
  return (
    <a className="chat-link" href={safe} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
}: {
  children: string;
}) {
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, languages: codeLanguages }]]}
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});
