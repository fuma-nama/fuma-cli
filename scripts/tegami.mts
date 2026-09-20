import { tegami, type TegamiPlugin } from "tegami";
import { runCli } from "tegami/cli";
import { github } from "tegami/plugins/github";
import { x } from "tinyexec";

const paper = tegami({
  plugins: [
    github({
      repo: "fuma-nama/fuma-cli",
      versionPr: {
        base: "dev",
      },
    }),
    buildOnPublish(),
  ],
  ignore: ["@repo/typescript-config"],
});

await runCli(paper);

export function buildOnPublish(): TegamiPlugin {
  return {
    name: "build-on-publish",
    async willPublish({ pkg }) {
      const result = await x("turbo", ["run", "build", "--filter", pkg.name], {
        nodeOptions: { cwd: this.cwd, stdio: "inherit" },
      });

      if (result.exitCode !== 0) {
        throw new Error(`Failed to build ${pkg.name}`);
      }
    },
  };
}
