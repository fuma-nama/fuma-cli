/** `<registry>:<path>` */
export function encodeFileId(registry: string, path: string): string {
  return `${registry}:${path}`;
}

export function decodeFileId(id: string): { registry: string; path: string } {
  const idx = id.indexOf(":");
  return { registry: id.slice(0, idx), path: id.slice(idx + 1) };
}
