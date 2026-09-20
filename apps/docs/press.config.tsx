import { defineConfig } from "fumapress";
import { fumadocsMdx } from "fumapress/adapters/mdx";
import {
  blogMetaSchema,
  blogPageSchema,
  metaSchema,
  pageSchema,
} from "fumapress/adapters/mdx/schema";
import { blogPlugin } from "fumapress/plugins/blog";
import { createNotebookLayoutPage } from "fumapress/layouts/notebook";
import { defineDocs } from "fumadocs-mdx/macro";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import defaultMdxComponents, { createRelativeLink } from "fumadocs-ui/mdx";
import { SponsorsMarquee } from "@fumari/sponsors";
import { Logo } from "./src/components/logo";
import { Mermaid } from "./src/components/mermaid";

const appName = "Fuma CLI";

const docs = defineDocs({
  dir: "content/docs",
  docs: {
    async: true,
    schema: pageSchema,
    lastModified: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

const blog = defineDocs({
  dir: "content/blog",
  docs: {
    async: true,
    schema: blogPageSchema,
    lastModified: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: blogMetaSchema,
  },
});

const DocsPage = createNotebookLayoutPage<typeof config.$context>({
  render() {
    return {
      layoutProps: {
        nav: {
          mode: "top",
        },
      },
      pageProps: {
        tableOfContent: { footer: <SponsorsMarquee /> },
      },
    };
  },
});

const config = defineConfig({
  content: {
    docs: docs.toFumadocsSource(),
    blog: blog.toFumadocsSource({ baseDir: "blog" }),
  },
  site: {
    name: appName,
    baseUrl: import.meta.env.DEV ? "http://localhost:3000" : "https://cli.fuma-nama.dev",
    git: {
      user: "fuma-nama",
      repo: "fuma-cli",
      branch: "main",
    },
  },
  defaultLayoutProps: {
    nav: {
      title: (
        <>
          <Logo className="size-8 -me-1.5" />
          {appName}
        </>
      ),
    },
    links: [
      {
        text: "Blog",
        url: "/blog",
      },
      {
        text: "Sponsors",
        url: "https://fuma-nama.dev/sponsors",
        external: true,
      },
    ],
  },
  loaderOptions: {
    plugins: [lucideIconsPlugin()],
  },
  meta: {
    root() {
      return (
        <>
          <link rel="icon" href="/favicon.ico" type="image/x-icon" />
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
          <link
            href="https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=JetBrains+Mono:wght@100..800&display=swap"
            rel="stylesheet"
          />
        </>
      );
    },
  },
  renderPage: (props) => <DocsPage {...props} />,
})
  .adapters(
    fumadocsMdx({
      async getMdxComponents(page) {
        const source = await this.getLoader();

        return {
          ...defaultMdxComponents,
          Mermaid,
          // this allows you to link to other pages with relative file paths
          a: createRelativeLink(source, page),
        };
      },
    }),
  )
  .plugins(
    blogPlugin({
      authors: {
        fuma: {
          name: "Fuma Nama",
          title: "Maintainer",
          url: "https://fuma-nama.dev",
          image: "/authors/fuma.jpg",
        },
      },
    }),
  );

export default config;
