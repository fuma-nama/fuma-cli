import { BidirectedGraph } from "@/utils/graph";
import type { CompileContext, Component, Registry } from "./compile";

export enum ChunkType {
  Group,
  Component,
}

export type Chunk = GroupChunk | ComponentChunk;

export interface GroupChunk {
  type: ChunkType.Group;
  id: string;
}

export interface ComponentChunk {
  type: ChunkType.Component;
  registry: Registry;
  component: Component;
}

/**
 * @param prescannedFilePaths - list of file paths that already have a confirmed `chunk`.
 * @param ctx
 */
export function generateChunks(prescannedFilePaths: string[], ctx: CompileContext) {
  const { fileGraph } = ctx;
  const chunkGraph = new BidirectedGraph<Chunk, undefined>();
  const referrerComponents = new Map<GroupChunk, Set<ComponentChunk>>();

  function getReferrerComponents(group: GroupChunk): Set<ComponentChunk> {
    const cached = referrerComponents.get(group);
    if (cached) return cached;

    const out = new Set<ComponentChunk>();
    referrerComponents.set(group, out);

    for (const referrer of chunkGraph.getVertex(group)!.referrers) {
      if (referrer.type === ChunkType.Group) {
        for (const item of getReferrerComponents(referrer)) out.add(item);
      } else {
        out.add(referrer);
      }
    }

    return out;
  }

  function equalReferrerComponents(chunk: GroupChunk, components: ComponentChunk[]) {
    const v = getReferrerComponents(chunk);
    return v.size === components.length && components.every((comp) => v.has(comp));
  }

  function traverse(filePath: string, visited: Set<string> = new Set()) {
    if (visited.has(filePath)) return;
    const { data, referees, referrers } = fileGraph.getVertex(filePath)!;

    if (!data.chunk) {
      const referrerChunks = new Set<Chunk>();

      for (const referrer of referrers) {
        const referrerChunk = ctx.fileGraph.getVertex(referrer)!.data.chunk;
        // wait until all referrers are resolved
        if (!referrerChunk) return;

        referrerChunks.add(referrerChunk);
      }

      if (referrerChunks.size === 0) {
        throw new Error("Impossible");
      } else if (referrerChunks.size === 1) {
        data.chunk = referrerChunks.values().next().value;
      } else {
        const referrerGroups: GroupChunk[] = [];
        const referrerComponents: ComponentChunk[] = [];

        for (const chunk of referrerChunks) {
          if (chunk.type === ChunkType.Group) referrerGroups.push(chunk);
          else referrerComponents.push(chunk);
        }

        const mergeableChunk =
          referrerGroups.length === 1 &&
          equalReferrerComponents(referrerGroups[0], referrerComponents)
            ? referrerGroups[0]
            : null;

        if (mergeableChunk) {
          data.chunk = mergeableChunk;
        } else {
          const chunk: GroupChunk = {
            type: ChunkType.Group,
            // TODO: generate proper id
            id: `c${Date.now()}`,
          };
          chunkGraph.addVertex(chunk, undefined);
          data.chunk = chunk;

          for (const referrerChunk of referrerChunks) {
            chunkGraph.addEdge(referrerChunk, chunk);
          }
        }
      }
    }

    visited.add(filePath);
    for (const referee of referees) {
      traverse(referee, visited);
    }
    visited.delete(filePath);
  }

  for (const filePath of prescannedFilePaths) traverse(filePath);
  return chunkGraph;
}

export function getFileGroupComponentName(group: GroupChunk): string {
  return `chunks/${group.id}`;
}

export function fileGroupToComponent(group: GroupChunk): Component {
  return {
    name: getFileGroupComponentName(group),
    files: [],
    unlisted: true,
  };
}
