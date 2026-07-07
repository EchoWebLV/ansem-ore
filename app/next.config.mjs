/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @ansem/sdk ships TS/ESM; let Next transpile the workspace package.
  transpilePackages: ["@ansem/sdk"],
};
export default nextConfig;
