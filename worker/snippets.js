/* ============================= */
/* ===== 🔐 硬编码配置 ========= */
/* ============================= */

const B2_BUCKET_CONFIGS = [
  {
    B2_APPLICATION_KEY_ID: "",
    B2_APPLICATION_KEY: "",
    B2_ENDPOINT: "s3.us-east-005.backblazeb2.com",
    BUCKET_NAME: "",
    REGION: "us-east-005"
  }
];

const encoder = new TextEncoder();

/* ============================= */
/* ===== 缓存与防刷配置 ========= */
/* ============================= */

// 回源文件缓存（Cloudflare Edge，一年）
const EDGE_CACHE_TTL_SECONDS = 31536000;
// 浏览器侧缓存（一年）
const BROWSER_CACHE_TTL_SECONDS = 31536000;
// 文件列表缓存（Snippets 下使用内存缓存，非持久）
const FILE_LIST_CACHE_TTL_SECONDS = 30;

// 404 缓存（用于白名单过滤后无匹配、对象不存在等场景）
const NOT_FOUND_EDGE_CACHE_TTL_SECONDS = 60;
const NOT_FOUND_BROWSER_CACHE_TTL_SECONDS = 15;

// 基础防刷（按 IP 窗口计数）
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_PER_WINDOW = 120;
const RATE_LIMIT_RANDOM_MAX_PER_WINDOW = 20;
const RATE_LIMIT_MAX_TRACKED_IPS = 5000;

// 查询参数透传控制
const STRIP_QUERY_PARAMS_ON_PROXY = false;
const REMOVE_QUERY_PARAMS_ON_RANDOM_REDIRECT = true;

// 文件类型白名单（留空数组表示不过滤）
const FILE_TYPE_WHITELIST = [
  ".jpg", ".jpeg", ".png", ".webp", ".gif",
  ".mp4", ".webm", ".mp3", ".flac"
];
const NORMALIZED_FILE_TYPE_WHITELIST = new Set(
  FILE_TYPE_WHITELIST.map(normalizeExtension).filter(Boolean)
);

// 防止异常分页导致无限循环
const MAX_B2_LIST_PAGES = 1000;

const NO_STORE_CACHE_CONTROL = "no-store, max-age=0";

// =============================================
// AWS V4 Client
// =============================================

class AwsClient {
  constructor({ accessKeyId, secretAccessKey, service, region }) {
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.service = service;
    this.region = region;
  }

  async sign(url, method = "GET") {
    const signer = new AwsV4Signer({
      url,
      method,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      service: this.service,
      region: this.region
    });

    return await signer.sign();
  }
}

class AwsV4Signer {
  constructor({ url, method, accessKeyId, secretAccessKey, service, region }) {
    this.url = new URL(url);
    this.method = method;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.service = service;
    this.region = region;

    this.datetime = new Date()
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "");
    this.date = this.datetime.slice(0, 8);

    this.headers = new Headers();
    this.headers.set("host", this.url.host);
    this.headers.set("x-amz-date", this.datetime);
    this.headers.set("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
  }

  async sign() {
    const canonicalRequest = await this.createCanonicalRequest();
    const stringToSign = await this.createStringToSign(canonicalRequest);
    const signingKey = await this.getSigningKey();
    const signature = await this.hmacHex(signingKey, stringToSign);

    const credentialScope = `${this.date}/${this.region}/${this.service}/aws4_request`;

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=host;x-amz-content-sha256;x-amz-date, ` +
      `Signature=${signature}`;

    this.headers.set("Authorization", authorization);

    return new Request(this.url.toString(), {
      method: this.method,
      headers: this.headers
    });
  }

  async createCanonicalRequest() {
    const pathname = this.url.pathname || "/";

    // 必须排序 query 参数（S3 要求）
    const sortedParams = [...this.url.searchParams.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const canonicalHeaders =
      `host:${this.url.host}\n` +
      `x-amz-content-sha256:UNSIGNED-PAYLOAD\n` +
      `x-amz-date:${this.datetime}\n`;

    return [
      this.method,
      pathname,
      sortedParams,
      canonicalHeaders,
      "host;x-amz-content-sha256;x-amz-date",
      "UNSIGNED-PAYLOAD"
    ].join("\n");
  }

  async createStringToSign(canonicalRequest) {
    const credentialScope = `${this.date}/${this.region}/${this.service}/aws4_request`;

    return [
      "AWS4-HMAC-SHA256",
      this.datetime,
      credentialScope,
      await this.sha256Hex(canonicalRequest)
    ].join("\n");
  }

  async getSigningKey() {
    const kDate = await this.hmac(
      encoder.encode("AWS4" + this.secretAccessKey),
      this.date
    );
    const kRegion = await this.hmac(kDate, this.region);
    const kService = await this.hmac(kRegion, this.service);
    return await this.hmac(kService, "aws4_request");
  }

  async sha256Hex(message) {
    const hash = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(message)
    );
    return [...new Uint8Array(hash)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async hmac(key, message) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    return await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      typeof message === "string" ? encoder.encode(message) : message
    );
  }

  async hmacHex(key, message) {
    const sig = await this.hmac(key, message);
    return [...new Uint8Array(sig)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

// =============================================
// Snippet 主逻辑
// =============================================

const bucketConfigMap = buildBucketConfigMap();
const rateLimitBuckets = new Map();
const fileListMemoryCacheMap = new Map();

export default {
  async fetch(request) {
    try {
      const url = new URL(request.url);

      if (request.method !== "GET") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: {
            "Allow": "GET",
            "Cache-Control": NO_STORE_CACHE_CONTROL
          }
        });
      }

      const route = parseBucketRoute(url.pathname);
      const limited = applyRateLimit(
        request,
        route.kind === "random" || route.kind === "global-random"
      );
      if (limited) return limited;

      if (route.kind === "global-random") {
        const bucketConfig = pickRandomBucketConfig();
        if (!bucketConfig) {
          return new Response("No bucket configured", {
            status: 404,
            headers: {
              "Cache-Control": `public, max-age=${NOT_FOUND_BROWSER_CACHE_TTL_SECONDS}, stale-while-revalidate=30`,
              "CDN-Cache-Control": `public, s-maxage=${NOT_FOUND_EDGE_CACHE_TTL_SECONDS}, stale-while-revalidate=30`
            }
          });
        }

        const preferredPrefix = getPreferredPrefix(url);
        const file = await getRandomFile(bucketConfig, preferredPrefix);

        if (!file) {
          return new Response("No file found", {
            status: 404,
            headers: {
              "Cache-Control": `public, max-age=${NOT_FOUND_BROWSER_CACHE_TTL_SECONDS}, stale-while-revalidate=30`,
              "CDN-Cache-Control": `public, s-maxage=${NOT_FOUND_EDGE_CACHE_TTL_SECONDS}, stale-while-revalidate=30`
            }
          });
        }

        // Cloudflare 需要绝对 URL
        const redirectUrl = buildRandomRedirectUrl(request.url, bucketConfig.BUCKET_NAME, file);
        return new Response(null, {
          status: 302,
          headers: {
            "Location": redirectUrl,
            "Cache-Control": NO_STORE_CACHE_CONTROL
          }
        });
      }

      if (route.kind === "root") {
        return createRootRouteResponse();
      }

      if (route.kind === "unknown-bucket") {
        return new Response("Bucket Not Found", {
          status: 404,
          headers: {
            "Cache-Control": `public, max-age=${NOT_FOUND_BROWSER_CACHE_TTL_SECONDS}, stale-while-revalidate=30`,
            "CDN-Cache-Control": `public, s-maxage=${NOT_FOUND_EDGE_CACHE_TTL_SECONDS}, stale-while-revalidate=30`
          }
        });
      }

      const bucketConfig = route.bucketConfig;

      // 随机文件接口：/{BUCKET_NAME}/random
      if (route.kind === "random") {
        const preferredPrefix = getPreferredPrefix(url);
        const file = await getRandomFile(bucketConfig, preferredPrefix);

        if (!file) {
          return new Response("No file found", {
            status: 404,
            headers: {
              "Cache-Control": `public, max-age=${NOT_FOUND_BROWSER_CACHE_TTL_SECONDS}, stale-while-revalidate=30`,
              "CDN-Cache-Control": `public, s-maxage=${NOT_FOUND_EDGE_CACHE_TTL_SECONDS}, stale-while-revalidate=30`
            }
          });
        }

        // Cloudflare 需要绝对 URL
        const redirectUrl = buildRandomRedirectUrl(request.url, bucketConfig.BUCKET_NAME, file);
        return new Response(null, {
          status: 302,
          headers: {
            "Location": redirectUrl,
            "Cache-Control": NO_STORE_CACHE_CONTROL
          }
        });
      }

      // 代理文件：/{BUCKET_NAME}[/path/to/file]
      const originPath = route.objectPath === "/"
        ? `/${bucketConfig.BUCKET_NAME}/`
        : `/${bucketConfig.BUCKET_NAME}${route.objectPath}`;

      const queryString = STRIP_QUERY_PARAMS_ON_PROXY ? "" : url.search;
      const originUrl = `https://${bucketConfig.B2_ENDPOINT}${originPath}${queryString}`;

      const signedRequest = await bucketConfig.client.sign(originUrl, "GET");
      const originResponse = await fetch(signedRequest, {
        cf: {
          cacheEverything: true,
          cacheTtlByStatus: {
            "200-299": EDGE_CACHE_TTL_SECONDS,
            "404": Math.min(EDGE_CACHE_TTL_SECONDS, 60),
            "500-599": 0
          }
        }
      });

      return withProxyCacheHeaders(originResponse);

    } catch (err) {
      return new Response(
        "Snippet crash:\n" + (err?.stack || err),
        {
          status: 500,
          headers: { "Cache-Control": NO_STORE_CACHE_CONTROL }
        }
      );
    }
  }
};

function buildBucketConfigMap() {
  const map = new Map();

  for (const rawConfig of B2_BUCKET_CONFIGS) {
    const config = normalizeBucketConfig(rawConfig);
    if (!config) continue;

    if (map.has(config.BUCKET_NAME)) {
      throw new Error(`Duplicated BUCKET_NAME: ${config.BUCKET_NAME}`);
    }

    map.set(config.BUCKET_NAME, {
      ...config,
      client: new AwsClient({
        accessKeyId: config.B2_APPLICATION_KEY_ID,
        secretAccessKey: config.B2_APPLICATION_KEY,
        service: "s3",
        region: config.REGION
      })
    });
  }

  return map;
}

function normalizeBucketConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== "object") return null;

  const config = {
    B2_APPLICATION_KEY_ID: String(rawConfig.B2_APPLICATION_KEY_ID || "").trim(),
    B2_APPLICATION_KEY: String(rawConfig.B2_APPLICATION_KEY || "").trim(),
    B2_ENDPOINT: String(rawConfig.B2_ENDPOINT || "").trim(),
    BUCKET_NAME: String(rawConfig.BUCKET_NAME || "").trim(),
    REGION: String(rawConfig.REGION || "").trim()
  };

  const fields = Object.values(config);
  const allEmpty = fields.every(v => !v);
  if (allEmpty) return null;

  const hasMissingField = fields.some(v => !v);
  if (hasMissingField) {
    throw new Error(`Invalid bucket config: ${JSON.stringify(config)}`);
  }

  return config;
}

function parseBucketRoute(pathname) {
  const normalizedPath = String(pathname || "");
  if (normalizedPath === "/random") {
    return { kind: "global-random" };
  }

  const match = normalizedPath.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) {
    return { kind: "root" };
  }

  const bucketName = decodeURIComponent(match[1]);
  const bucketConfig = bucketConfigMap.get(bucketName);
  if (!bucketConfig) {
    return { kind: "unknown-bucket", bucketName };
  }

  const objectPath = match[2] || "/";
  if (objectPath === "/random") {
    return { kind: "random", bucketConfig };
  }

  return {
    kind: "proxy",
    bucketConfig,
    objectPath
  };
}

function createRootRouteResponse() {
  return new Response("Bucket path required", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": NO_STORE_CACHE_CONTROL
    }
  });
}

function pickRandomBucketConfig() {
  const buckets = [...bucketConfigMap.values()];
  if (buckets.length === 0) return null;
  return buckets[Math.floor(Math.random() * buckets.length)];
}

function applyRateLimit(request, isRandomPath) {
  const now = Date.now();
  cleanupRateLimitBuckets(now);

  const ip = getClientIp(request);
  const windowId = Math.floor(now / (RATE_LIMIT_WINDOW_SECONDS * 1000));

  let bucket = rateLimitBuckets.get(ip);
  if (!bucket || bucket.windowId !== windowId) {
    bucket = {
      windowId,
      total: 0,
      random: 0,
      touchedAt: now
    };
  }

  bucket.total += 1;
  if (isRandomPath) bucket.random += 1;
  bucket.touchedAt = now;

  // 刷新 Map 迭代顺序，便于后续淘汰最旧键
  if (rateLimitBuckets.has(ip)) rateLimitBuckets.delete(ip);
  rateLimitBuckets.set(ip, bucket);

  if (
    bucket.total > RATE_LIMIT_MAX_PER_WINDOW ||
    bucket.random > RATE_LIMIT_RANDOM_MAX_PER_WINDOW
  ) {
    return new Response("Too Many Requests", {
      status: 429,
      headers: {
        "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
        "Cache-Control": NO_STORE_CACHE_CONTROL
      }
    });
  }

  return null;
}

function cleanupRateLimitBuckets(now) {
  const staleBefore = now - RATE_LIMIT_WINDOW_SECONDS * 1000 * 2;

  for (const [ip, bucket] of rateLimitBuckets) {
    if (bucket.touchedAt < staleBefore) {
      rateLimitBuckets.delete(ip);
    }
  }

  while (rateLimitBuckets.size > RATE_LIMIT_MAX_TRACKED_IPS) {
    const oldest = rateLimitBuckets.keys().next().value;
    if (!oldest) break;
    rateLimitBuckets.delete(oldest);
  }
}

function getClientIp(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;

  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();

  return "unknown";
}

function withProxyCacheHeaders(response) {
  const headers = new Headers(response.headers);

  if (response.status >= 200 && response.status < 300) {
    headers.set(
      "Cache-Control",
      `public, max-age=${BROWSER_CACHE_TTL_SECONDS}, stale-while-revalidate=30`
    );
    headers.set(
      "CDN-Cache-Control",
      `public, s-maxage=${EDGE_CACHE_TTL_SECONDS}, stale-while-revalidate=30`
    );
  } else if (response.status === 404) {
    headers.set(
      "Cache-Control",
      `public, max-age=${NOT_FOUND_BROWSER_CACHE_TTL_SECONDS}, stale-while-revalidate=30`
    );
    headers.set(
      "CDN-Cache-Control",
      `public, s-maxage=${NOT_FOUND_EDGE_CACHE_TTL_SECONDS}, stale-while-revalidate=30`
    );
  } else {
    headers.set("Cache-Control", NO_STORE_CACHE_CONTROL);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function getPreferredPrefix(url) {
  const raw = (url.searchParams.get("prefix") || "").trim();
  if (!raw) return "";

  // 统一为相对 key 前缀，不允许以 / 开头
  return raw.replace(/^\/+/, "");
}

function buildRandomRedirectUrl(requestUrl, bucketName, file) {
  const redirectUrl = new URL(`/${bucketName}/${file}`, requestUrl);

  if (REMOVE_QUERY_PARAMS_ON_RANDOM_REDIRECT) {
    redirectUrl.search = "";
  }

  return redirectUrl.toString();
}

// =============================================
// 获取随机文件（Snippets 版按桶内存缓存 + 全桶分页拉取）
// =============================================

async function getRandomFile(bucketConfig, preferredPrefix = "") {
  const files = await getCachedFileList(bucketConfig);
  if (files.length === 0) return null;

  const filtered = preferredPrefix
    ? files.filter(k => k.startsWith(preferredPrefix))
    : files;

  if (filtered.length === 0) return null;

  return filtered[Math.floor(Math.random() * filtered.length)];
}

function getOrCreateFileListMemoryCache(bucketName) {
  let cache = fileListMemoryCacheMap.get(bucketName);
  if (!cache) {
    cache = {
      files: null,
      expiresAt: 0,
      refreshingPromise: null
    };
    fileListMemoryCacheMap.set(bucketName, cache);
  }
  return cache;
}

async function getCachedFileList(bucketConfig) {
  const bucketCache = getOrCreateFileListMemoryCache(bucketConfig.BUCKET_NAME);
  const now = Date.now();

  if (bucketCache.files && now < bucketCache.expiresAt) {
    return bucketCache.files;
  }

  if (bucketCache.refreshingPromise) {
    return bucketCache.refreshingPromise;
  }

  bucketCache.refreshingPromise = (async () => {
    const files = await fetchFileListFromB2(bucketConfig);
    bucketCache.files = files;
    bucketCache.expiresAt = Date.now() + FILE_LIST_CACHE_TTL_SECONDS * 1000;
    return files;
  })();

  try {
    return bucketCache.refreshingPromise;
  } finally {
    bucketCache.refreshingPromise = null;
  }
}

async function fetchFileListFromB2(bucketConfig) {
  const allFiles = [];
  let continuationToken = "";
  let page = 0;

  while (true) {
    page += 1;
    if (page > MAX_B2_LIST_PAGES) {
      throw new Error("B2 list exceeded MAX_B2_LIST_PAGES");
    }

    const listUrl = new URL(`https://${bucketConfig.B2_ENDPOINT}/${bucketConfig.BUCKET_NAME}`);
    listUrl.searchParams.set("list-type", "2");
    if (continuationToken) {
      listUrl.searchParams.set("continuation-token", continuationToken);
    }

    const signed = await bucketConfig.client.sign(listUrl.toString(), "GET");
    const response = await fetch(signed);

    if (!response.ok) {
      throw new Error("B2 list failed: " + response.status);
    }

    const xml = await response.text();

    const files = [...xml.matchAll(/<Key>(.*?)<\/Key>/g)]
      .map(m => m[1])
      .filter(k => !k.endsWith("/"));
    allFiles.push(...files);

    const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    if (!isTruncated) break;

    const tokenMatch = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/);
    if (!tokenMatch || !tokenMatch[1]) {
      throw new Error("B2 list truncated but no continuation token");
    }

    continuationToken = tokenMatch[1];
  }

  if (allFiles.length === 0) return [];

  // 过滤掉任意路径段以 . 开头的隐藏文件（如 .openlist）
  const cleanFiles = allFiles.filter(k =>
    !k.split("/").some(part => part.startsWith("."))
  );

  if (NORMALIZED_FILE_TYPE_WHITELIST.size === 0) {
    return cleanFiles;
  }

  return cleanFiles.filter(isAllowedByWhitelist);
}

function isAllowedByWhitelist(key) {
  const ext = getExtensionFromKey(key);
  if (!ext) return false;
  return NORMALIZED_FILE_TYPE_WHITELIST.has(ext);
}

function getExtensionFromKey(key) {
  const lastSegment = key.split("/").pop() || "";
  const dotIndex = lastSegment.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === lastSegment.length - 1) return "";
  return normalizeExtension(lastSegment.slice(dotIndex));
}

function normalizeExtension(ext) {
  const normalized = (ext || "").trim().toLowerCase();
  if (!normalized) return "";
  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}
