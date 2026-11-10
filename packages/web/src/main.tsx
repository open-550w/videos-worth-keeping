import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import { INK } from "./lib/theme";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 个人站，数据变化不频繁；切回页面时刷新一次就够
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorPrimary: INK,
            borderRadius: 6,
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
          },
        }}
      >
        <App />
      </ConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
