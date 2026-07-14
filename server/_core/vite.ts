import express, { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer, type UserConfig } from "vite";
import viteConfig from "../../vite.config";

function resolveViteConfig(): UserConfig {
  if (typeof viteConfig === "function") {
    return viteConfig({ command: "serve", mode: "development" }) as UserConfig;
  }
  return viteConfig as UserConfig;
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...resolveViteConfig(),
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.get("/__frontmind__/version.json", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path.resolve(distPath, "__frontmind__", "version.json"));
  });

  // Serve hashed static assets with long-term caching.
  // Vite outputs JS/CSS with content hashes in filenames (e.g. index-abc123.js),
  // so they can be cached aggressively. When the content changes, the filename
  // changes, and the browser fetches the new file automatically.
  app.use(
    "/assets",
    express.static(path.resolve(distPath, "assets"), {
      maxAge: "1y",
      immutable: true,
    })
  );

  // Serve other static files (images, fonts, etc.) with moderate caching
  app.use(
    express.static(distPath, {
      maxAge: "1h",
      // Exclude index.html from static serving - we handle it separately below
      index: false,
    })
  );

  // Serve index.html with no-cache headers so the browser always revalidates.
  // This ensures that after a server-side deployment, users get the new HTML
  // which references the new hashed asset filenames — no manual cache clearing needed.
  app.use("*", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
