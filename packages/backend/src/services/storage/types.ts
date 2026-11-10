/**
 * 存储抽象 —— M2 的**唯一重要设计**。
 *
 * 数据库里存的是 `storage_key`（对象键），**不是 URL**。
 * 只存 URL 的话，从本机磁盘换到 OSS / COS / R2 + CDN 时得**改写所有历史行**；
 * 只存 key 的话，展示时由这里拼 URL，**换存储是改一个配置项**。
 *
 * 换 provider 要做的事：写一个实现这个接口的文件 + 在 index.ts 注册一行。
 * 数据一行都不用动。
 */
export interface StorageProvider {
  readonly name: string;
  /** 写入。key 由调用方生成（见 storageKeyFor）。 */
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  /** 读取。不存在返回 null。 */
  get(key: string): Promise<Buffer | null>;
  /** 删除。不存在不算错（幂等）。 */
  delete(key: string): Promise<void>;
  /** 这个 key 的对外 URL（给前端 <img src> 用）。 */
  url(key: string): string;
  exists(key: string): Promise<boolean>;
}

/**
 * 生成对象键：`items/<itemId>/<sha256>.<ext>`
 *
 * 用内容哈希做文件名有两个好处：
 *   ① 同一个文件重复上传自然落到同一个 key，不占两份空间；
 *   ② 文件名不可猜测（哈希），但**真正的访问控制不该依赖这一点** —— 见下面。
 *
 * ⚠️ **绝不能把用户提供的文件名拼进 key。** 那是一条路径穿越漏洞
 *    （`../../etc/passwd`）。原始文件名单独存在 `attachments.original_name` 里，
 *    只用于展示和下载时的 Content-Disposition。
 */
export function storageKeyFor(itemId: number, sha256: string, ext: string): string {
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return `items/${itemId}/${sha256}${safeExt ? `.${safeExt}` : ""}`;
}

/**
 * 校验一个 key 是不是我们自己生成的形状。
 *
 * 这是**读路径上的关键防线**：`GET /uploads/:key` 的 key 来自 URL，
 * 不校验的话 `../../../packages/backend/.env.local` 就能把数据库密码读走。
 * 只在写入时校验是不够的 —— 攻击者不会走写入。
 */
export function isValidStorageKey(key: string): boolean {
  if (!key || key.length > 512) return false;
  if (key.includes("..") || key.startsWith("/") || key.includes("//")) return false;
  if (key.includes("\\") || key.includes("\0")) return false;
  // 只允许我们生成的形状：items/<数字>/<64位hex>[.ext]
  return /^items\/\d+\/[0-9a-f]{64}(\.[a-z0-9]{1,8})?$/.test(key);
}
