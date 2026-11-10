import { useState, type ReactNode } from "react";
import { Button, Form, Input, Alert, Spin } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiJson, ApiError } from "../lib/api";

export default function AccessGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const auth = useQuery({ queryKey: ["access"], queryFn: () => apiFetch("/api/health"), retry: false, refetchOnWindowFocus: true });
  if (auth.isPending) return <Spin fullscreen />;
  if (auth.isSuccess) return <>
    <div style={{ textAlign: "right", padding: "4px 20px" }}><Button size="small" onClick={async () => {
      await apiJson("/api/auth/logout", "POST", {});
      qc.clear();
      location.reload();
    }}>退出登录</Button></div>{children}
  </>;
  const needsToken = auth.error instanceof ApiError && auth.error.status === 401;
  return <main style={{ maxWidth: 400, margin: "15vh auto", padding: 24 }}>
    <h1>Videos Worth Keeping</h1><p>输入访问口令，打开你的私人收藏。</p>
    {!needsToken && <Alert type="error" title={String(auth.error?.message)} />}
    {error && <Alert type="error" title={error} />}
    <Form onFinish={async ({ token }: { token: string }) => {
      setBusy(true); setError("");
      try { await apiJson("/api/auth/login", "POST", { token }); qc.clear(); }
      catch (err) { setError((err as Error).message); }
      finally { setBusy(false); }
    }}>
      <Form.Item name="token" rules={[{ required: true, message: "请输入访问口令" }]}>
        <Input.Password autoComplete="current-password" aria-label="访问口令" placeholder="访问口令" />
      </Form.Item>
      <Button htmlType="submit" type="primary" loading={busy} block>进入收藏</Button>
    </Form>
  </main>;
}
