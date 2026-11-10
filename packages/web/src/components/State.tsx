import { Button, Empty, Skeleton } from "antd";
import { Link } from "react-router";
import { AlertCircle } from "lucide-react";
import { INK, MUTED, TONE } from "../lib/theme";

/**
 * 三种页面状态。抽出来是因为**它们几乎总是被一起用错**：
 * 只处理 loading 和 data，忘了 error，于是接口一挂页面就是空白 ——
 * 而空白看起来和「没有数据」一模一样，用户会以为是自己没记东西。
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      style={{
        padding: 20,
        border: `1px solid ${TONE.negative.fg}33`,
        background: TONE.negative.bg,
        borderRadius: 8,
        color: TONE.negative.fg,
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
      }}
    >
      <AlertCircle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>加载失败</div>
        <div style={{ fontSize: 13, wordBreak: "break-all" }}>
          {(error as Error)?.message ?? String(error)}
        </div>
      </div>
      {onRetry && (
        <Button size="small" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  );
}

export function LoadingState({ rows = 6 }: { rows?: number }) {
  return <Skeleton active paragraph={{ rows }} />;
}

export function EmptyState({ children }: { children?: React.ReactNode }) {
  return (
    <div style={{ padding: "48px 0" }}>
      <Empty
        description={
          <span style={{ color: MUTED }}>
            {children ?? (
              <>
                还没有记录。从
                <Link to="/add" style={{ color: INK, fontWeight: 600 }}>
                  {" "}
                  记一条{" "}
                </Link>
                开始 —— 粘贴一个链接，标题和封面会自动带出来。
              </>
            )}
          </span>
        }
      />
    </div>
  );
}
