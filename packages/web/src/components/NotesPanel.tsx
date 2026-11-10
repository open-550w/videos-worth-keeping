import { useState } from "react";
import { App as AntApp, Button, DatePicker, Input, Popconfirm, Space, Rate, Tag as AntTag } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import dayjs from "dayjs";
import { apiJson } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { INK, MUTED, RULE, TONE } from "../lib/theme";
import type { Note } from "../types";

/**
 * 评论面板。
 *
 * 需求确认会：「评论不止一条，日期时间也要记录的噢」——
 * 所以这里支持追加多条，而且**每条的时间可以改**。
 *
 * 为什么时间要能改：**补录是常态**。周五想起周一喜欢的视频，
 * `noted_at` 该是周一（这样它落在正确的那一周），但 `created_at` 确实是周五。
 * 两个时间戳分开存就是为了这个 —— 见 docs/init/02_DATA_MODEL.md §3.1。
 */
export function NotesPanel({ itemId, notes }: { itemId: number; notes: Note[] }) {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState("");
  const [notedAt, setNotedAt] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["item", itemId] });
    qc.invalidateQueries({ queryKey: ["items"] });
    qc.invalidateQueries({ queryKey: ["weeks"] });
  };

  const createMut = useMutation({
    mutationFn: () =>
      apiJson(`/api/items/${itemId}/notes`, "POST", {
        body: body.trim(),
        rating,
        noted_at: notedAt ? `${notedAt}:00` : null,
      }),
    onSuccess: () => {
      message.success("评论已加上");
      setBody("");
      setNotedAt(null);
      setRating(null);
      setAdding(false);
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const updateMut = useMutation({
    mutationFn: (p: { id: number; body: string; noted_at?: string }) =>
      apiJson(`/api/notes/${p.id}`, "PATCH", { body: p.body, noted_at: p.noted_at }),
    onSuccess: () => {
      message.success("已更新");
      setEditingId(null);
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiJson(`/api/notes/${id}`, "DELETE"),
    onSuccess: () => {
      message.success("已删除");
      invalidate();
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>我的评论</h2>
        <span style={{ fontSize: 12, color: MUTED }}>{notes.length} 条</span>
        <div style={{ flex: 1 }} />
        {!adding && (
          <Button size="small" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
            再写一条
          </Button>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {notes.map((n) =>
          editingId === n.id ? (
            <EditNote
              key={n.id}
              note={n}
              saving={updateMut.isPending}
              onCancel={() => setEditingId(null)}
              onSave={(nextBody, nextNotedAt) =>
                updateMut.mutate({ id: n.id, body: nextBody, noted_at: nextAt(nextNotedAt) })
              }
            />
          ) : (
            <div
              key={n.id}
              style={{
                padding: "10px 12px",
                background: "#fff",
                border: `1px solid ${RULE}`,
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  color: MUTED,
                  marginBottom: 6,
                  flexWrap: "wrap",
                }}
              >
                <span className="mono">{formatDateTime(n.notedAt)}</span>
                {n.rating !== null && <Rate disabled value={n.rating} style={{ fontSize: 11 }} />}
                {/* 补录的痕迹：写的时间和记的时间不是同一天时，明确标出来 */}
                {n.notedAt.slice(0, 10) !== n.createdAt.slice(0, 10) && (
                  <AntTag
                    style={{
                      marginInlineEnd: 0,
                      fontSize: 11,
                      color: TONE.pending.fg,
                      background: TONE.pending.bg,
                      border: "none",
                    }}
                  >
                    补录于 {formatDateTime(n.createdAt)}
                  </AntTag>
                )}
                <div style={{ flex: 1 }} />
                <Button
                  type="text"
                  size="small"
                  icon={<Pencil size={12} />}
                  onClick={() => setEditingId(n.id)}
                />
                <Popconfirm
                  title="删掉这条评论？"
                  onConfirm={() => deleteMut.mutate(n.id)}
                  okText="删"
                  cancelText="算了"
                >
                  <Button type="text" size="small" danger icon={<Trash2 size={12} />} />
                </Popconfirm>
              </div>
              <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.7, fontSize: 14, color: INK }}>
                {n.body}
              </div>
              {n.attachments.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
                  {n.attachments.map((a) => (
                    <a key={a.id} href={a.url} target="_blank" rel="noreferrer noopener">
                      <img
                        src={a.url}
                        alt={a.originalName ?? ""}
                        style={{
                          width: 64,
                          height: 64,
                          objectFit: "cover",
                          borderRadius: 4,
                          border: `1px solid ${RULE}`,
                        }}
                      />
                    </a>
                  ))}
                </div>
              )}
            </div>
          ),
        )}

        {adding && (
          <div
            style={{
              padding: 12,
              background: "#fff",
              border: `1px solid ${TONE.settled.fg}55`,
              borderRadius: 8,
            }}
          >
            <Input.TextArea
              autoFocus
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="写点什么…"
              autoSize={{ minRows: 3, maxRows: 12 }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 8,
                flexWrap: "wrap",
              }}
            >
              <DatePicker
                showTime={{ format: "HH:mm" }}
                format="YYYY-MM-DD HH:mm"
                placeholder="写这条评论的时间（默认现在）"
                value={notedAt ? dayjs(notedAt) : null}
                onChange={(d) => setNotedAt(d ? d.format("YYYY-MM-DD HH:mm") : null)}
                style={{ width: 230 }}
              />
              <Rate value={rating ?? 0} onChange={(v) => setRating(v || null)} style={{ fontSize: 14 }} />
              <div style={{ flex: 1 }} />
              <Space>
                <Button
                  size="small"
                  onClick={() => {
                    setAdding(false);
                    setBody("");
                    setNotedAt(null);
                  }}
                  icon={<X size={12} />}
                >
                  取消
                </Button>
                <Button
                  size="small"
                  type="primary"
                  disabled={!body.trim()}
                  loading={createMut.isPending}
                  onClick={() => createMut.mutate()}
                >
                  加上
                </Button>
              </Space>
            </div>
          </div>
        )}

        {!notes.length && !adding && (
          <div style={{ color: MUTED, fontSize: 13, padding: "8px 0" }}>
            还没有评论。
          </div>
        )}
      </div>
    </div>
  );
}

/** `2026-10-17 21:30` → `2026-10-17 21:30:00`（MySQL DATETIME 的形状）。 */
function nextAt(v: string | null): string | undefined {
  return v ? `${v}:00` : undefined;
}

function EditNote({
  note,
  saving,
  onSave,
  onCancel,
}: {
  note: Note;
  saving: boolean;
  onSave: (body: string, notedAt: string | null) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(note.body);
  const [notedAt, setNotedAt] = useState(note.notedAt.slice(0, 16).replace(" ", "T"));

  return (
    <div
      style={{
        padding: 12,
        background: "#fff",
        border: `1px solid ${TONE.pending.fg}55`,
        borderRadius: 8,
      }}
    >
      <Input.TextArea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        autoSize={{ minRows: 3, maxRows: 12 }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
        <DatePicker
          showTime={{ format: "HH:mm" }}
          format="YYYY-MM-DD HH:mm"
          value={dayjs(notedAt)}
          onChange={(d) => setNotedAt(d ? d.format("YYYY-MM-DDTHH:mm") : "")}
          style={{ width: 230 }}
        />
        <span style={{ fontSize: 11, color: MUTED }}>改时间可以把它挪到正确的周</span>
        <div style={{ flex: 1 }} />
        <Space>
          <Button size="small" onClick={onCancel}>
            取消
          </Button>
          <Button
            size="small"
            type="primary"
            loading={saving}
            disabled={!body.trim()}
            onClick={() => onSave(body.trim(), notedAt ? notedAt.replace("T", " ") : null)}
          >
            保存
          </Button>
        </Space>
      </div>
    </div>
  );
}
