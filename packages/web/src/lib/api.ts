/**
 * 后端统一包 { code, message, data }。
 *
 * 失败时抛 `ApiError` —— **保留 code 和 data**，因为有些错误带的是**可操作的信息**：
 * 比如重复收藏时 `data.existingItemId` 是已有条目的 id，前端要拿它做跳转。
 * 只抛一个 message 的话，用户看到「已经收藏过了」却不知道该去哪。
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: number,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 后端带回的机器可读信息，形状由调用方断言。 */
  detail<T>(): T | null {
    return (this.data as T) ?? null;
  }
}

/**
 * 请求超时。
 *
 * 为什么要设：数据库在远程，实测 RTT ~160ms 起步、**丢包时能拖到几十秒**
 * （见 docs/init/03_TECH_STACK.md §1.3）。没有超时的话，一次网络抖动会让
 * 页面无限转圈 —— 用户看到的是「卡住了」，而不是「这次失败了，重试一下」。
 *
 * 45 秒是个折中：正常的慢查询（~2s）绝不会撞上，而真正的挂起能在一个
 * 人还能忍受的时间内变成一条可重试的错误。
 */
const TIMEOUT_MS = 45_000;

export async function apiFetch<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", signal: controller.signal, ...init });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new ApiError(
        0,
        `请求超过 ${TIMEOUT_MS / 1000} 秒没响应 —— 数据库那台机器可能网络不好，重试一下`,
        0,
        null,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);
  if (res.ok && body?.code === 0) return body.data as T;

  throw new ApiError(
    res.status,
    body?.message ?? `HTTP ${res.status}`,
    body?.code ?? res.status,
    body?.data ?? null,
  );
}

/** 带 JSON body 的便捷封装。 */
export function apiJson<T = unknown>(
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  payload?: unknown,
): Promise<T> {
  return apiFetch<T>(path, {
    method,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

/** 上传文件（FormData）。不要手动设 Content-Type —— 浏览器要自己带 boundary。 */
export function apiUpload<T = unknown>(path: string, form: FormData): Promise<T> {
  return apiFetch<T>(path, { method: "POST", body: form });
}

/** 拼 query string，跳过 undefined / null / 空串。 */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
