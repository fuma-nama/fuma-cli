import type { Registry, ComponentFile, Reference } from "./compile";

export function resolveFromSubRegistry(
  subRegistry: Registry,
  component: string,
  selectFile: (file: ComponentFile) => boolean,
): Reference | undefined {
  const comp = subRegistry.components.find((comp) => comp.name === component);
  if (!comp) return;
  const file = comp.files.find(selectFile);
  if (!file) return;

  return {
    type: "sub-component",
    resolved: {
      type: "local",
      subRegistry: subRegistry.name,
      component: comp,
      file,
    },
  };
}
