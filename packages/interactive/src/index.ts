import {
  ComponentInstaller,
  type ComponentInstallerOptions,
  type InstallTarget,
} from "fuma-cli/registry/installer";
import { RegistryConnector } from "fuma-cli/registry/connector";
import {
  autocompleteMultiselect,
  box,
  confirm,
  isCancel,
  log,
  outro,
  spinner,
  type Option,
  type SpinnerResult,
} from "@clack/prompts";
import path from "node:path";
import picocolors from "picocolors";
import { detectPackageManager } from "fuma-cli/detect";

export class InteractiveInstaller extends ComponentInstaller {
  private interactive: {
    name: string;
    spin: SpinnerResult;
  } | null = null;

  constructor(connector: RegistryConnector, config: ComponentInstallerOptions = {}) {
    const toRelative = (file: string) => path.relative(config.cwd ?? process.cwd(), file);

    super(connector, {
      ...config,
      io: {
        confirmFileOverride: async (options) => {
          if (!this.interactive) return true;
          const { name, spin } = this.interactive;
          spin.clear();
          const value = await confirm({
            message: `Do you want to override ${toRelative(options.output)}?`,
            initialValue: false,
          });
          if (isCancel(value)) {
            outro("Installation terminated");
            process.exit(0);
          }
          spin.start(picocolors.bold(picocolors.cyanBright(`Installing ${name}`)));
          return value;
        },
        onFileWritten: (file) => {
          this.interactive?.spin.message(toRelative(file.output));
        },
        ...config.io,
      },
    });
  }

  async add(config: { subRegistries?: string[] } = {}) {
    const { subRegistries = [] } = config;
    const spin = spinner();
    spin.start("fetching registry");

    const scan = async (registry?: string) => {
      const options: Option<InstallTarget>[] = [];
      for (const item of (await this.fetchManifest(registry)).components) {
        if (item.unlisted) continue;
        options.push({
          label: item.title ?? item.name,
          value: { name: item.name, registry },
          hint: item.description,
        });
      }
      return options;
    };

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
      await this.installInteractive(target.name, target.registry);
    }

    outro(picocolors.bold(picocolors.greenBright("Successful")));
  }

  async installInteractive(name: string, registry?: string): Promise<void> {
    if (this.interactive) {
      throw new Error(`cannot install while installing another component`);
    }

    const spin = spinner();
    spin.start(picocolors.bold(picocolors.cyanBright(`Installing ${name}`)));

    try {
      this.interactive = { name, spin };
      const deps = await super.install(name, registry).then((res) => res.deps());
      spin.stop(picocolors.bold(picocolors.greenBright(`${name} installed`)));

      if (deps.hasRequired()) {
        log.message();
        box([...deps.dependencies, ...deps.devDependencies].join("\n"), "New Dependencies");
        const pm = (await detectPackageManager())?.name ?? "npm";
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

/** @deprecated use `InteractiveInstaller` */
export { InteractiveInstaller as FumadocsComponentInstaller };
