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

  function generateChunk(data: FileGraphInfo, referrers: Set<string>) {
    if (data.chunks) return;
    const components = new Set<Component>();

    for (const referrer of referrers) {
      const referrerChunks = ctx.fileGraph.getVertex(referrer)!.data.chunks;
      // wait until all referrers are resolved
      if (!referrerChunks) return;

      for (const item of referrerChunks) {
        if (isChunk(item)) {
          for (const comp of getReferrerComponents(item)) components.add(comp);
        } else {
          components.add(item);
        }
      }
    }

    if (components.size === 1) {
      data.chunks = components;
    } else if (components.size > 1) {
      const chunk: Chunk = {
        // TODO: generate proper id
        chunkId: `chunk-${Date.now()}`,
      };
      chunkGraph.addVertex(chunk, undefined);
      data.chunks = new Set([chunk]);

      for (const comp of components) chunkGraph.addEdge(comp, chunk);
    }
  }

  function generateEdges(filePath: string, data: FileGraphInfo, referrers: Set<string>) {
    const fileChunks = data.chunks;
    if (!fileChunks) return;
    const referrerChunks = new Set<Component | Chunk>();

    for (const referrer of referrers) {
      const chunks = fileGraph.getVertex(referrer)!.data.chunks;
      // wait until all referrers are resolved
      if (!chunks) return;
      for (const chunk of chunks) referrerChunks.add(chunk);
    }

    for (const chunk of fileChunks) referrerChunks.delete(chunk);

    if (referrerChunks.size === 0 || fileChunks.size === 0) return;
    if (fileChunks.size > 1) {
      throw new Error(
        `file "${filePath}" is a part of multiple components, but it is also referenced by "${JSON.stringify(referrerChunks)}", failed to generate sub components.`,
      );
    }

    for (const referrerChunk of referrerChunks) {
      for (const chunk of fileChunks) chunkGraph.addEdge(referrerChunk, chunk);
    }
  }

  const next = new Set(prescannedFilePaths);

  for (const filePath of next) {
    const { data, referrers, referees } = fileGraph.getVertex(filePath)!;

    generateChunk(data, referrers);
    generateEdges(filePath, data, referrers);

    for (const referee of referees) {
      next.add(referee);
    }
  }

  return chunkGraph;
}
