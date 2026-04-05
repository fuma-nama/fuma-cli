import { BidirectedGraph } from "@/utils/graph";
import type { CompileContext, Component, FileGraphInfo } from "./compile";

export interface Chunk {
  chunkId: string;
}

export function isChunk(node: Component | Chunk): node is Chunk {
  return "chunkId" in node;
}

/**
 * @param prescannedFilePaths - list of file paths that already have a confirmed `chunk`.
 * @param ctx
 */
export function generateChunks(prescannedFilePaths: string[], ctx: CompileContext) {
  const { fileGraph } = ctx;
  const chunkGraph = new BidirectedGraph<Component | Chunk, undefined>();
  const referrerComponents = new Map<Chunk, Component[]>();

  function getReferrerComponents(node: Chunk): Component[] {
    const cached = referrerComponents.get(node);
    if (cached) return cached;

    const out: Component[] = [];
    referrerComponents.set(node, out);

    for (const referrer of chunkGraph.getVertex(node)!.referrers) {
      if (isChunk(referrer)) {
        out.push(...getReferrerComponents(referrer));
      } else {
        out.push(referrer);
      }
    }
    return out;
  }

  function decideChunk(data: FileGraphInfo, referrers: Set<string>) {
    if (data.chunk) return;
    const referrerChunks = new Set<Component | Chunk>();

    for (const referrer of referrers) {
      const referrerChunk = ctx.fileGraph.getVertex(referrer)!.data.chunk;
      // wait until all referrers are resolved
      if (!referrerChunk) return;

      referrerChunks.add(referrerChunk);
    }

    if (referrerChunks.size === 1) {
      data.chunk = referrerChunks.values().next().value;
      return;
    } else if (referrerChunks.size > 1) {
      const chunk: Chunk = {
        // TODO: generate proper id
        chunkId: `chunk-${Date.now()}`,
      };
      chunkGraph.addVertex(chunk, undefined);
      data.chunk = chunk;

      for (const referrerChunk of referrerChunks) {
        chunkGraph.addEdge(referrerChunk, chunk);
      }
    }
  }

  const next = new Set(prescannedFilePaths);

  for (const filePath of next) {
    const { data, referrers, referees } = fileGraph.getVertex(filePath)!;

    decideChunk(data, referrers);

    for (const referee of referees) {
      next.add(referee);
    }
  }

  return chunkGraph;
}
