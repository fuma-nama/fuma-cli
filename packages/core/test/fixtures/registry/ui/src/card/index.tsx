import type { Element } from "hast";
import { readFile } from "node:fs/promises";
import { Button } from "../button";
import { useCtx } from "../context";
import { useTheme, type Theme } from "../theme";
import { Layout } from "../layout";
import { Title } from "./parts";

// keep me

export function Card() {
  const lazy = import("../button");
  return <Layout />;
}
