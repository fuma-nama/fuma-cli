import {
  type DownloadedRegistryInfo,
  type Component,
  componentSchema,
  registryInfoSchema,
} from "@/registry/schema";
import path from "node:path";
import fs from "node:fs/promises";
import { createCache } from "@/utils/cache";

export interface RegistryConnector {
  readonly id: string;
  fetchRegistryInfo: (subRegistry?: string) => Promise<DownloadedRegistryInfo>;
  fetchComponent: (name: string, subRegistry?: string) => Promise<Component>;
  hasComponent: (name: string, subRegistry?: string) => Promise<boolean>;
}

const fetchCache = createCache<object>();

export class HttpRegistryConnector implements RegistryConnector {
  readonly id: string;

  constructor(readonly baseUrl: string) {
    this.id = baseUrl;
  }

  async fetchRegistryInfo(subRegistry?: string) {
    const url = new URL(
      subRegistry ? `${subRegistry}/_registry.json` : "_registry.json",
      `${this.baseUrl}/`,
    );

    return fetchCache.$value<DownloadedRegistryInfo>().cached(url.href, async () => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`failed to fetch ${url.href}: ${res.statusText}`);
      }

      return registryInfoSchema.parse(await res.json());
    });
  }

  async fetchComponent(name: string, subRegistry?: string) {
    const url = new URL(
      subRegistry ? `${subRegistry}/${name}.json` : `${name}.json`,
      `${this.baseUrl}/`,
    );

    return fetchCache.$value<Component>().cached(url.href, async () => {
      const res = await fetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(`component ${name} not found at ${url.href}`);
        }
        throw new Error(await res.text());
      }

      return componentSchema.parse(await res.json());
    });
  }

  async hasComponent(name: string, subRegistry?: string) {
    const url = new URL(
      subRegistry ? `${subRegistry}/${name}.json` : `${name}.json`,
      `${this.baseUrl}/`,
    );

    return fetchCache.$value<boolean>().cached(`HEAD:${url.href}`, async () => {
      const res = await fetch(url, { method: "HEAD" });
      return res.ok;
    });
  }
}

export class LocalRegistryConnector implements RegistryConnector {
  readonly id: string;

  constructor(private readonly dir: string) {
    this.id = dir;
  }

  async fetchRegistryInfo(subRegistry?: string) {
    const filePath = path.join(this.dir, subRegistry ?? "", "_registry.json");
    const out = await fs
      .readFile(filePath, "utf-8")
      .then((res) => JSON.parse(res))
      .catch((e) => {
        throw new Error(`failed to resolve local file "${filePath}"`, {
          cause: e,
        });
      });

    return registryInfoSchema.parse(out);
  }

  async fetchComponent(name: string, subRegistry?: string) {
    const filePath = path.join(this.dir, subRegistry ?? "", `${name}.json`);
    const out = await fs
      .readFile(filePath, "utf-8")
      .then((res) => JSON.parse(res))
      .catch((e) => {
        throw new Error(`component ${name} not found at ${filePath}`, { cause: e });
      });

    return componentSchema.parse(out);
  }

  async hasComponent(name: string, subRegistry?: string) {
    const filePath = path.join(this.dir, subRegistry ?? "", `${name}.json`);
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
