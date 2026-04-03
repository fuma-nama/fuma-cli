import { createCache } from "@/utils/cache";
import { HttpRegistryConnector, type RegistryConnector } from "../connector";
import type { Component } from "../schema";
import type { ComponentInstallerOptions, DownloadContext } from ".";

export interface DownloadedComponent extends Component {
  $subComponents: DownloadedComponent[];
  $registry: { root: RegistryConnector; subRegistry?: string };
}

export class DownloadManager {
  private readonly downloadCache = createCache<DownloadedComponent>();

  constructor(private readonly config: ComponentInstallerOptions) {}

  /**
   * download component & its sub components
   */
  async download(
    connector: RegistryConnector,
    name: string,
    subRegistry?: string,
  ): Promise<DownloadedComponent> {
    const plugins = this.config.plugins ?? [];

    return this.downloadCache.cached(
      JSON.stringify([connector.id, name, subRegistry]),
      async (presolve) => {
        const ctx: DownloadContext = {
          connector,
          manager: this,
          name,
          subRegistry,
        };

        for (const plugin of plugins) {
          await plugin.beforeDownload?.(ctx);
        }

        const comp = await connector.fetchComponent(name);
        // place it before downloading child components to avoid recursive downloads
        const result = presolve({
          ...comp,
          $registry: {
            root: connector,
            subRegistry,
          },
          $subComponents: [],
        });

        result.value.$subComponents = await Promise.all(
          comp.subComponents.map((sub) => {
            if (typeof sub === "string") return this.download(connector, sub);
            if (sub.type === "sub-registry") {
              return this.download(connector, sub.name, sub.subRegistry);
            }

            return this.download(
              new HttpRegistryConnector(sub.registryUrl),
              sub.component,
              sub.subRegistry,
            );
          }),
        );

        for (const plugin of plugins) {
          const v = await plugin.afterDownload?.(result.value, ctx);
          if (v) result.set(v);
        }

        return result.value;
      },
    );
  }
}
