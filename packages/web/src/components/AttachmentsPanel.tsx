import { useRef, useState } from "react";
import { App as AntApp, Button, Image, Popconfirm, Segmented, Upload } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Trash2, Upload as UploadIcon, Film, ImageIcon, Clipboard } from "lucide-react";
import { apiUpload, apiJson, ApiError } from "../lib/api";
import { formatBytes, formatDuration } from "../lib/format";
import { INK, MUTED, RULE, TONE } from "../lib/theme";
import type { Attachment } from "../types";

type Kind = "screenshot" | "backup_image" | "backup_video" | "backup_recording" | "other";

const KIND_LABEL: Record<string, string> = {
  screenshot: "截图",
  backup_image: "备份图",
  backup_video: "备份视频",
  backup_recording: "录屏",
  other: "其它",
};

const KIND_ICON: Record<string, typeof ImageIcon> = {
  screenshot: ImageIcon,
  backup_image: ImageIcon,
  backup_video: Film,
  backup_recording: Film,
  other: Paperclip,
};

/**
 * 附件面板：截图 + 手动备份。
 *
 * 需求确认会：「备份……很可能是用户手动填入备份的内容，截图、视频、录屏之类的。」
 * —— 所以截图和备份是**同一件事**，共用这一套上传/展示/删除。
 *
 * 支持三种入口，因为记东西的时候手边是什么就用什么：
 *   · 直接 Ctrl/Cmd+V 粘贴（截图工具截完就在剪贴板里，最快）
 *   · 拖进来
 *   · 点按钮选文件
 */
export function AttachmentsPanel({
  itemId,
  attachments,
}: {
  itemId: number;
  attachments: Attachment[];
}) {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [kind, setKind] = useState<Kind>("screenshot");
  const [dragging, setDragging] = useState(false);
  const pasteRef = useRef<HTMLDivElement | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["item", itemId] });
    qc.invalidateQueries({ queryKey: ["items"] });
  };

  const uploadMut = useMutation({
    mutationFn: async ({ file, asKind }: { file: File; asKind: Kind }) => {
      const form = new FormData();
      form.append("file", file);
      form.append("kind", asKind);
      return apiUpload<Attachment>(`/api/items/${itemId}/attachments`, form);
    },
    onSuccess: (a) => {
      message.success(a.deduped ? "这个文件之前传过了，直接复用" : "已上传");
      invalidate();
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiJson(`/api/attachments/${id}`, "DELETE"),
    onSuccess: () => {
      message.success("已删除");
      invalidate();
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  const handleFiles = (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    // 一次传多个时自动按类型分：视频走 backup_video，其余跟着当前选择
    for (const f of arr) {
      const auto: Kind = f.type.startsWith("video/")
        ? kind.startsWith("backup")
          ? kind
          : "backup_video"
        : kind;
      uploadMut.mutate({ file: f, asKind: auto });
    }
  };

  const totalBytes = attachments.reduce((s, a) => s + (a.byteSize ?? 0), 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>截图与备份</h2>
        <span style={{ fontSize: 12, color: MUTED }}>
          {attachments.length} 个{totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ""}
        </span>
        <div style={{ flex: 1 }} />
        <Segmented
          size="small"
          value={kind}
          onChange={(v) => setKind(v as Kind)}
          options={[
            { value: "screenshot", label: "截图" },
            { value: "backup_video", label: "备份视频" },
            { value: "backup_recording", label: "录屏" },
            { value: "other", label: "其它" },
          ]}
        />
      </div>

      <div
        ref={pasteRef}
        tabIndex={0}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files ?? []);
          if (files.length) {
            e.preventDefault();
            handleFiles(files);
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        style={{
          border: `1px dashed ${dragging ? TONE.settled.fg : RULE}`,
          background: dragging ? TONE.settled.bg : "#fafafa",
          borderRadius: 8,
          padding: 16,
          textAlign: "center",
          outline: "none",
        }}
      >
        <div style={{ color: MUTED, fontSize: 13, marginBottom: 10 }}>
          <Clipboard size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
          点这里后按 <span className="mono">⌘/Ctrl + V</span> 粘贴截图，或把文件拖进来
        </div>
        <Upload
          multiple
          showUploadList={false}
          beforeUpload={(file) => {
            handleFiles([file as unknown as File]);
            return false; // 自己发请求，不用 antd 的
          }}
        >
          <Button size="small" icon={<UploadIcon size={13} />} loading={uploadMut.isPending}>
            选文件
          </Button>
        </Upload>
      </div>

      {attachments.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
            gap: 10,
            marginTop: 12,
          }}
        >
          {attachments.map((a) => {
            const isImage = (a.mimeType ?? "").startsWith("image/");
            const Icon = KIND_ICON[a.kind] ?? Paperclip;
            return (
              <div
                key={a.id}
                style={{
                  border: `1px solid ${RULE}`,
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "#fff",
                }}
              >
                <div style={{ height: 96, background: "#f6f7f8", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {isImage ? (
                    <Image
                      src={a.url}
                      alt={a.originalName ?? ""}
                      style={{ width: "100%", height: 96, objectFit: "cover" }}
                    />
                  ) : (
                    <a href={a.url} target="_blank" rel="noreferrer noopener" style={{ color: MUTED }}>
                      <Icon size={26} />
                    </a>
                  )}
                </div>
                <div style={{ padding: "6px 8px", fontSize: 11, color: MUTED }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                    <span style={{ color: INK }}>{KIND_LABEL[a.kind] ?? a.kind}</span>
                    <div style={{ flex: 1 }} />
                    <Popconfirm
                      title="删掉这个附件？"
                      description="文件也会一起删掉，不可恢复。"
                      onConfirm={() => deleteMut.mutate(a.id)}
                      okText="删"
                      cancelText="算了"
                    >
                      <Button type="text" size="small" danger icon={<Trash2 size={11} />} />
                    </Popconfirm>
                  </div>
                  <div
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={a.originalName ?? ""}
                  >
                    {a.originalName ?? "（无文件名）"}
                  </div>
                  <div className="mono">
                    {formatBytes(a.byteSize)}
                    {a.durationSec ? ` · ${formatDuration(a.durationSec)}` : ""}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
