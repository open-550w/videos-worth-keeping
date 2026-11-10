import { useEffect, useRef, useState } from "react";
import { Alert, Button, DatePicker, Input, Select, Space, Spin, Tag as AntTag, App as AntApp } from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Link2, Loader2, AlertTriangle } from "lucide-react";
import dayjs from "dayjs";
import { apiFetch, apiJson, ApiError } from "../lib/api";
import { looksLikeUrl, today } from "@likes/shared";
import { WatchRangesEditor } from "../components/WatchRangesEditor";
import { ChannelTag } from "../components/ChannelTag";
import { INK, MONO, MUTED, RULE, TONE } from "../lib/theme";
import type { Channel, DateRange, DuplicateInfo, Item, ResolveOutcome, TagGroup } from "../types";

/**
 * 快速录入 —— **这个页面的成败决定整个站的成败**。
 *
 * 需求里的判据是「看到一个喜欢的视频，30 秒内能记下来」。
 * 所以流程必须短：粘贴 → 自动带出 → 写一句话 → 存。
 * 中间任何一步要用户「先去做点别的」（填标题、选渠道、找封面）都会让这个判据不成立。
 *
 * 关键设计：
 *   · 抓取失败**降级为手填**，不挡录入 —— 抓取是加速，不是前置条件
 *   · 粘贴后自动解析，解析完**光标直接落在评论框**
 *   · 重复收藏给**跳转链接**，不只是弹一句「已收藏过」
 */
export default function QuickAdd() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();

  const [url, setUrl] = useState("");
  const [resolved, setResolved] = useState<ResolveOutcome | null>(null);
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [channelCode, setChannelCode] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [collectedOn, setCollectedOn] = useState(today());
  // 默认「今天看的一天」—— 不动它也能直接存（「30 秒记一条」那条判据靠这个）
  const [watchedRanges, setWatchedRanges] = useState<DateRange[]>([
    { from: today(), to: today() },
  ]);
  const [note, setNote] = useState("");
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);

  const noteRef = useRef<TextAreaRef | null>(null);

  const { data: channels } = useQuery({
    queryKey: ["channels"],
    queryFn: () => apiFetch<Channel[]>("/api/channels"),
  });
  const { data: tagData } = useQuery({
    queryKey: ["tags"],
    queryFn: () => apiFetch<{ groups: TagGroup[] }>("/api/tags"),
  });

  // 解析：粘贴后自动触发，也可以手动点
  const resolveMut = useMutation({
    mutationFn: (u: string) => apiJson<ResolveOutcome>("/api/resolve", "POST", { url: u }),
    onSuccess: (out) => {
      setResolved(out);
      setDuplicate(null);
      if (out.resolved) {
        setTitle((prev) => prev || out.resolved!.title || "");
        setAuthor((prev) => prev || out.resolved!.author || "");
        setChannelCode((prev) => prev ?? out.resolved!.channelCode);
        setCoverUrl(out.resolved!.coverUrl ?? null);
        // 解析成功 → 光标直接跳到评论框。这一步是「30 秒」的关键：
        // 用户不需要用鼠标去点下一个框。
        requestAnimationFrame(() => noteRef.current?.focus());
      }
    },
    onError: (e: Error) => message.warning(`解析失败：${e.message}（可以手填）`),
  });

  const saveMut = useMutation({
    mutationFn: () =>
      apiJson<Item>("/api/items", "POST", {
        url: url.trim() || null,
        title: title.trim(),
        author: author.trim() || null,
        channel_code: channelCode,
        platform_item_id: resolved?.resolved?.platformItemId ?? null,
        cover_url: coverUrl,
        summary: resolved?.resolved?.summary ?? null,
        duration_sec: resolved?.resolved?.durationSec ?? null,
        published_on: resolved?.resolved?.publishedOn ?? null,
        collected_on: collectedOn,
        watched_ranges: watchedRanges,
        note: note.trim() || undefined,
        tag_ids: tagIds.length ? tagIds : undefined,
      }),
    onSuccess: (item) => {
      message.success("记下了");
      qc.invalidateQueries({ queryKey: ["weeks"] });
      qc.invalidateQueries({ queryKey: ["items"] });
      nav(`/item/${item.id}`);
    },
    onError: (e: ApiError) => {
      // 后端 409 时把已有条目带回来了（见 items.service.ts createItem）——
      // 只弹一句「已收藏过」是没用的，用户还得自己去翻
      const info = e.detail<DuplicateInfo>();
      if (info?.existingItemId) {
        setDuplicate(info);
      } else {
        message.error(e.message);
      }
    },
  });

  // 粘贴后自动解析（等 400ms，避免粘贴一半就发请求）
  useEffect(() => {
    const u = url.trim();
    if (!looksLikeUrl(u)) {
      setResolved(null);
      return;
    }
    const t = setTimeout(() => resolveMut.mutate(u), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const canSave = (title.trim() || url.trim()) && !saveMut.isPending;

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 4px" }}>记一条</h1>
      <p style={{ color: MUTED, fontSize: 12, margin: "0 0 16px" }}>
        粘贴链接 → 自动带出标题封面 → 写一句话 → 存。抓不到也能手填，不会挡住你。
      </p>

      {duplicate && (
        <Alert
          type="warning"
          showIcon
          icon={<AlertTriangle size={16} />}
          style={{ marginBottom: 16 }}
          message="这个已经收藏过了"
          description={
            <div style={{ fontSize: 13 }}>
              「{duplicate.existingTitle || "（无标题）"}」，
              收藏于 <span className="mono">{duplicate.existingCollectedOn}</span>。
              <div style={{ marginTop: 8 }}>
                <Space>
                  <Link to={`/item/${duplicate.existingItemId}`}>
                    <Button size="small" type="primary">
                      去看看，顺便补一句
                    </Button>
                  </Link>
                  <Button
                    size="small"
                    onClick={() => {
                      setDuplicate(null);
                      setUrl("");
                      setTitle("");
                      setResolved(null);
                    }}
                  >
                    换一条
                  </Button>
                </Space>
              </div>
            </div>
          }
        />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={labelStyle}>链接</label>
          <Input
            size="large"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="粘贴红果 / B 站链接（也可以留空，纯手记）"
            prefix={<Link2 size={15} color={MUTED} />}
            allowClear
            autoFocus
          />
          <div style={{ marginTop: 6, minHeight: 20, fontSize: 12 }}>
            {resolveMut.isPending && (
              <span style={{ color: MUTED, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Loader2 size={12} className="spin" /> 正在识别…
              </span>
            )}
            {!resolveMut.isPending && resolved?.resolved && (
              <span style={{ color: TONE.settled.fg, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <CheckCircle2 size={13} /> 已识别，标题和封面已带出
              </span>
            )}
            {!resolveMut.isPending && resolved && !resolved.resolved && resolved.reason && (
              <span style={{ color: TONE.pending.fg }}>
                {resolved.reason} —— 手动填一下就行
              </span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 260px", minWidth: 0 }}>
            <label style={labelStyle}>标题</label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="抓不到就手填"
            />
          </div>
          <div style={{ flex: "0 1 160px", minWidth: 0 }}>
            <label style={labelStyle}>收藏日期</label>
            <DatePicker
              style={{ width: "100%" }}
              value={dayjs(collectedOn)}
              onChange={(d) => setCollectedOn(d ? d.format("YYYY-MM-DD") : today())}
              allowClear={false}
            />
          </div>
        </div>

        <div>
          <label style={labelStyle}>观看日期</label>
          <WatchRangesEditor value={watchedRanges} onChange={setWatchedRanges} />
          <div style={{ fontSize: 11, color: MUTED, marginTop: 6, lineHeight: 1.7 }}>
            <b>观看日期决定它出现在哪几周</b>（按周看就是按它分的），跨几周就出现在几周。
            <br />
            收藏日期是「我什么时候把它记下来的」—— 补录时它还是今天，和看的那天是两件事。
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "0 1 160px", minWidth: 0 }}>
            <label style={labelStyle}>渠道</label>
            <Select
              style={{ width: "100%" }}
              value={channelCode}
              onChange={setChannelCode}
              allowClear
              placeholder="自动识别"
              options={(channels ?? []).map((c) => ({ value: c.code, label: c.name }))}
            />
          </div>
          <div style={{ flex: "1 1 200px", minWidth: 0 }}>
            <label style={labelStyle}>作者 / UP 主</label>
            <Input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="可留空" />
          </div>
        </div>

        {coverUrl && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img
              src={coverUrl}
              alt=""
              style={{ width: 56, height: 76, objectFit: "cover", borderRadius: 4, border: `1px solid ${RULE}` }}
            />
            <span style={{ fontSize: 12, color: MUTED }}>封面已带出</span>
            <Button size="small" type="text" onClick={() => setCoverUrl(null)}>
              去掉
            </Button>
          </div>
        )}

        {(tagData?.groups?.length ?? 0) > 0 && (
          <div>
            <label style={labelStyle}>标签</label>
            <Select
              mode="multiple"
              style={{ width: "100%" }}
              placeholder="可选"
              value={tagIds}
              onChange={setTagIds}
              options={(tagData?.groups ?? []).flatMap((g) =>
                g.tags.map((t) => ({
                  value: t.id,
                  label: `${g.name} / ${t.name}`,
                })),
              )}
            />
            <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
              标着「分类」的组（单选）只保留一个，这是服务端强制的。
            </div>
          </div>
        )}

        <div>
          <label style={styleLabelWithLabelInline}>我的评论</label>
          <Input.TextArea
            ref={noteRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="当时为什么喜欢它？（可留空，之后也能补）"
            autoSize={{ minRows: 3, maxRows: 10 }}
            // Ctrl/Cmd + Enter 直接存 —— 手不离键盘
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSave) {
                saveMut.mutate();
              }
            }}
          />
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Button
            type="primary"
            size="large"
            loading={saveMut.isPending}
            disabled={!canSave}
            onClick={() => saveMut.mutate()}
          >
            存下来
          </Button>
          <span style={{ fontSize: 12, color: MUTED }}>
            <span className="mono">⌘/Ctrl + Enter</span> 也能存
          </span>
          {resolveMut.isPending && <Spin size="small" />}
        </div>

        {resolved?.resolved?.summary && (
          <div
            style={{
              fontSize: 12,
              color: MUTED,
              background: "#fafafa",
              border: `1px solid ${RULE}`,
              borderRadius: 6,
              padding: 10,
              lineHeight: 1.7,
            }}
          >
            <div style={{ marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
              <AntTag style={{ marginInlineEnd: 0 }}>
                <ChannelTag code={channelCode} name={channels?.find((c) => c.code === channelCode)?.name ?? null} />
              </AntTag>
              <span>自动抓到的简介</span>
            </div>
            {resolved.resolved.summary}
          </div>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: MUTED,
  marginBottom: 4,
};

const styleLabelWithLabelInline: React.CSSProperties = {
  ...labelStyle,
  color: INK,
  fontWeight: 600,
  fontSize: 13,
};
