import path from "node:path";
import fs from "node:fs/promises";
import { assertManifest, type Manifest } from "@/registry/schema";

export interface RegistryConnector {
  /** @param registry - name of sub registry, the root registry if omitted */
  fetchManifest: (registry?: string) => Promise<Manifest>;
  fetchFile: (file: string, registry?: string) => Promise<Uint8Array>;
}

export class HttpRegistryConnector implements RegistryConnector {
  constructor(readonly baseUrl: string) {}

  private async fetch(pathname: string, registry?: string) {
    const url = `${this.baseUrl}/${registry ? `${registry}/` : ""}${pathname}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
    return res;
  }

  async fetchManifest(registry?: string) {
    const res = await this.fetch("_registry.json", registry);
    return assertManifest(await res.json());
  }

  async fetchFile(file: string, registry?: string) {
    const res = await this.fetch(`files/${file}`, registry);
    return res.bytes();
  }
}

export class LocalRegistryConnector implements RegistryConnector {
  constructor(private readonly dir: string) {}

  async fetchManifest(registry = "") {
    const file = path.join(this.dir, registry, "_registry.json");
    return assertManifest(JSON.parse(await fs.readFile(file, "utf-8")));
  }

  fetchFile(file: string, registry = "") {
    return fs.readFile(path.join(this.dir, registry, "files", file));
  }
}
