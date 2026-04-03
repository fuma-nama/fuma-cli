import type { ComponentFile } from "@/compiler";
import type { CompiledFile } from "../schema";

export type ImportInfo =
  | {
      type: "raw";
      specifier: string;
    }
  | {
      /** file in the same component/chunk, should be the target path, or the route of a component file */
      type: "local";
      fileId: string;
    };

export function encodeImport(info: ImportInfo): string {
  switch (info.type) {
    case "local":
      return `local:${info.fileId}`;
    case "raw":
      return info.specifier;
  }
}

export function decodeImport(s: string): ImportInfo {
  if (s.startsWith("local:")) {
    return {
      type: "local",
      fileId: s.slice("local:".length),
    };
  }

  return { type: "raw", specifier: s };
}

export function getComponentFileId(component: ComponentFile | CompiledFile): string {
  if (component.type === "route-handler") return component.route;
  return component.target ?? component.path;
}
