import type { CompileContext, Component, Registry } from "./compile";

export enum ChunkType {
  Group,
  Component,
}

export type Chunk = GroupChunk | ComponentChunk;

export interface GroupChunk {
  type: ChunkType.Group;
  id: string;
  componentName: string;
}

export interface ComponentChunk {
  type: ChunkType.Component;
  registry: Registry;
  component: Component;
}

export function generateChunks(ctx: CompileContext) {
  const { fileGraph } = ctx;

  function traverse(filePath: string, visited: Set<string> = new Set()) {
    if (visited.has(filePath)) return;
    const { data, referees, referrers } = fileGraph.getNode(filePath)!;

    if (!data.chunk) {
      const referrerChunks = new Set<Chunk>();

      for (const referrer of referrers) {
        const referrerChunk = fileGraph.getVertex(referrer)!.chunk;
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

        const chunkId = generateGroupId(referrerComponents);

        if (referrerGroups.length === 1 && referrerGroups[0].id === chunkId) {
          data.chunk = referrerGroups[0];
        } else {
          data.chunk = {
            type: ChunkType.Group,
            id: chunkId,
            componentName: `chunks/${chunkId}`,
          };
          ctx.chunks.add(data.chunk);
        }
      }
    }

    visited.add(filePath);
    for (const referee of referees) {
      traverse(referee, visited);
    }
    visited.delete(filePath);
  }

  const rootNodes: string[] = [];
  for (const file of fileGraph.vertices()) {
    if (fileGraph.getVertex(file)!.chunk) rootNodes.push(file);
  }

  for (const filePath of rootNodes) traverse(filePath);
}

/**
 * all files in a file group must be referenced by exactly same set of components.
 *
 * hence, the unique ID can be generated purely based on input components.
 */
function generateGroupId(components: ComponentChunk[]) {
  const segments = components.map((comp) => {
    return `${comp.registry.name}:${comp.component.name}`;
  });

  segments.sort();
  return segments.join("+");
}
