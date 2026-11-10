-- B 站账号互动的抓取快照。NULL = 未获取/请求失败，不能当成未操作。
-- 用一条 ALTER 原子增加三列，兼容 MySQL 5.7。
ALTER TABLE watch_history_entries
  ADD COLUMN bili_liked TINYINT(1) NULL COMMENT '抓取时是否已点赞；NULL 未知',
  ADD COLUMN bili_coins TINYINT UNSIGNED NULL COMMENT '抓取时已投币数；NULL 未知',
  ADD COLUMN bili_favorited TINYINT(1) NULL COMMENT '抓取时是否已在B站收藏；NULL 未知';
