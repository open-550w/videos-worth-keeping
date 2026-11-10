import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isValidStorageKey, type StorageProvider } from "./types.js";

/**
 * 本机磁盘 provider —— 默认实现。
 *
 * 落点是 `.env.local` 的 `UPLOAD_DIR`（默认 `serve/dist/uploads`，已被 gitignore 覆盖）。
 * 选这个位置是为了跟参考项目一致：产物与运行数据落 `<仓库>/serve/dist/` 下，
 * 不往 `~/.local/share/` 散。
 */
export class LocalStorage implements StorageProvider {
  readonly name = "local";
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** key → 绝对路径。**每次都要过一遍校验**，包括读路径。 */
  private resolve(key: string): string {
    if (!isValidStorageKey(key)) {
      throw new Error(`非法的 storage_key: ${key}`);
    }
    const abs = path.resolve(this.root, key);
    // 双保险：即使 isValidStorageKey 有疏漏，也不允许跑出根目录
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(`storage_key 越出根目录: ${key}`);
    }
    return abs;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const abs = this.resolve(key);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.resolve(key), { force: true });
    } catch {
      // 不存在不算错 —— 删除是幂等的
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 本机存储没有 CDN，走后端的静态路由。
   * 换成 OSS 之后这里会返回 CDN 地址 —— **调用方不用改**。
   */
  url(key: string): string {
    return `/uploads/${key}`;
  }
}
