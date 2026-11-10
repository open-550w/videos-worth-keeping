-- 004_url_checks —— 链接探活历史（M3）
--
-- 自动兜底砍掉之后，探活是 M3 唯一的目标：**提醒你「该备份了」**。
-- 没有它，链接烂了半年你都不会知道。
--
-- 存历史而不是只更新 item_urls.http_status 的当前值，是因为
-- 「**什么时候**开始失效的」是有用信息 —— 只存当前值就丢了趋势。

CREATE TABLE IF NOT EXISTS url_checks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_url_id BIGINT UNSIGNED NOT NULL,
  http_status INT          NULL,
  error       VARCHAR(512) NULL,
  latency_ms  INT          NULL,
  checked_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_checks_url (item_url_id, checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
