-- 002_tags —— 标签与分类（M4）
--
-- 需求确认会：「标签和分类都想要……都要是因为不确定哪个更好；我既想简洁、又想好用。」
--
-- 这个纠结有解，不用二选一 —— **分类是标签的特例**：
--   分类 = 一个**互斥**的集合（一条记录只能属于一个）
--   标签 = 一个**可多选**的集合
-- 所以做「标签组」，组内可配单选 / 多选：
--   selection = 'single'   → UI 上就是分类（下拉单选）
--   selection = 'multiple' → UI 上就是标签（多选）
-- 一套机制同时满足两种，且**随时能把某个组从单选改成多选**（放宽约束不用改数据）。
--
-- ⚠️ 为什么不先做「纯扁平标签」：之后想加分类就得再加一套表，
--    而且「哪个标签组其实是分类」这个信息**已经在使用中丢失了**。

CREATE TABLE IF NOT EXISTS tag_groups (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(64) NOT NULL,
  selection  VARCHAR(16) NOT NULL DEFAULT 'multiple' COMMENT 'single = 分类 | multiple = 标签',
  sort_order INT         NOT NULL DEFAULT 100,
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_tag_groups_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tags (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  group_id   BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(64) NOT NULL,
  color      VARCHAR(16) NULL,
  sort_order INT         NOT NULL DEFAULT 100,
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_tags_group_name (group_id, name),
  KEY idx_tags_group (group_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS item_tags (
  item_id    BIGINT UNSIGNED NOT NULL,
  tag_id     BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (item_id, tag_id),
  KEY idx_item_tags_tag (tag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
