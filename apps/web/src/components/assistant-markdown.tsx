import { memo, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

import styles from "./assistant-markdown.module.css";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

// react-markdown passes the source `node` to custom components; keep it off
// the DOM element.
function domProps<Props extends { node?: unknown }>(props: Props) {
  const rest: Omit<Props, "node"> & { node?: unknown } = { ...props };
  delete rest.node;
  return rest;
}

function Heading(props: ComponentProps<"h1"> & { node?: unknown }) {
  return <p {...domProps(props)} className={styles.heading} />;
}

const components: Components = {
  a: (props) => (
    <a
      {...domProps(props)}
      className={cn(
        "text-primary underline underline-offset-2 hover:no-underline",
        props.className,
      )}
      rel="noreferrer"
      target="_blank"
    />
  ),
  code: (props) => (
    <code {...domProps(props)} className={cn("font-mono", props.className)} />
  ),
  h1: Heading,
  h2: Heading,
  h3: Heading,
  h4: Heading,
  table: (props) => (
    <div className="my-2 overflow-x-auto rounded-md border border-border">
      <table {...domProps(props)} className="w-full text-xs tabular-nums" />
    </div>
  ),
};

/**
 * Renders assistant text as GitHub-flavoured Markdown with highlighted code.
 * Raw HTML in model output is not rendered.
 */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
}: {
  text: string;
}) {
  return (
    <div className={cn("text-sm leading-5", styles.markdown)}>
      <Markdown
        components={components}
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
      >
        {text}
      </Markdown>
    </div>
  );
});
