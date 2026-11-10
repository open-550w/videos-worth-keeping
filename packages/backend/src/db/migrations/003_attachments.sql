-- 003_attachments —— 附件：截图 + 手动备份（M2）
--
-- 需求确认会：「备份……很可能是用户手动填入备份的内容，截图、视频、录屏之类的。」
--
-- 这句话把备份从「自动抓取」变成了「手动上传」—— 于是它和附件**变成了同一件事**：
-- 截图和「我手动存下来的录屏」在上传、存储、展示上完全一样，
-- 没有理由分两张表、两套接口。原方案的 item_archives 表因此被砍掉。
--
-- 代价：**自动兜底没了**。链接烂掉时不会有系统帮你存下来，那是你要手动做的事。
-- 所以 M3 保留「探活」—— 它不存东西，但它是那个提醒你「该备份了」的信号。

CREATE TABLE IF NOT EXISTS attachments (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id          BIGINT UNSIGNED NULL,
  note_id          BIGINT UNSIGNED NULL COMMENT '挂在某条评论下；NULL = 挂在条目下',
  kind             VARCHAR(16)  NOT NULL DEFAULT 'screenshot'
                   COMMENT 'screenshot | backup_video | backup_recording | backup_image | other',
  -- ⚠️ 存 storage_key（对象键），**不存 URL**。
  -- 只存 URL 的话，从本机磁盘换到 CDN 就得改写所有历史行；
  -- 只存 key 的话，展示时由后端拼 URL，换存储是**改一个配置项**。
  storage_provider VARCHAR(32)  NOT NULL DEFAULT 'local' COMMENT 'local | oss | cos | r2',
  storage_key      VARCHAR(512) NOT NULL,
  public_url       VARCHAR(1024) NULL COMMENT '可选直链（接了 CDN 才有）',
  original_name    VARCHAR(255) NULL,
  mime_type        VARCHAR(64)  NULL,
  byte_size        BIGINT UNSIGNED NULL,
  width            INT NULL,
  height           INT NULL,
  duration_sec     INT NULL COMMENT '视频 / 录屏用',
  sha256           CHAR(64) NULL COMMENT '内容去重，同一个文件不存两份',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_att_item (item_id, kind),
  KEY idx_att_note (note_id),
  KEY idx_att_sha  (sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
