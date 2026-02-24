/* ========================================= */
/* Streamable HTTP MCP Proxy (Snippets 版)  */
/* ========================================= */

/**
 * mcpserver 配置：
 * {
 *   path: string,
 *   header: Array<Record<string, string | (() => string)>>,
 *   url: URL,
 *   key?: string
 * }[]
 */
const MCP_SERVERS = [
  {
    path: "/deepwiki",
    header: [
      {
        "x-mcp-proxy": "cf-snippet"
      }
    ],
    url: new URL("https://mcp.deepwiki.com/mcp")
    // key: "replace_me"
  }
];

const NO_STORE_CACHE_CONTROL = "no-store, max-age=0";

const ROUTES = MCP_SERVERS
  .map(normalizeServer)
  .sort((a, b) => b.path.length - a.path.length);

export default {
  async fetch(request) {
    try {
      const reqUrl = new URL(request.url);
      const matched = matchServerByPath(reqUrl.pathname);

      if (!matched) {
        return new Response("MCP route not found", {
          status: 404,
          headers: {
            "Cache-Control": NO_STORE_CACHE_CONTROL,
            "Content-Type": "text/plain; charset=utf-8"
          }
        });
      }

      const upstreamUrl = buildUpstreamUrl(matched.server.url, matched.restPath, reqUrl.search);

      let headers;
      try {
        headers = buildUpstreamHeaders(request.headers, matched.server);
      } catch (err) {
        if (String(err?.message || "") === "MCP key verification failed") {
          return new Response("Unauthorized", {
            status: 401,
            headers: {
              "Cache-Control": NO_STORE_CACHE_CONTROL,
              "Content-Type": "text/plain; charset=utf-8"
            }
          });
        }

        throw err;
      }

      const init = {
        method: request.method,
        headers,
        redirect: "manual"
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        init.body = request.body;
      }

      const upstreamResponse = await fetch(upstreamUrl.toString(), init);
      return buildProxyResponse(upstreamResponse);

    } catch (err) {
      return new Response(
        "Snippet crash:\n" + (err?.stack || err),
        {
          status: 500,
          headers: {
            "Cache-Control": NO_STORE_CACHE_CONTROL,
            "Content-Type": "text/plain; charset=utf-8"
          }
        }
      );
    }
  }
};

function normalizeServer(server) {
  if (!server || !server.path || !server.url) {
    throw new Error("Invalid MCP server config: path/url is required");
  }

  const path = normalizeRoutePath(server.path);
  const url = server.url instanceof URL
    ? new URL(server.url.toString())
    : new URL(String(server.url));

  const header = Array.isArray(server.header)
    ? server.header
    : (server.header ? [server.header] : []);

  return {
    path,
    header,
    url,
    key: server.key || ""
  };
}

function normalizeRoutePath(path) {
  let p = String(path || "").trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function matchServerByPath(pathname) {
  for (const server of ROUTES) {
    if (pathname === server.path) {
      return { server, restPath: "/" };
    }

    if (server.path !== "/" && pathname.startsWith(`${server.path}/`)) {
      return {
        server,
        restPath: pathname.slice(server.path.length) || "/"
      };
    }
  }

  return null;
}

function buildUpstreamUrl(baseUrl, restPath, search) {
  const upstream = new URL(baseUrl.toString());
  upstream.pathname = joinPath(upstream.pathname, restPath);
  upstream.search = search;
  return upstream;
}

function joinPath(basePath, appendPath) {
  const left = String(basePath || "").split("/").filter(Boolean);
  const right = String(appendPath || "").split("/").filter(Boolean);
  const merged = [...left, ...right];
  return merged.length ? `/${merged.join("/")}` : "/";
}

function buildUpstreamHeaders(requestHeaders, server) {
  const headers = new Headers(requestHeaders);

  // 交给 fetch 自动设置
  headers.delete("host");
  headers.delete("content-length");

  for (const headerMap of server.header) {
    if (!headerMap || typeof headerMap !== "object") continue;

    for (const [name, rawValue] of Object.entries(headerMap)) {
      const value = resolveHeaderValue(rawValue);
      if (value === "") {
        headers.delete(name);
      } else {
        headers.set(name, value);
      }
    }
  }

  if (server.key) {
    const incomingKey = requestHeaders.get("x-mcp-key") || requestHeaders.get("x-api-key") || "";

    if (incomingKey !== server.key) {
      throw new Error("MCP key verification failed");
    }

    // 验证通过后对上游透传标准头
    headers.set("x-api-key", server.key);
    headers.set("x-mcp-key", server.key);
  }

  return headers;
}

function resolveHeaderValue(rawValue) {
  if (typeof rawValue === "function") {
    return String(rawValue() ?? "");
  }

  if (rawValue == null) return "";
  return String(rawValue);
}

function buildProxyResponse(upstreamResponse) {
  const headers = new Headers(upstreamResponse.headers);
  headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers
  });
}
