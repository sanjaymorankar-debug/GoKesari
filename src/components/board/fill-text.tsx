import { Fragment, type ReactNode } from "react";

/**
 * Module 6 (docs/hindi-marathi-2026-11/): a translated sentence with `{name}`
 * placeholders where a node goes (an amount drawn with <Money />, a link…).
 * Word order differs between English, Hindi and Marathi, so the node is
 * placed wherever the translation puts its placeholder. Unknown names are
 * left as written.
 */
export function FillText({ text, parts }: { text: string; parts: Record<string, ReactNode> }) {
  const pieces = text.split(/(\{\w+\})/);
  return (
    <>
      {pieces.map((piece, i) => {
        const key = /^\{(\w+)\}$/.exec(piece)?.[1];
        return <Fragment key={i}>{key && key in parts ? parts[key] : piece}</Fragment>;
      })}
    </>
  );
}
