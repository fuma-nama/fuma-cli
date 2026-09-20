import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { expect, test, vi } from "vitest";
import { compile, writeRegistry, type Registry } from "@/compiler";
import { LocalRegistryConnector } from "@/registry/connector";
import { ComponentInstaller, reuseUI, type InstallPlan } from "@/registry/installer";

const fixtures = path.join(import.meta.dirname, "fixtures/registry");
const registry: Registry = {
  name: "ui",
  dir: path.join(fixtures, "ui/src"),
  components: {
    button: { title: "Button", entry: "button.tsx" },
    card: { description: "A card", entry: "card/index.tsx" },
    chat: "chat.ts",
    layout: "layout.tsx",
    og: "og/image.tsx",
  },
  files: {
    "button.tsx": { type: "ui" },
    "chat.ts": { type: "route-handler", route: "api/chat" },
    "layout.tsx": { type: "layout", target: "<dir>/layout.tsx", preserve: true },
    "utils/cn.ts": { type: "lib" },
    "card/**": { type: "components", target: "<dir>/card/*" },
    "og/**": { type: "lib", target: "<dir>/og/*" },
  },
  subRegistries: [
    {
      name: "extra",
      dir: path.join(fixtures, "extra/src"),
      components: { badge: "badge.tsx" },
      files: {
        "badge.tsx": { type: "components" },
        "cn.ts": { alias: "../../ui/src/utils/cn.ts" },
      },
    },
  ],
};

const shake: Registry = {
  name: "shake",
  dir: path.join(fixtures, "shake/src"),
  components: { all: "all.ts", input: "input.tsx", "nav-link": "nav-link.tsx" },
  files: {
    "all.ts": { type: "lib" },
    "lib/utils.ts": { type: "lib", treeshake: true },
    "lib/*": { type: "lib" },
    "*.tsx": { type: "components" },
  },
};

async function setup(root = registry) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fuma-cli-"));
  await writeRegistry(await compile({ root }), { dir: path.join(dir, "registry") });

  const cwd = path.join(dir, "app");
  await fs.mkdir(cwd);
  const confirmFileOverride = vi.fn(() => true);
  const installer = new ComponentInstaller(new LocalRegistryConnector(path.join(dir, "registry")), {
    cwd,
    framework: "none",
    io: { confirmFileOverride },
  });
  return { cwd, installer, confirmFileOverride };
}

test("compile", async () => {
  const out = await compile({ root: registry });

  expect(out.manifest).toMatchSnapshot();
  expect(out.files.get("card/index.tsx")).toMatchSnapshot();
  expect(out.subRegistries[0].manifest).toMatchSnapshot();
});

test("missing export", async () => {
  await expect(
    compile({
      root: { ...registry, components: { bad: "card/bad.ts" } },
    }),
  ).rejects.toThrow(/internalOnly of it is not a public export of "acme-ui"/);
});

test("install", async () => {
  const { cwd, installer } = await setup();
  const plan = await installer.install("card");

  expect(plan.files.map((file) => path.relative(cwd, file.output)).sort()).toMatchInlineSnapshot(`
    [
      "components/card/index.tsx",
      "components/card/parts.tsx",
      "components/ui/button.tsx",
      "lib/cn.ts",
    ]
  `);
  expect(await fs.readFile(path.join(cwd, "components/card/index.tsx"), "utf-8")).toMatchSnapshot();
  expect((await plan.deps()).dependencies).toMatchInlineSnapshot(`
    [
      "acme-ui@^1.2.0",
      "clsx@^2.0.0",
    ]
  `);
});

test("preserved import links to installed file", async () => {
  const { cwd, installer } = await setup();
  await installer.install("layout");
  await installer.install("badge", "extra");

  expect(await fs.readFile(path.join(cwd, "components/badge.tsx"), "utf-8")).toMatchSnapshot();
});

test("assets & route handlers", async () => {
  const { cwd, installer } = await setup();
  await installer.install("og");
  await installer.install("chat");

  expect(await fs.readFile(path.join(cwd, "lib/og/image.tsx"), "utf-8")).toMatchSnapshot();
  expect(await fs.readFile(path.join(cwd, "lib/og/font.ttf"))).toEqual(
    await fs.readFile(path.join(fixtures, "ui/src/og/font.ttf")),
  );
  expect(await fs.readFile(path.join(cwd, "app/api/chat/route.ts"), "utf-8")).toMatchSnapshot();
});

test("treeshake: compile", async () => {
  const out = await compile({ root: shake });

  expect(out.files.get("lib/utils.ts")).toMatchSnapshot();
  expect(out.manifest.files["lib/utils.ts"]).toMatchSnapshot();
});

test("treeshake: create, merge, unchanged", async () => {
  const { cwd, installer, confirmFileOverride } = await setup(shake);
  const utils = path.join(cwd, "lib/utils.ts");
  const status = (plan: InstallPlan) => plan.files.find((file) => file.output === utils)?.status;

  let plan = await installer.install("nav-link");
  expect(status(plan)).toBe("create");
  expect(await fs.readFile(utils, "utf-8")).toMatchSnapshot();
  expect(plan.files.map((file) => path.relative(cwd, file.output)).sort()).toEqual([
    "components/nav-link.tsx",
    "lib/utils.ts",
  ]);
  expect(await plan.deps()).toMatchObject({ dependencies: [], devDependencies: [] });

  await fs.appendFile(utils, "\nexport const mine = true;\n");
  plan = await installer.install("input");
  expect(status(plan)).toBe("merge");
  expect(await fs.readFile(utils, "utf-8")).toMatchSnapshot();
  expect(await fs.readFile(path.join(cwd, "lib/format.ts"), "utf-8")).toContain("trim");
  expect(await plan.deps()).toMatchObject({
    dependencies: ["clsx@^2.0.0", "tailwind-merge@^3.0.0"],
    devDependencies: ["@types/react@^19.0.0"],
  });

  expect(status(await installer.install("input"))).toBe("unchanged");
  expect(status(await installer.install("nav-link"))).toBe("unchanged");
  expect(confirmFileOverride).not.toHaveBeenCalled();
});

test("treeshake: keep declarations of consumer", async () => {
  const { cwd, installer } = await setup(shake);
  const utils = path.join(cwd, "lib/utils.ts");
  const own = 'export const cn = (...v: string[]) => v.join(" ");\n';
  await fs.mkdir(path.dirname(utils));
  await fs.writeFile(utils, own);

  const plan = await installer.install("input");
  const content = await fs.readFile(utils, "utf-8");
  expect(content).toContain(own);
  expect(content.match(/\bcn\b/g)).toHaveLength(1);
  expect(content).toMatchSnapshot();
  expect((await plan.deps()).dependencies).toEqual([]);
});

test("treeshake: namespace import installs the whole file", async () => {
  const { cwd, installer } = await setup(shake);
  await installer.install("all");

  const source = await fs.readFile(path.join(fixtures, "shake/src/lib/utils.ts"), "utf-8");
  const lines = (await fs.readFile(path.join(cwd, "lib/utils.ts"), "utf-8")).split("\n");
  for (const line of source.split("\n")) {
    if (!line.startsWith("import ")) expect(lines).toContain(line);
  }
});

test("path alias of a file excluded by tsconfig.json", async () => {
  await expect(
    compile({
      root: {
        name: "edge",
        dir: path.join(fixtures, "edge/src"),
        components: { graph: "consumer/graph.ts" },
        files: { "**": { type: "lib" } },
      },
    }),
  ).rejects.toThrow(/"@\/types" is not a dependency of its package/);
});

test("entry without a rule", async () => {
  await expect(
    compile({ root: { ...registry, components: { theme: ["theme.ts", "../package.json"] } } }),
  ).rejects.toThrow(
    /"theme.ts" of component "theme" matches no rule in `files`[^]*"..\/package.json" of component "theme" matches no rule/,
  );
});

test("glob entries", async () => {
  const out = await compile({
    root: {
      ...shake,
      components: { all: "*.{ts,tsx}", "ui/*": { unlisted: true, entry: "*.tsx" } },
    },
  });

  expect(out.manifest.components).toEqual([
    { name: "all", files: ["all.ts", "input.tsx", "nav-link.tsx"] },
    { name: "ui/input", unlisted: true, files: ["input.tsx"] },
    { name: "ui/nav-link", unlisted: true, files: ["nav-link.tsx"] },
  ]);

  await expect(compile({ root: { ...shake, components: { icons: "icons/*" } } })).rejects.toThrow(
    /cannot find "icons\/\*" of component "icons"/,
  );
});

test("rule of a missing file", async () => {
  await expect(
    compile({ root: { ...shake, files: { ...shake.files, "renamed.tsx": { type: "ui" } } } }),
  ).rejects.toThrow(/cannot find "renamed.tsx" of `files`/);
});

test("files flattened to the same location", async () => {
  await expect(
    compile({
      root: {
        ...registry,
        components: { both: ["button.tsx", "card/button.tsx"] },
        files: { "**/button.tsx": { type: "ui" } },
      },
    }),
  ).rejects.toThrow(/button.tsx: installed to the same location as .*button.tsx, set `target`/);
});

test("reuse the UI components of consumer", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fuma-cli-"));
  await writeRegistry(await compile({ root: registry }), { dir: path.join(dir, "registry") });
  const cwd = path.join(dir, "app");
  await fs.mkdir(path.join(cwd, "components/ui"), { recursive: true });
  await fs.writeFile(path.join(cwd, "components/ui/button.tsx"), "export const Button = 'mine';");

  const installer = new ComponentInstaller(new LocalRegistryConnector(path.join(dir, "registry")), {
    cwd,
    framework: "none",
    plugins: [reuseUI({ files: { "utils/cn.ts": "lib/utils" } })],
  });
  const plan = await installer.install("card");

  expect(plan.files.map((file) => path.relative(cwd, file.output)).sort()).toEqual([
    "components/card/index.tsx",
    "components/card/parts.tsx",
  ]);
  expect(await fs.readFile(path.join(cwd, "components/card/index.tsx"), "utf-8")).toContain(
    'from "../ui/button"',
  );

  const deps = await plan.deps();
  expect(deps.required).toEqual({ "acme-ui": "^1.2.0" });
  expect(deps.dependencies).toEqual(["acme-ui@^1.2.0"]);

  await fs.rm(path.join(cwd, "components/ui/button.tsx"));
  const button = await new ComponentInstaller(
    new LocalRegistryConnector(path.join(dir, "registry")),
    { cwd, framework: "none", plugins: [reuseUI({ files: { "utils/cn.ts": "lib/utils" } })] },
  ).install("button");

  expect(button.files.map((file) => path.relative(cwd, file.output))).toEqual([
    "components/ui/button.tsx",
  ]);
  expect(await fs.readFile(path.join(cwd, "components/ui/button.tsx"), "utf-8")).toContain(
    'from "../../lib/utils"',
  );
});
