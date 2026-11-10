import path from "node:path";
import { LocalStorage } from "./local.js";
import type { StorageProvider } from "./types.js";

let provider: StorageProvider | null = null;

/**
 * provider 注册表。
 *
 * 加一个云存储 = 写一个实现 StorageProvider 的文件 + 在这里注册一行 + 改 .env.local。
 * **数据一行都不用动** —— 这就是「存 storage_key 不存 URL」换来的东西。
 *
 * 待办：oss / cos / r2。等真要用的时候再写，现在写就是没有依据的猜测
 * （各家 SDK、签名方式、CDN 域名回填都不一样）。
 */
function create(): StorageProvider {
  const which = process.env.STORAGE_PROVIDER ?? "local";
  switch (which) {
    case "local":
      return new LocalStorage(
        process.env.UPLOAD_DIR ?? path.resolve(process.cwd(), "../../serve/dist/uploads"),
      );
    default:
      throw new Error(
        `未知的 STORAGE_PROVIDER: ${which}（目前只实现了 local，见 services/storage/index.ts）`,
      );
  }
}

export function getStorage(): StorageProvider {
  if (!provider) provider = create();
  return provider;
}

/** 给附件行拼展示 URL —— 有 public_url 就用它，否则问 provider。 */
export function attachmentUrl(row: {
  storage_provider: string;
  storage_key: string;
  public_url: string | null;
}): string {
  return row.public_url ?? getStorage().url(row.storage_key);
}

export * from "./types.js";
