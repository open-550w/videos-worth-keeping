-- 001_init —— Likes Collector 初始表结构（MySQL 5.7）
--
-- 全部 DDL 写成 IF NOT EXISTS：MySQL 的 DDL 不是事务性的，一个迁移文件跑到一半失败，
-- 前面几条已生效而版本没记上，重跑会撞「表已存在」。写成幂等的，重跑就安全。
--
-- 5.7 的硬约束（都在真库上实测过，详见 docs/init/02_DATA_MODEL.md §0）：
--   · 无 CTE / 窗口函数
--   · 无 utf8mb4_0900_ai_ci（8.0 才有）→ 用 utf8mb4_unicode_ci
--   · JSON 列不能有默认值
--   · 索引键上限 3072 字节 → VARCHAR(2048) 的 URL 不能直接建唯一索引

-- ============ 渠道 ============
-- 「以后可能会有更多」→ 渠道是数据不是枚举：加渠道 = 插一行，不改 schema、不发版。
CREATE TABLE IF NOT EXISTS channels (
  code                 VARCHAR(32)  NOT NULL COMMENT 'hongguo/bilibili/zhihu/xhs/weread/manual',
  name                 VARCHAR(64)  NOT NULL COMMENT '展示名',
  default_content_type VARCHAR(16)  NOT NULL DEFAULT 'video'
                       COMMENT '录入时的预填提示，不是约束',
  url_pattern          VARCHAR(255) NULL COMMENT '识别用域名，如 hongguoduanju.com',
  sort_order           INT          NOT NULL DEFAULT 100,
  enabled              TINYINT(1)   NOT NULL DEFAULT 1,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO channels (code, name, default_content_type, url_pattern, sort_order) VALUES
  ('hongguo',  '红果',      'video', 'hongguoduanju.com', 10),
  ('bilibili', 'Bilibili',  'video', 'bilibili.com',      20),
  ('zhihu',    '知乎',      'note',  'zhihu.com',         30),
  ('xhs',      '小红书',    'note',  'xiaohongshu.com',   40),
  ('weread',   '微信读书',  'book',  'weread.qq.com',     50),
  ('manual',   '手动录入',  'video', NULL,                99);

-- ============ 条目（中心表）============
CREATE TABLE IF NOT EXISTS items (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_type     VARCHAR(16)   NOT NULL DEFAULT 'video' COMMENT 'video | note | book',
  channel_code     VARCHAR(32)   NULL COMMENT '来源渠道；NULL = 未知',
  title            VARCHAR(512)  NOT NULL DEFAULT '',
  author           VARCHAR(255)  NULL COMMENT 'UP 主 / 作者 / 出版社',
  platform_item_id VARCHAR(128)  NULL
                   COMMENT '平台内稳定 ID。红果 series_id 是 19 位数字，超过 JS 安全整数范围，一律当字符串处理',
  cover_url        VARCHAR(1024) NULL,
  summary          TEXT          NULL COMMENT '简介 / 剧情',
  duration_sec     INT           NULL COMMENT '视频时长；非视频为 NULL',
  published_on     DATE          NULL COMMENT '平台发布时间（知道时）',
  collected_on     DATE          NOT NULL COMMENT '我收藏的日期 —— 周视图的唯一真源',
  -- ISO 周由 collected_on 派生。保留它和「周是不是实体」无关：
  --   ① 把 ISO 跨年陷阱固定在数据库一处（YEARWEEK('2027-01-01',3)=202653，属于 2026-W53，
  --      而 YEAR()=2027 —— 用日历年拼会得到一个不存在的周）
  --   ② 让「按周分组」能走索引（5.7 不能给表达式建索引）
  -- API 不暴露它，见 docs/init/03_TECH_STACK.md §8.2
  week_key         VARCHAR(8)    AS (
                     CONCAT(LEFT(YEARWEEK(collected_on,3),4), '-W',
                            LPAD(MOD(YEARWEEK(collected_on,3),100),2,'0'))
                   ) STORED,
  meta_json        JSON          NULL COMMENT '类型特有字段（ISBN / 页数…），不进索引',
  deleted_at       DATETIME      NULL COMMENT '软删；NULL = 未删',
  created_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- 同一渠道同一平台内容只收藏一次。MySQL 唯一索引允许多个 NULL，
  -- 所以没有 platform_item_id 的手动录入不受限。
  UNIQUE KEY uk_items_platform (channel_code, platform_item_id),
  KEY idx_items_week    (week_key, collected_on, id),
  KEY idx_items_channel (channel_code, collected_on),
  KEY idx_items_type    (content_type, collected_on),
  KEY idx_items_deleted (deleted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============ 链接 ============
-- 一个条目可以有多个 URL（分享链 / 网页链 / 镜像），且 URL 可能不存在
-- —— 所以它不能是主键，只能是一对多的子表。
CREATE TABLE IF NOT EXISTS item_urls (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id     BIGINT UNSIGNED NOT NULL,
  url         VARCHAR(2048)   NOT NULL,
  -- URL 太长建不了唯一索引（实测 ER_TOO_LONG_KEY，上限 3072 字节）。
  -- 存 SHA-256(规范化后的 url) 的十六进制，在它上面建唯一索引。
  -- ⚠️ 哈希前必须先规范化，否则 ?utm_source= / 末尾斜杠 / http vs https
  --    会让同一条内容哈希出不同的值，去重形同虚设。见 util/url.ts
  url_hash    CHAR(64)        NOT NULL,
  url_type    VARCHAR(16)     NOT NULL DEFAULT 'canonical'
              COMMENT 'canonical | share | mirror',
  is_primary  TINYINT(1)      NOT NULL DEFAULT 0,
  http_status INT             NULL COMMENT '最近一次探活状态码（M3）',
  checked_at  DATETIME        NULL,
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_url_hash (url_hash),
  KEY idx_urls_item (item_id, is_primary)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============ 我的评论 ============
CREATE TABLE IF NOT EXISTS item_notes (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id    BIGINT UNSIGNED NOT NULL,
  body       TEXT     NOT NULL,
  rating     TINYINT  NULL COMMENT '1-5，可选',
  -- 两个时间戳，别混：
  --   noted_at   = 我写这条评论的时间（事实），补录时可改
  --   created_at = 这行写进数据库的时间（系统），不可改
  -- 只留一个的话，要么补录的评论跑到错误的周，要么丢掉「我什么时候真的记的」。
  noted_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notes_item (item_id, noted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
