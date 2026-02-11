import path from "node:path"
import { fileURLToPath } from "node:url"

import type { NextConfig } from "next"

const projectRoot = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.join(projectRoot, "../..")

const nextConfig: NextConfig = {
  outputFileTracingRoot: workspaceRoot,
}

export default nextConfig
