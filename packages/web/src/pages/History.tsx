import { useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntApp,
  Button,
  Checkbox,
  DatePicker,
  Input,
  Pagination,
  Popconfirm,
  Segmented,
  Select,
  Tag,
  Tooltip,
} from "antd";
import { Link, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CheckCircle2,
  ExternalLink,
  ThumbsUp,
  Coins,
  Star,
  History as HistoryIcon,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
} from "lucide-react";
import dayjs from "dayjs";
import { apiFetch, apiJson, qs, type ApiError } from "../lib/api";
import { formatDateShort, formatDuration } from "../lib/format";
import { INK, MUTED, RULE, TONE } from "../lib/theme";
import { Cover } from "../components/Cover";
import { EmptyState, ErrorState, LoadingState } from "../components/State";
import type {
  HistoryFacets,
  HistoryListResponse,
  HistorySearchField,
  HistoryVideo,
  ImportResult,
  SyncState,
} from "../types";

const PAGE_SIZES = [24, 48, 96];

type Status = "active" | "pending" | "collected" | "archived";
type SearchField = HistorySearchField;

const FIELD_LABEL: Record<SearchField, string> = {
  title: "标题",
  tags: "话题标签",
  summary: "简介",
  author: "UP 主",
};

const BUSINESS_LABEL: Record<string, string> = {
  live: "直播",
  pgc: "番剧",
  article: "专栏",
  cheese: "课堂",
};

/**
 * 从 B 站观看历史里挑东西进收藏。
 *
 * 这一页回答的是「**这些我看过的东西里，哪些值得留下**」——
 * 抓取本身是命令行干的（`pnpm fetch:bili`），因为抓一次要几十秒到几分钟、
 * 要打外部接口、限流时还得退避重试，塞进 HTTP 请求里就是个必然超时的接口。
 *
 * 五条设计上的取舍：
 *
 * ① **默认显示「未归档」**，收藏后仍留在列表；「待选」可单独筛未收藏的。
 *    收藏是人的选择；归档才表示不再出现在默认列表。
 *
 * ② **卡片网格，不是列表**。一条候选的信息量（封面 / 标题 / UP / 时长 / 进度 /
 *    设备 / 观看时刻 / 标签 / 是否已收藏）在列表里要占一整行还挤，
 *    卡片一屏能放十几个。
 *
 * ③ **勾选的单位是视频，不是观看事件**。同一条视频看了三次，这里只有一张卡；
 *    导入时那三次会变成 items 上的多个观看区间。
 *
 * ④ **筛选 / 搜索 / 分页全部下推到服务端**（不是前端过滤当前这一页）——
 *    否则「一键归档」会只归档你看到的那几十条，那是最坏的一种误解。
 *
 * ⑤ **跨页勾选要真的记住**。`selected` 存的是「平台 ID → 那一组的行 id」，
 *    不是「当前页里我勾了谁」—— 后者翻页就会**静默丢掉**前面的勾选
 *    （界面上还显示着「已选 5 条」，提交时只提交当前页的 2 条）。
 *
 * 已经收藏过的也能勾 —— 那时导入做的是「把这次观看的时间补进去」，
 * 而不是新建一条。所以它同时也是一个「补录观看记录」的入口。
 */
export default function History() {
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawStatus = searchParams.get("status");
  const status: Status = rawStatus === "pending" || rawStatus === "collected" || rawStatus === "archived" ? rawStatus : "active";
  const q = searchParams.get("q") ?? "";
  const [draftQ, setDraftQ] = useState(q);
  useEffect(() => setDraftQ(q), [q]);
  const rawFields = (searchParams.get("fields") ?? "title").split(",");
  const fields = rawFields.filter((f): f is SearchField => Object.hasOwn(FIELD_LABEL, f));
  if (!fields.length) fields.push("title");
  const validDate = (s: string | null) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && dayjs(s).isValid() && dayjs(s).format("YYYY-MM-DD") === s;
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const range: [string, string] | null = validDate(from) && validDate(to) && from! <= to! ? [from!, to!] : null;
  const up = searchParams.get("up");
  const tag = searchParams.get("tag");
  const rawPage = Number(searchParams.get("page") ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const rawSize = Number(searchParams.get("pageSize"));
  const pageSize = PAGE_SIZES.includes(rawSize) ? rawSize : PAGE_SIZES[0];
  const updateParams = (patch: Record<string, string | null>, resetPage = true) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (resetPage) next.delete("page");
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === "") next.delete(key);
        else next.set(key, value);
      }
      return next;
    });
  };
  /** 平台 ID → 这个视频在候选区里的行 id。跨页保留，见 ⑤ */
  const [selected, setSelected] = useState<Map<string, number[]>>(new Map());

  const filterKey = JSON.stringify({ status, q, fields, range, up, tag });

  const filterParams = {
    q: q || undefined,
    fields: fields.length ? fields.join(",") : undefined,
    from: range?.[0],
    to: range?.[1],
    tag: tag ?? undefined,
    up: up ?? undefined,
  };

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["history", filterKey, page, pageSize],
    queryFn: () =>
      apiFetch<HistoryListResponse>(
        `/api/history${qs({ status, ...filterParams, limit: pageSize, offset: (page - 1) * pageSize })}`,
      ),
  });

  const { data: facets } = useQuery({
    queryKey: ["history-facets"],
    queryFn: () => apiFetch<HistoryFacets>("/api/history/facets"),
  });

  // 同步是个后台任务，跑几十秒到几分钟 —— 所以要轮询看进度，不能点完就没反应
  const { data: sync } = useQuery({
    queryKey: ["history-sync"],
    queryFn: () => apiFetch<SyncState>("/api/history/sync"),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });

  const syncMut = useMutation({
    mutationFn: (refreshCookies: boolean) => apiJson<SyncState>("/api/history/sync", "POST", { refreshCookies }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["history-sync"] }),
    onError: (e: ApiError) => message.error(e.message),
  });

  // 同步**结束的那一刻**刷新列表。轮询本身不会告诉我们「刚刚结束」，
  // 只能记住上一轮在不在跑 —— 这就是那个「记住」。
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = Boolean(sync?.running);
    if (wasRunning.current && !running) {
      qc.invalidateQueries({ queryKey: ["history"] });
      qc.invalidateQueries({ queryKey: ["history-facets"] });
      if (sync?.error) message.error("同步失败，详情见下方提示");
      else message.success(`同步完成：新增 ${sync?.last?.inserted ?? 0} 条`);
    }
    wasRunning.current = running;
  }, [sync, qc, message]);

  const videos = data?.videos ?? [];
  const counts = data?.counts;

  // 提交的是**所有**勾选的（不只当前页）
  const selectedEntryIds = useMemo(
    () => [...selected.values()].flat(),
    [selected],
  );

  // 翻页保留勾选；搜索、筛选或浏览器前进后退改变筛选时清空。
  useEffect(() => setSelected(new Map()), [filterKey]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["history"] });
    qc.invalidateQueries({ queryKey: ["history-facets"] });
    qc.invalidateQueries({ queryKey: ["items"] });
    qc.invalidateQueries({ queryKey: ["weeks"] });
  };

  const importMut = useMutation({
    mutationFn: () =>
      apiJson<ImportResult>("/api/history/import", "POST", { entryIds: selectedEntryIds }),
    onSuccess: (r) => {
      const parts = [
        r.created ? `收藏了 ${r.created} 条` : "",
        r.merged ? `${r.merged} 条已收藏过，补了观看时间` : "",
      ].filter(Boolean);
      message.success(parts.join("；") || "没有变化");
      if (r.skipped.length) {
        // 失败的原因要给人看见，不能吞 —— 否则用户以为都成功了
        modal.warning({
          title: `${r.skipped.length} 条没能导入`,
          content: (
            <div style={{ fontSize: 13, lineHeight: 1.9 }}>
              {r.skipped.slice(0, 10).map((s) => (
                <div key={s.platformItemId}>
                  <span style={{ color: MUTED }}>{s.title.slice(0, 24)}</span> —— {s.reason}
                </div>
              ))}
              {r.skipped.length > 10 && (
                <div style={{ color: MUTED }}>…还有 {r.skipped.length - 10} 条</div>
              )}
            </div>
          ),
        });
      }
      setSelected(new Map());
      invalidate();
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  const archiveMut = useMutation({
    mutationFn: (archived: boolean) =>
      apiJson("/api/history/archive", "POST", { entryIds: selectedEntryIds, archived }),
    onSuccess: (_r, archived) => {
      message.success(archived ? "已归档（在「已归档」里能恢复）" : "已恢复");
      setSelected(new Map());
      invalidate();
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  const archiveAllMut = useMutation({
    mutationFn: () =>
      apiJson<{ archived: number }>("/api/history/archive-all", "POST", filterParams),
    onSuccess: (r) => {
      message.success(`归档了 ${r.archived} 条（在「已归档」里能恢复）`);
      setSelected(new Map());
      invalidate();
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  const toggle = (v: HistoryVideo) => {
    const next = new Map(selected);
    if (next.has(v.platformItemId)) next.delete(v.platformItemId);
    else next.set(v.platformItemId, v.entryIds);
    setSelected(next);
  };

  const allSelected = videos.length > 0 && videos.every((v) => selected.has(v.platformItemId));
  const busy = importMut.isPending || archiveMut.isPending || archiveAllMut.isPending;
  const hasFilter = !!(q || range || up || tag);
  const filterCount = [q && "搜索", range && "日期", up && "UP 主", tag && "标签"].filter(Boolean).length;
  const total = data?.total ?? 0;

  const pager = (position: "top" | "bottom") =>
    total > 0 ? (
      <div
        className="lc-pager"
        style={{
          display: "flex",
          justifyContent: "center",
          flexWrap: "wrap",
          gap: 8,
          margin: position === "top" ? "0 0 12px" : "16px 0 0",
        }}
      >
        <Pagination
          current={page}
          pageSize={pageSize}
          total={total}
          // `responsive` 在窄屏自动收起页码；showTotal 只留「共 N 条」——
          // 带上「第 1-24 条」在 375px 下会折成三行，和下面的操作条挤在一起
          // （这种换行溢出检查量不出来：scrollWidth == clientWidth）
          responsive
          showSizeChanger
          pageSizeOptions={PAGE_SIZES.map(String)}
          showTotal={(t) => `共 ${t} 条`}
          onChange={(p, ps) => {
            const nextPage = ps !== pageSize ? 1 : p;
            updateParams({ page: nextPage === 1 ? null : String(nextPage), pageSize: ps === PAGE_SIZES[0] ? null : String(ps) }, false);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      </div>
    ) : null;

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>观看历史</h1>
        <span style={{ color: MUTED, fontSize: 13 }}>挑一些进收藏</span>
        <div style={{ flex: 1 }} />
        <Button
          size="small"
          icon={
            sync?.running ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />
          }
          disabled={sync?.running || syncMut.isPending}
          loading={syncMut.isPending}
          onClick={() => syncMut.mutate(false)}
        >
          {sync?.running ? "同步中…" : "同步"}
        </Button>
        <Button size="small" disabled={sync?.running || syncMut.isPending}
          onClick={() => syncMut.mutate(true)}>刷新登录并同步</Button>
        <Link to="/add">
          <Button type="primary" size="small">
            记一条
          </Button>
        </Link>
      </div>

      <p style={{ color: MUTED, fontSize: 12, margin: "0 0 10px", lineHeight: 1.8 }}>
        这些是从 B 站观看历史抓回来的<b>候选</b>，勾选后才会进收藏。
        已收藏过的也能勾 —— 那样只会把<b>这次观看的时间</b>补进那条记录里。
        <br />
        「同步」<b>只拿新的</b>：已经抓过的视频不再重复抓，我归档过、收藏过的也不会被动到。
        首次使用或登录过期时，先在本机 Chrome 登录 B 站，再点「刷新登录并同步」（可能需要允许浏览器调试）。
        想抓更早的用命令行：<span className="mono">pnpm fetch:bili --since 30d</span>
      </p>

      <SyncLine state={sync} onRetry={() => syncMut.mutate(false)} />

      {/* 页签 + 搜索 */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <Segmented
          value={status}
          onChange={(v) => updateParams({ status: v === "active" ? null : String(v) })}
          options={[
            { value: "active", label: `未归档 ${counts?.active ?? 0}` },
            { value: "pending", label: `待选 ${counts?.pending ?? 0}` },
            { value: "collected", label: `已收藏 ${counts?.collected ?? 0}` },
            { value: "archived", label: `已归档 ${counts?.archived ?? 0}` },
          ]}
        />
        <div style={{ flex: 1 }} />
        <Input.Search
          allowClear
          value={draftQ}
          placeholder="搜点什么"
          style={{ width: 190 }}
          prefix={<Search size={13} color={MUTED} />}
          onChange={(e) => {
            setDraftQ(e.target.value);
            if (!e.target.value) updateParams({ q: null });
          }}
          onSearch={(value) => updateParams({ q: value.trim() })}
        />
        <Select
          mode="multiple"
          value={fields}
          style={{ minWidth: 200 }}
          maxTagCount={1}
          // 至少留一个范围 —— 空的话服务端会回落到「只搜标题」，
          // 那和界面上显示的不一致，会让人以为搜的是全部
          onChange={(v: SearchField[]) => updateParams({ fields: v.length && v.join(",") !== "title" ? v.join(",") : null })}
          options={(Object.keys(FIELD_LABEL) as SearchField[]).map((f) => ({
            value: f,
            label: FIELD_LABEL[f],
          }))}
          placeholder="搜索范围"
        />
      </div>

      {/* 筛选 */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          padding: "8px 10px",
          marginBottom: 10,
          background: "#fff",
          border: `1px solid ${hasFilter ? `${TONE.pending.fg}66` : RULE}`,
          borderRadius: 8,
        }}
      >
        <span style={{ fontSize: 12, color: MUTED }}>筛选</span>
        <DatePicker.RangePicker
          size="small"
          value={range ? [dayjs(range[0]), dayjs(range[1])] : null}
          allowClear
          placeholder={["观看起", "观看止"]}
          style={{ width: 230 }}
          onChange={(_, strings) =>
            updateParams({ from: strings[0] || null, to: strings[1] || null })
          }
        />
        <Select
          size="small"
          allowClear
          showSearch
          value={up}
          style={{ minWidth: 150 }}
          placeholder="UP 主"
          optionFilterProp="label"
          onChange={(v) => updateParams({ up: v ?? null })}
          options={(facets?.authors ?? []).map((a) => ({
            value: a.name,
            label: `${a.name}（${a.n}）`,
          }))}
        />
        <Select
          size="small"
          allowClear
          showSearch
          value={tag}
          style={{ minWidth: 150 }}
          placeholder="话题标签"
          optionFilterProp="label"
          onChange={(v) => updateParams({ tag: v ?? null })}
          options={(facets?.tags ?? []).map((t) => ({
            value: t.name,
            label: `${t.name}（${t.n}）`,
          }))}
        />
        {hasFilter && (
          <Button
            size="small"
            type="text"
            onClick={() =>
              { setDraftQ(""); updateParams({ q: null, from: null, to: null, up: null, tag: null }); }
            }
          >
            清除{filterCount > 1 ? `（${filterCount} 项）` : ""}
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {facets?.dateFrom && (
          <span style={{ fontSize: 11, color: MUTED }}>
            候选覆盖 <span className="mono">{facets.dateFrom}</span> ~{" "}
            <span className="mono">{facets.dateTo}</span>
          </span>
        )}
      </div>

      {isLoading && <LoadingState />}
      {isError && <ErrorState error={error} onRetry={() => refetch()} />}

      {!isLoading && !isError && !videos.length && (
        <EmptyState>
          <HistoryIcon size={22} style={{ color: MUTED }} />
          <div style={{ marginTop: 8 }}>
            {status === "pending"
              ? hasFilter
                ? "当前筛选下没有候选 —— 换个条件，或者点「清除」。"
                : "候选区是空的 —— 先在命令行抓一次："
              : "这里还没有东西。"}
          </div>
          {status === "pending" && !hasFilter && (
            <div
              className="mono"
              style={{
                marginTop: 10,
                padding: "8px 12px",
                background: "#fff",
                border: `1px solid ${RULE}`,
                borderRadius: 6,
                fontSize: 12,
                display: "inline-block",
              }}
            >
              pnpm fetch:bili --since "2026-10-18 00:00:00" --until "2026-10-21 23:59:59"
            </div>
          )}
        </EmptyState>
      )}

      {videos.length > 0 && (
        <>
          {pager("top")}

          {/* 批量操作条 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              padding: "8px 12px",
              marginBottom: 10,
              background: selected.size ? TONE.settled.bg : "#fff",
              border: `1px solid ${selected.size ? `${TONE.settled.fg}55` : RULE}`,
              borderRadius: 8,
            }}
          >
            <Checkbox
              checked={allSelected}
              indeterminate={!allSelected && videos.some((v) => selected.has(v.platformItemId))}
              onChange={(e) => {
                const next = new Map(selected);
                for (const v of videos) {
                  if (e.target.checked) next.set(v.platformItemId, v.entryIds);
                  else next.delete(v.platformItemId);
                }
                setSelected(next);
              }}
            >
              全选本页
            </Checkbox>
            <span style={{ fontSize: 12, color: MUTED }}>
              已选 <b>{selected.size}</b> 条视频
              {selected.size > videos.filter((v) => selected.has(v.platformItemId)).length &&
                "（含其它页的）"}
            </span>
            <div style={{ flex: 1 }} />
            <Button
              type="primary"
              size="small"
              icon={<Plus size={13} />}
              disabled={!selected.size || busy}
              loading={importMut.isPending}
              onClick={() => importMut.mutate()}
            >
              添加到收藏{selected.size ? `（${selected.size}）` : ""}
            </Button>
            <Button
              size="small"
              icon={status === "archived" ? <RotateCcw size={13} /> : <Archive size={13} />}
              disabled={!selected.size || busy}
              loading={archiveMut.isPending}
              onClick={() => archiveMut.mutate(status !== "archived")}
            >
              {status === "archived" ? "恢复" : "归档"}
            </Button>
          </div>

          {/* 一键归档：只在「待选」里出现。它归档的是**当前筛选下的所有待选**，
              不是当前这一页 —— 文案和二次确认都把条数写出来，别让人猜。 */}
          {status === "pending" && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 10,
                fontSize: 12,
                color: MUTED,
              }}
            >
              <Popconfirm
                title={`把当前筛选下的 ${total} 条全部归档？`}
                description="之后不再出现在待选里（在「已归档」里可以恢复）。已收藏的不受影响。"
                okText="全部归档"
                okButtonProps={{ danger: true }}
                cancelText="算了"
                onConfirm={() => archiveAllMut.mutate()}
              >
                <Button size="small" danger icon={<Archive size={13} />} loading={archiveAllMut.isPending}>
                  把筛选出的 {total} 条全部归档
                </Button>
              </Popconfirm>
              <span>
                这些是<b>确定不要</b>的 —— 归档不是删除，之后能在「已归档」里找回来。
              </span>
            </div>
          )}

          {/* 卡片网格：手机上两列，桌面上按宽度自动铺 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))",
              gap: 12,
            }}
          >
            {videos.map((v) => (
              <VideoCard
                key={v.platformItemId}
                video={v}
                checked={selected.has(v.platformItemId)}
                onToggle={() => toggle(v)}
                highlight={q}
                fields={fields}
              />
            ))}
          </div>

          {pager("bottom")}
        </>
      )}
    </div>
  );
}

/** 同步的状态行：在跑就显示进度，跑完显示结果，失败就显示原因。 */
function SyncLine({ state, onRetry }: { state?: SyncState; onRetry: () => void }) {
  if (!state) return null;

  if (state.running) {
    const what =
      state.phase === "cookies"
        ? "读 cookie…"
        : state.phase === "history"
          ? `翻历史第 ${state.pages} 页（窗口内 ${state.kept} 条）`
          : state.phase === "enrich"
            ? state.enrichTotal
              ? `抓新视频的详情 ${state.enriched}/${state.enrichTotal}`
              : "抓详情…"
            : state.phase === "save"
              ? "写库…"
              : "…";
    return (
      <div style={{ fontSize: 12, color: TONE.settled.fg, marginBottom: 12 }}>
        <Loader2 size={12} className="spin" style={{ verticalAlign: -2, marginRight: 5 }} />
        同步中：{what}
        {state.since && (
          <span style={{ color: MUTED }}>
            {" "}
            （窗口 <span className="mono">{state.since}</span> 起）
          </span>
        )}
      </div>
    );
  }

  if (state.error) {
    return (
      <div
        style={{
          fontSize: 12,
          color: TONE.negative.fg,
          background: TONE.negative.bg,
          border: `1px solid ${TONE.negative.fg}33`,
          borderRadius: 6,
          padding: "8px 10px",
          marginBottom: 12,
          lineHeight: 1.8,
          whiteSpace: "pre-wrap",
        }}
      >
        <b>同步失败：</b>
        {state.error}
        <div style={{ marginTop: 6 }}>
          <Button size="small" onClick={onRetry}>
            再试一次
          </Button>
        </div>
      </div>
    );
  }

  if (state.last) {
    const { finishedAt, inserted, existing, windowFrom } = state.last;
    return (
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
        上次同步 <span className="mono">{finishedAt.slice(5, 16)}</span>
        {" · "}
        新增 <b style={{ color: inserted ? TONE.settled.fg : MUTED }}>{inserted}</b> 条
        {existing > 0 && <>（另有 {existing} 条已经在了）</>}
        {" · "}
        窗口从 <span className="mono">{windowFrom.slice(5, 10)}</span> 起
      </div>
    );
  }

  return null;
}

function VideoCard({
  video,
  checked,
  onToggle,
  highlight,
  fields,
}: {
  video: HistoryVideo;
  checked: boolean;
  onToggle: () => void;
  highlight: string;
  fields: SearchField[];
}) {
  const duration = formatDuration(video.durationSec);
  const progress = formatDuration(video.progressSec);
  const percent = video.progressSec !== null && video.durationSec !== null && video.durationSec > 0
    ? Math.min(100, Math.max(0, Math.floor(video.progressSec / video.durationSec * 100)))
    : null;
  const progressLabel = video.progressSec === null ? "进度未上报"
    : percent !== null ? `已看 ${percent}%` : `已看 ${progress ?? "0:00"}`;
  const times = video.watchedAt.map((t) => `${formatDateShort(t)} ${t.slice(11, 16)}`);
  // 命中在哪个字段 —— 搜了简介却看不出来为什么命中，是很恼人的
  const hitIn = highlight ? fields.filter((f) => matched(video, f, highlight)) : [];

  return (
    <div
      data-history-card
      onClick={onToggle}
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        border: `1px solid ${checked ? TONE.settled.fg : RULE}`,
        boxShadow: checked ? `0 0 0 1px ${TONE.settled.fg}` : undefined,
        borderRadius: 8,
        overflow: "hidden",
        cursor: "pointer",
      }}
    >
      {/* 固定 16:9；图片脱离文档流，竖图的固有高度不能反过来撑大封面。 */}
      <div data-history-cover style={{ position: "relative", aspectRatio: "16 / 9", flexShrink: 0, overflow: "hidden", background: "#f1f2f4" }}>
        <div style={{ position: "absolute", inset: 0 }}>
          <Cover src={video.coverUrl} fill radius={0} />
        </div>

        {/* ⚠️ 这一层 stopPropagation 不能省：卡片的 onClick 也是「切换勾选」，
            不拦住的话点勾选框会触发两次（onChange 一次 + 冒泡一次）= 看起来没反应 */}
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            background: "rgba(255,255,255,.92)",
            borderRadius: 6,
            padding: "1px 5px",
            lineHeight: 1,
          }}
        >
          <Checkbox checked={checked} onChange={onToggle} aria-label={`选择 ${video.title}`} />
        </div>

        {duration && (
          <span
            className="mono"
            style={{
              position: "absolute",
              right: 6,
              bottom: 6,
              background: "rgba(0,0,0,.72)",
              color: "#fff",
              fontSize: 11,
              padding: "1px 5px",
              borderRadius: 4,
            }}
          >
            {duration}
          </span>
        )}

        <span
            style={{
              position: "absolute",
              left: 6,
              bottom: 6,
              background: video.watchedToEnd ? TONE.settled.fg : "rgba(0,0,0,.72)",
              color: "#fff",
              fontSize: 10,
              padding: "1px 5px",
              borderRadius: 4,
            }}
          >
            {progressLabel}
        </span>
      </div>

      {percent !== null && (
        <div role="progressbar" aria-label="B 站观看进度" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}
          style={{ height: 3, flexShrink: 0, background: RULE }}>
          <div style={{ height: "100%", width: `${percent}%`, background: TONE.settled.fg }} />
        </div>
      )}
      <div style={{ padding: "8px 9px 9px", display: "flex", flexDirection: "column", gap: 5, flex: 1 }}>
        <div
          title={video.title}
          style={{
            color: INK,
            fontWeight: 600,
            fontSize: 13,
            lineHeight: 1.45,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            minHeight: 38,
          }}
        >
          {video.title || <span style={{ color: MUTED }}>（无标题）</span>}
        </div>

        <div
          style={{
            fontSize: 11,
            color: MUTED,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={video.author ?? ""}
        >
          {video.author || "—"}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
          {video.existingItemId ? (
            <Tooltip title="已经在收藏里了 —— 勾它只会把这次观看的时间补进去">
              <Link to={`/item/${video.existingItemId}`} onClick={(e) => e.stopPropagation()}>
                <Tag
                  icon={<CheckCircle2 size={10} style={{ verticalAlign: -1 }} />}
                  style={{
                    color: TONE.settled.fg,
                    background: TONE.settled.bg,
                    border: "none",
                    marginInlineEnd: 0,
                    fontSize: 10,
                    lineHeight: "16px",
                    padding: "0 5px",
                  }}
                >
                  已收藏
                </Tag>
              </Link>
            </Tooltip>
          ) : null}
          {/* 渠道标签先不显示：现在整页都是 B 站，24 张卡顶着 24 个「bilibili」纯占地方。
              等第二个渠道接进来再加回来 —— 那时页面本身也需要一个渠道筛选，
              标签会跟着一起长出来。`business`（直播 / 番剧 / 专栏）是另一回事，那个有信息量。 */}
          {video.business !== "archive" && (
            <Tag
              style={{
                marginInlineEnd: 0,
                fontSize: 10,
                lineHeight: "16px",
                padding: "0 5px",
              }}
            >
              {BUSINESS_LABEL[video.business] ?? video.business}
            </Tag>
          )}
          {hitIn.length > 0 && (
            <Tag
              style={{
                marginInlineEnd: 0,
                fontSize: 10,
                lineHeight: "16px",
                padding: "0 5px",
                color: MUTED,
              }}
            >
              命中{hitIn.map((f) => FIELD_LABEL[f]).join("/")}
            </Tag>
          )}
        </div>

        <div
          style={{
            marginTop: "auto",
            fontSize: 11,
            color: MUTED,
            display: "flex",
            flexDirection: "column",
            gap: 2,
            lineHeight: 1.5,
          }}
        >
          <span className="mono" style={{ color: INK }}>
            {times.length > 1 ? `${times.length} 次 · ` : ""}
            {times.join("、")}
          </span>
          <span className="mono" title="B 站最近一次观看的播放位置；不是累计观看时长">
            {video.progressSec === null ? "进度未上报" : `已看 ${progress ?? "0:00"} / ${duration ?? "时长未知"}`}
          </span>
          {video.device && <span>{video.device}</span>}
          {video.channelCode === "bilibili" && (
            <div aria-label="B 站互动状态" style={{ display: "flex", gap: 14, alignItems: "center", padding: "4px 0" }}>
              {[
                { Icon: ThumbsUp, name: "点赞", active: video.biliLiked, detail: video.biliLiked === null ? "未知" : video.biliLiked ? "已点赞" : "未点赞" },
                { Icon: Coins, name: "投币", active: video.biliCoins === null ? null : video.biliCoins > 0, detail: video.biliCoins === null ? "未知" : video.biliCoins > 0 ? `已投 ${video.biliCoins} 枚` : "未投币" },
                { Icon: Star, name: "收藏", active: video.biliFavorited, detail: video.biliFavorited === null ? "未知" : video.biliFavorited ? "已收藏" : "未收藏" },
              ].map(({ Icon, name, active, detail }) => (
                <Tooltip key={name} title={`B 站${name}：${detail}（${active === null ? "尚未获取" : "上次抓取时"}）`}>
                  <span role="img" aria-label={`B 站${name}：${detail}`} tabIndex={0}
                    style={{ display: "inline-flex", color: active ? TONE.settled.fg : MUTED, opacity: active === null ? 0.35 : 1 }}>
                    <Icon size={18} fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.22 : 1} strokeWidth={active ? 2.4 : 1.7} />
                  </span>
                </Tooltip>
              ))}
            </div>
          )}
          {video.tags.length > 0 && (
            <span
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={video.tags.join(" · ")}
            >
              {video.tags.slice(0, 4).join(" · ")}
            </span>
          )}
          <a
            href={video.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            aria-label={`打开原视频：${video.title}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 4, alignSelf: "flex-start", marginTop: 4, color: TONE.settled.fg }}
          >
            打开原视频 <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}

/** 这条记录在某个字段上有没有命中关键词（前端只用来标注「命中在哪」，判据仍在服务端）。 */
function matched(v: HistoryVideo, f: SearchField, q: string): boolean {
  const needle = q.toLowerCase();
  const hay =
    f === "title"
      ? v.title
      : f === "author"
        ? (v.author ?? "")
        : f === "summary"
          ? (v.summary ?? "")
          : v.tags.join(",");
  return hay.toLowerCase().includes(needle);
}
