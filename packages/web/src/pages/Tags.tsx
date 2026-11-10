import { useState } from "react";
import { App as AntApp, Button, Empty, Input, Popconfirm, Segmented, Space, Tag as AntTag } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { apiFetch, apiJson, ApiError } from "../lib/api";
import { ErrorState, LoadingState } from "../components/State";
import { INK, MUTED, RULE, TONE } from "../lib/theme";
import type { TagGroup } from "../types";

/**
 * 标签与分类。
 *
 * 需求确认会：「标签和分类都想要，但不是现在，都要是因为不确定哪个更好；
 * 我既想简洁、又想好用。。。」
 *
 * 这个页面的存在就是为了让那个纠结**不用做选择** ——
 * 每个组有一个 `selection`：
 *   · **分类（单选）**：一个组里一条记录只能选一个，像「题材」
 *   · **标签（多选）**：可以选多个，像「心情」
 *
 * 随时能把某个组从多选改成单选（放宽约束不用动数据）。
 */
export default function Tags() {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupSel, setNewGroupSel] = useState<"single" | "multiple">("multiple");
  const [addingTagIn, setAddingTagIn] = useState<number | null>(null);
  const [newTagName, setNewTagName] = useState("");

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["tags"],
    queryFn: () => apiFetch<{ groups: TagGroup[] }>("/api/tags"),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tags"] });
    qc.invalidateQueries({ queryKey: ["items"] });
  };

  const onErr = (e: ApiError) => message.error(e.message);

  const createGroupMut = useMutation({
    mutationFn: () => apiJson("/api/tags/groups", "POST", { name: newGroupName.trim(), selection: newGroupSel }),
    onSuccess: () => {
      message.success("标签组已建");
      setNewGroupName("");
      invalidate();
    },
    onError: onErr,
  });

  const updateGroupMut = useMutation({
    mutationFn: (p: { id: number; selection?: "single" | "multiple"; name?: string }) =>
      apiJson(`/api/tags/groups/${p.id}`, "PATCH", { selection: p.selection, name: p.name }),
    onSuccess: () => {
      message.success("已更新");
      invalidate();
    },
    onError: onErr,
  });

  const deleteGroupMut = useMutation({
    mutationFn: (id: number) => apiJson(`/api/tags/groups/${id}`, "DELETE"),
    onSuccess: () => {
      message.success("标签组已删除（组里的标签一并删了）");
      invalidate();
    },
    onError: onErr,
  });

  const createTagMut = useMutation({
    mutationFn: (p: { groupId: number; name: string }) =>
      apiJson("/api/tags", "POST", { groupId: p.groupId, name: p.name }),
    onSuccess: () => {
      message.success("标签已加");
      setNewTagName("");
      setAddingTagIn(null);
      invalidate();
    },
    onError: onErr,
  });

  const deleteTagMut = useMutation({
    mutationFn: (id: number) => apiJson(`/api/tags/${id}`, "DELETE"),
    onSuccess: () => {
      message.success("已删除");
      invalidate();
    },
    onError: onErr,
  });

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  const groups = data?.groups ?? [];

  return (
    <div style={{ maxWidth: 780 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px" }}>标签与分类</h1>
      <p style={{ color: MUTED, fontSize: 12, margin: "0 0 20px", lineHeight: 1.7 }}>
        不用在「标签」和「分类」之间做选择 ——{" "}
        <b>分类就是一个只能选一个的标签组</b>。
        标着<span style={{ color: TONE.settled.fg }}> 分类（单选）</span>的组里一条记录只能选一个，
        标着<span style={{ color: TONE.pending.fg }}> 标签（多选）</span>的组可以选多个。
        随时可以改，改宽了历史数据不用动。
      </p>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          padding: 12,
          background: "#fff",
          border: `1px solid ${RULE}`,
          borderRadius: 8,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        <Input
          placeholder="新建标签组，如「题材」「心情」「状态」"
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          onPressEnter={() => newGroupName.trim() && createGroupMut.mutate()}
          style={{ flex: "1 1 200px", minWidth: 0 }}
        />
        <Segmented
          value={newGroupSel}
          onChange={(v) => setNewGroupSel(v as "single" | "multiple")}
          options={[
            { value: "single", label: "分类（单选）" },
            { value: "multiple", label: "标签（多选）" },
          ]}
        />
        <Button
          type="primary"
          icon={<Plus size={13} />}
          disabled={!newGroupName.trim()}
          loading={createGroupMut.isPending}
          onClick={() => createGroupMut.mutate()}
        >
          建组
        </Button>
      </div>

      {!groups.length ? (
        <Empty description={<span style={{ color: MUTED }}>还没有标签组。上面建一个试试。</span>} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {groups.map((g) => (
            <div
              key={g.id}
              style={{ padding: 14, background: "#fff", border: `1px solid ${RULE}`, borderRadius: 8 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: INK }}>{g.name}</span>
                <Segmented
                  size="small"
                  value={g.selection}
                  onChange={(v) =>
                    updateGroupMut.mutate({ id: g.id, selection: v as "single" | "multiple" })
                  }
                  options={[
                    { value: "single", label: "分类" },
                    { value: "multiple", label: "标签" },
                  ]}
                />
                <div style={{ flex: 1 }} />
                <Popconfirm
                  title={`删掉「${g.name}」？`}
                  description={`组里 ${g.tags.length} 个标签和所有条目的关联都会一起删掉。`}
                  okText="删"
                  okButtonProps={{ danger: true }}
                  cancelText="算了"
                  onConfirm={() => deleteGroupMut.mutate(g.id)}
                >
                  <Button type="text" size="small" danger icon={<Trash2 size={12} />} />
                </Popconfirm>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {g.tags.map((t) => (
                  <AntTag
                    key={t.id}
                    closable
                    onClose={(e) => {
                      e.preventDefault();
                      deleteTagMut.mutate(t.id);
                    }}
                    style={{ marginInlineEnd: 0 }}
                  >
                    {t.name}
                  </AntTag>
                ))}
                {addingTagIn === g.id ? (
                  <Space.Compact size="small">
                    <Input
                      size="small"
                      autoFocus
                      placeholder="标签名"
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      onPressEnter={() =>
                        newTagName.trim() && createTagMut.mutate({ groupId: g.id, name: newTagName.trim() })
                      }
                      style={{ width: 130 }}
                    />
                    <Button
                      size="small"
                      type="primary"
                      disabled={!newTagName.trim()}
                      onClick={() =>
                        newTagName.trim() && createTagMut.mutate({ groupId: g.id, name: newTagName.trim() })
                      }
                    >
                      加
                    </Button>
                    <Button
                      size="small"
                      icon={<X size={11} />}
                      onClick={() => {
                        setAddingTagIn(null);
                        setNewTagName("");
                      }}
                    />
                  </Space.Compact>
                ) : (
                  <Button
                    size="small"
                    type="dashed"
                    icon={<Plus size={11} />}
                    onClick={() => {
                      setAddingTagIn(g.id);
                      setNewTagName("");
                    }}
                  >
                    加标签
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
