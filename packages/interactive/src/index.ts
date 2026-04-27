import { ComponentInstaller, ComponentInstallerOptions } from "fuma-cli/registry/installer";
import { RegistryConnector } from "fuma-cli/registry/connector";
import {
  autocompleteMultiselect,
  box,
  confirm,
  isCancel,
  log,
  outro,
  spinner,
  SpinnerResult,
} from "@clack/prompts";
import picocolors from "picocolors";
import { detect } from "package-manager-detector";

export class FumadocsComponentInstaller extends ComponentInstaller {
  private interactive: {
    name: string;
    spin: SpinnerResult;
  } | null = null;

  constructor(connector: RegistryConnector, config: Omit<ComponentInstallerOptions, "io">) {
    super(connector, {
      ...config,
      io: {
        onWarn: (message) => {
          this.interactive?.spin.message(message);
        },
        confirmFileOverride: async (options) => {
          if (!this.interactive) return true;
          const { name, spin } = this.interactive;
          spin.clear();
          const value = await confirm({
            message: `Do you want to override ${options.path}?`,
            initialValue: false,
          });
          if (isCancel(value)) {
            outro("Installation terminated");
            process.exit(0);
          }
          spin.start(picocolors.bold(picocolors.cyanBright(`Installing ${name}`)));
          return value;
        },
        onFileDownloaded: (options) => {
          this.interactive?.spin.message(options.path);
        },
      },
    });
  }

  async add(config: { subRegistries?: string[] } = {}) {
    const { subRegistries = [] } = config;
    const connector = this.connector;

    const spin = spinner();
    spin.start("fetching registry");

    async function scan(subRegistry?: string) {
      const info = await connector.fetchRegistryInfo(subRegistry);

      return info.indexes.map((item) => ({
        label: item.title ?? item.name,
        value: { name: item.name, subRegistry },
        hint: item.description,
      }));
    }

    spin.stop(picocolors.bold(picocolors.greenBright("registry fetched")));
    const value = await autocompleteMultiselect({
      message: "Select components to install",
      options: (await Promise.all([scan(), ...subRegistries.map(scan)])).flat(),
    });

    if (isCancel(value)) {
      outro("Ended");
      return;
    }

    for (const target of value) {
      await this.installInteractive(target.name, target.subRegistry);
    }

    outro(picocolors.bold(picocolors.greenBright("Successful")));
  }

  async installInteractive(name: string, subRegistry?: string): Promise<void> {
    if (this.interactive) {
      throw new Error(`cannot install while installing another component`);
    }

    const spin = spinner();
    spin.start(picocolors.bold(picocolors.cyanBright(`Installing ${name}`)));

    try {
      this.interactive = { name, spin };
      const deps = await super.install(name, subRegistry).then((res) => res.deps());
      spin.stop(picocolors.bold(picocolors.greenBright(`${name} installed`)));

      if (deps.hasRequired()) {
        log.message();
        box([...deps.dependencies, ...deps.devDependencies].join("\n"), "New Dependencies");
        const pm = (await detect())?.name ?? "npm";
        const value = await confirm({
          message: `Do you want to install with ${pm}?`,
        });

        if (isCancel(value)) {
          outro("Installation terminated");
          process.exit(0);
        }

        if (value) {
          const spin = spinner({
            errorMessage: "Failed to install dependencies",
          });
          spin.start("Installing dependencies");
          await deps.installRequired(pm);
          spin.stop("Dependencies installed");
        } else {
          await deps.writeRequired();
        }
      }
    } catch (e) {
      spin.error(e instanceof Error ? e.message : String(e));
      process.exit(-1);
    } finally {
      this.interactive = null;
    }
  }
}
