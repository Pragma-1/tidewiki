import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // No image optimizer: the app never uses next/image, so the native libvips decoder (sharp)
  // is switched off and kept out of the build instead of sitting there as attack surface.
  images: { unoptimized: true },
  outputFileTracingExcludes: { "*": ["node_modules/sharp/**", "node_modules/@img/**"] },
  // pdfmake/pdfkit/fontkit read their own data files at run time (and pdfmake runs in a worker
  // thread that requires it from node_modules): kept as packages, not bundled
  serverExternalPackages: ["better-sqlite3", "@node-rs/argon2", "pdfmake", "pdfkit", "fontkit"],
  async headers() {
    return [
      { source: "/_next/static/:path*", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] },
      // Font files carry their version in the address: cache them for good.
      {
        source: "/fonts/:font/:file",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      // The small per-font stylesheets: a day, then checked again.
      {
        source: "/fonts/:sheet",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
    ];
  },
  experimental: { serverActions: { bodySizeLimit: "100kb" } },
};

export default config;
