/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @ansem/sdk ships TS/ESM; let Next transpile the workspace package.
  transpilePackages: ["@ansem/sdk"],
  webpack: (config) => {
    // Our TS source uses explicit ".js" specifiers on relative imports (matching
    // the SDK/keeper ESM convention). tsc + vitest resolve these to ".ts"/".tsx";
    // teach webpack the same so `import "./Board.js"` finds Board.tsx.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".js", ".ts", ".tsx"],
      ".mjs": [".mjs", ".mts"],
    };
    return config;
  },
};
export default nextConfig;
