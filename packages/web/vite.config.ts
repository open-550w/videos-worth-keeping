import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(process.env.VITE_PORT || env.VITE_PORT) || 5190,
      strictPort: true,
      // 监听所有网卡 —— 手机要能在同一 WiFi 下访问（需求确认会：手机上用得不少）
      host: true,
      proxy: {
        "/api": process.env.VITE_API_TARGET || env.VITE_API_TARGET || "http://localhost:3050",
        "/uploads": process.env.VITE_API_TARGET || env.VITE_API_TARGET || "http://localhost:3050",
      },
    },
  };
});
