import { migrate } from "./migrate.js";
import { closePool } from "./db.js";
import { logger } from "../logger.js";

const { applied, already } = await migrate();
if (already.length) logger.info({ versions: already }, "已应用（跳过）");
if (applied.length) logger.info({ versions: applied }, "本次新应用");
else logger.info("没有待执行的迁移");
await closePool();
