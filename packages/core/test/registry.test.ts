import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { expect, test } from "vitest";
import { compile, writeRegistry, type Registry } from "@/compiler";
import { LocalRegistryConnector } from "@/registry/connector";
import { ComponentInstaller } from "@/registry/installer";

const fixtures = path.join(import.meta.dirname, "fixtures/registry");
const registry: Registry = {
  name: "ui",
  dir: path.join(fixtures, "ui/src"),
  subRegistries: [{ name: "extra", dir: path.join(fixtures, "extra/src") }],
};

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fuma-cli-"));
  await writeRegistry(await compile({ root: registry }), { dir: path.join(dir, "registry") });

  const cwd = path.join(dir, "app");
  await fs.mkdir(cwd);
  const installer = new ComponentInstaller(new LocalRegistryConnector(path.join(dir, "registry")), {
    cwd,
    framework: "none",
  });
  return { cwd, installer };
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
      root: {
        name: "ui",
        dir: path.join(fixtures, "ui/src"),
        files: { "card/bad.ts": { type: "lib" } },
      },
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
