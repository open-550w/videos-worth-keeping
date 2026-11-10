import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 从**正在运行的 Chrome** 里取 bilibili 的 cookie。
 *
 * 为什么不读 Chrome 的 cookie 数据库：那些值由 macOS 钥匙串的密钥加密，
 * 直接读 SQLite 要么解不开、要么得问用户要钥匙串密码。
 * CDP 的 `Storage.getCookies` 直接返回**已经解密**的会话 cookie —— 一个来回就拿到，
 * 全程不碰账号密码（这是这份实现唯一重要的一点）。
 *
 * ⚠️ 拿到的 SESSDATA 就是**活的登录凭据**（有效期以月计）。
 * 缓存文件在 `.cache/` 下，已被 .gitignore 挡住，而且 `pnpm check-secrets` 会拿它当针。
 * **永远不要把它拷进被 git 跟踪的文件。**
 */

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
}

const CHROME_PROFILE = path.join(
  os.homedir(),
  "Library/Application Support/Google/Chrome",
);
/** Chrome 把 DevTools 端口和浏览器级 ws 路径写在这个文件里（两行）。 */
const ACTIVE_PORT_FILE = path.join(CHROME_PROFILE, "DevToolsActivePort");

/** cookie 缓存位置。gitignored —— 里面是活的登录态。 */
export function defaultCookiePath(): string {
  return process.env.BILI_COOKIE_PATH ?? path.join(process.cwd(), ".cache/bili-cookies.json");
}

/**
 * Node 22+ 才有全局 WebSocket。本仓库 engines 写的是 >=20，
 * 所以这里**显式判一下并给出能照做的错误**，而不是让用户看到 `WebSocket is not defined`。
 */
function requireWebSocket(): typeof WebSocket {
  if (typeof WebSocket === "undefined") {
    throw new Error(
      "取 B 站 cookie 需要 Node 22+（内置全局 WebSocket）。当前 Node " +
        process.version +
        " —— 换 Node 22 再跑，或先用 --cookies 指向一个已有的 cookie 文件。",
    );
  }
  return WebSocket;
}

/** 连上浏览器级 CDP，发一条命令，拿结果。 */
async function cdpCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const WS = requireWebSocket();
  let port: string;
  let wsPath: string;
  try {
    const [p, w] = (await readFile(process.env.BILI_CHROME_ACTIVE_PORT_FILE ?? ACTIVE_PORT_FILE, "utf8")).split("\n");
    port = (p ?? "").trim();
    wsPath = (w ?? "").trim();
  } catch {
    throw new Error(
      `读不到 ${ACTIVE_PORT_FILE} —— Chrome 没有开远程调试端口。\n` +
        "  完全退出 Chrome 后用带参数的启动：\n" +
        '    open -a "Google Chrome" --args --remote-debugging-port=9222',
    );
  }
  if (!port || !wsPath) throw new Error(`${ACTIVE_PORT_FILE} 内容不对（应该是两行）`);

  const ws = new WS(`ws://127.0.0.1:${port}${wsPath}`);
  try {
    await new Promise<void>((resolve, reject) => {
      // 超时要给足：Chrome 136+ 对**默认 profile** 会弹一次授权框，
      // 而弹框是卡在 WebSocket 握手阶段的 —— 用户点了「允许」这边才会 open。
      const timer = setTimeout(
        () => reject(new Error("连 Chrome 的 CDP 超时 —— 可能有个授权框在等你点「允许」")),
        60_000,
      );
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket 握手失败（多半是授权框没点）"));
      });
    });

    return await new Promise<T>((resolve, reject) => {
      const id = 1;
      const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 30_000);
      ws.addEventListener("message", (ev) => {
        let msg: { id?: number; result?: T; error?: unknown };
        try {
          msg = JSON.parse(String((ev as MessageEvent).data));
        } catch {
          return;
        }
        if (msg.id !== id) return;
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method} → ${JSON.stringify(msg.error)}`));
        else resolve(msg.result as T);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  } finally {
    ws.close();
  }
}

/** 从 Chrome 现取一遍 bilibili 的 cookie，并写进缓存文件。 */
export async function refreshCookiesFromChrome(cookiePath: string): Promise<CdpCookie[]> {
  const { cookies } = await cdpCall<{ cookies: CdpCookie[] }>("Storage.getCookies");
  const bili = cookies.filter((c) => c.domain === "bilibili.com" || c.domain.endsWith(".bilibili.com"));
  if (!bili.length) {
    throw new Error(
      "Chrome 里没有 bilibili 的 cookie —— 先在那个 Chrome 里打开 bilibili.com 登录一次。",
    );
  }
  await mkdir(path.dirname(cookiePath), { recursive: true });
  await writeFile(cookiePath, JSON.stringify(bili, null, 2), { mode: 0o600 });
  return bili;
}

/**
 * cookie 名 → 值。
 *
 * ⚠️ 同一个 cookie 名会在好几个域下各存一份（`.bilibili.com` / `www.bilibili.com` /
 * `.bilibili.tv`）。**必须挑域最宽的那个 `.bilibili.com`** —— 挑错了发出去的
 * Cookie 头就和真实浏览器标签页里的不一样，接口可能认不出来。
 * （Python 版用 `rank()` 排序后 `setdefault` 实现，这里等价。）
 */
export function cookieHeaderOf(cookies: CdpCookie[]): string {
  const rank = (domain: string) =>
    domain === ".bilibili.com" ? 0 : domain.endsWith("bilibili.com") ? 1 : 2;
  const best = new Map<string, string>();
  for (const c of [...cookies].sort((a, b) => rank(a.domain) - rank(b.domain))) {
    if (!best.has(c.name)) best.set(c.name, c.value);
  }
  return [...best.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** 读缓存文件；没有 / 读坏了返回 null（调用方决定要不要去 Chrome 现取）。 */
export async function loadCachedCookies(cookiePath: string): Promise<CdpCookie[] | null> {
  try {
    const parsed = JSON.parse(await readFile(cookiePath, "utf8"));
    return Array.isArray(parsed) && parsed.length ? (parsed as CdpCookie[]) : null;
  } catch {
    return null;
  }
}
