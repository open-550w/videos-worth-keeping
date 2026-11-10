import { Image } from "antd";
import { MUTED } from "../lib/theme";

/**
 * 封面图。**所有显示封面 / 头像的地方都该用它，不要直接写 `<img>`。**
 *
 * ⚠️ 这个组件存在的唯一理由：`referrerPolicy="no-referrer"`。
 *
 * B 站的图床（`i0.hdslb.com` 等）**按 Referer 防盗链**，实测：
 *
 *   | 请求的 Referer            | 结果 |
 *   | ---                       | ---  |
 *   | 不带 Referer              | 200  |
 *   | `https://www.bilibili.com/` | 200 |
 *   | `http://localhost:5191/`（我们自己的页面） | **403** |
 *
 * 也就是说：在站内页面上直接 `<img src="https://i2.hdslb.com/...">`，
 * 浏览器会自动带上本站的 Referer，**图必然加载不出来**，而且失败得很安静
 * （就是个灰块，控制台里只有一条 net::ERR 或 403，很容易被当成「这个视频没封面」）。
 * 加 `no-referrer` 之后请求不带 Referer，图就正常了。
 *
 * 顺带把「没有封面时的占位」也收在这里 —— 塌掉的话每张卡高度都不一样。
 */
export function Cover({
  src,
  width,
  height,
  radius = 6,
  fill,
}: {
  src: string | null;
  /** `fill` 时不传 —— 尺寸由外层容器（比如 aspect-ratio 的卡片封面区）决定 */
  width?: number | string;
  height?: number | string;
  radius?: number;
  /** 撑满父容器。用于卡片网格：外层给 `aspect-ratio`，这里只管填满 */
  fill?: boolean;
}) {
  const box: React.CSSProperties = fill
    ? { width: "100%", height: "100%", borderRadius: radius }
    : { width, height, borderRadius: radius };

  if (!src) {
    return (
      <div
        style={{
          ...box,
          background: "#f1f2f4",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: MUTED,
          fontSize: 11,
        }}
      >
        无封面
      </div>
    );
  }
  return (
    <Image
      src={src}
      alt=""
      width={fill ? "100%" : width}
      height={fill ? "100%" : height}
      style={{ ...box, objectFit: "cover", display: "block" }}
      preview={false}
      referrerPolicy="no-referrer"
      fallback="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='96' height='128'%3E%3Crect width='96' height='128' fill='%23f1f2f4'/%3E%3C/svg%3E"
    />
  );
}
