import path from 'node:path';

/** @type {import('next').NextConfig} */
export default {
  // Share the collector's pure TypeScript (report, footprint math, profile) instead of duplicating it.
  experimental: { externalDir: true },
  outputFileTracingRoot: path.join(process.cwd(), '..'),
  webpack(config, { isServer }) {
    // The collector uses Node-ESM style imports ('./x.js' for x.ts). Map them for the bundler.
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'], '.mjs': ['.mts', '.mjs'] };
    // node:sqlite is Node's built-in; never bundle it.
    if (isServer) config.externals = [...(config.externals ?? []), { 'node:sqlite': 'commonjs node:sqlite' }];
    return config;
  },
};
