import { App as AntApp, Layout, Menu, Tag, Tooltip } from "antd";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Heart } from "lucide-react";
import { apiFetch } from "./lib/api";
import type { Health } from "./types";
import Weeks from "./pages/Weeks";
import WeekDetail from "./pages/WeekDetail";
import ItemDetail from "./pages/ItemDetail";
import QuickAdd from "./pages/QuickAdd";
import Trash from "./pages/Trash";
import Tags from "./pages/Tags";
import History from "./pages/History";

import AccessGate from "./components/AccessGate";

const { Header, Content } = Layout;

const NAV = [
  { key: "/add", label: "记一条" },
  { key: "/weeks", label: "按周看" },
  { key: "/history", label: "观看历史" },
  { key: "/tags", label: "标签" },
  { key: "/trash", label: "回收站" },
];

function Nav() {
  const { pathname } = useLocation();
  const selected =
    NAV.find((item) => pathname.startsWith(item.key))?.key ??
    (pathname.startsWith("/item") ? "/weeks" : "/weeks");
  return (
    <Menu
      mode="horizontal"
      selectedKeys={[selected]}
      className="lc-nav"
      items={NAV.map((item) => ({
        key: item.key,
        label: <Link to={item.key}>{item.label}</Link>,
      }))}
    />
  );
}

/**
 * 数据库状态常驻 header。
 *
 * 库在远程，比本地 SQLite 多了一整类失败模式（网络 / 密码 / 防火墙）。
 * 这些失败的表现是「页面空着」，很容易被误判成「功能没做」——
 * 所以让「连没连上」一眼可见。
 */
function DbBadge() {
  const { data, isError, error } = useQuery({
    queryKey: ["health"],
    queryFn: () => apiFetch<Health>("/api/health"),
    refetchInterval: 60_000,
  });

  if (isError) {
    return (
      <Tooltip title={String((error as Error)?.message ?? "连不上后端")}>
        <Tag color="red" style={{ marginInlineEnd: 0 }}>
          数据库未连通
        </Tag>
      </Tooltip>
    );
  }
  if (!data) return null;

  const migrated = data.migrations.length > 0;
  return (
    <Tooltip
      title={`${data.database.client} ${data.database.version}｜迁移：${data.migrations.join(", ") || "未执行"}`}
    >
      <Tag color={migrated ? "cyan" : "orange"} style={{ marginInlineEnd: 0 }}>
        {data.database.version.split("-")[0]}
      </Tag>
    </Tooltip>
  );
}

export default function App() {
  return (
    <AntApp>
      <AccessGate><BrowserRouter>
        <Layout style={{ minHeight: "100%" }}>
          <Header className="lc-header">
            <Link to="/weeks" className="lc-logo" aria-label="Videos Worth Keeping">
              <Heart size={16} style={{ color: "#d4380d", flexShrink: 0 }} />
              <span className="lc-logo-text">Videos Worth Keeping</span>
            </Link>
            <Nav />
            <DbBadge />
          </Header>
          <Content className="lc-content">
            <Routes>
              <Route path="/" element={<Navigate to="/weeks" replace />} />
              <Route path="/add" element={<QuickAdd />} />
              <Route path="/weeks" element={<Weeks />} />
              <Route path="/week/:weekKey" element={<WeekDetail />} />
              <Route path="/item/:id" element={<ItemDetail />} />
              <Route path="/history" element={<History />} />
              <Route path="/tags" element={<Tags />} />
              <Route path="/trash" element={<Trash />} />
              <Route path="*" element={<Navigate to="/weeks" replace />} />
            </Routes>
          </Content>
        </Layout>
      </BrowserRouter></AccessGate>
    </AntApp>
  );
}
