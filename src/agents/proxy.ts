/** Proxy availability is determined by the deployment environment. */
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

export function proxyAvailable(environment: NodeJS.ProcessEnv = process.env): boolean {
  return PROXY_KEYS.some((key) => Boolean(environment[key]?.trim()));
}

/** Undefined preserves the inherited environment for groups created before this setting existed. */
export function proxyEnvironment(useProxy?: boolean, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = { ...environment };
  if (useProxy === false) {
    for (const key of [...PROXY_KEYS, "NO_PROXY", "no_proxy"]) delete child[key];
  }
  return child;
}
