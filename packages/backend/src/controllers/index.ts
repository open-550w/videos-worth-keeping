import Router from "@koa/router";
import { healthController } from "./health.controller.js";
import { itemsController } from "./items.controller.js";
import { weeksController } from "./weeks.controller.js";
import { notesController } from "./notes.controller.js";
import { channelsController } from "./channels.controller.js";
import { tagsController } from "./tags.controller.js";
import { resolveController } from "./resolve.controller.js";
import { probeController } from "./probe.controller.js";
import { historyController } from "./history.controller.js";
import { attachmentsController } from "./attachments.controller.js";

export const router = new Router();

router.use("/api/health", healthController.routes(), healthController.allowedMethods());
router.use("/api/items", itemsController.routes(), itemsController.allowedMethods());
router.use("/api/weeks", weeksController.routes(), weeksController.allowedMethods());
router.use("/api/notes", notesController.routes(), notesController.allowedMethods());
router.use("/api/channels", channelsController.routes(), channelsController.allowedMethods());
router.use("/api/tags", tagsController.routes(), tagsController.allowedMethods());
router.use("/api/resolve", resolveController.routes(), resolveController.allowedMethods());
router.use("/api/probe", probeController.routes(), probeController.allowedMethods());
router.use("/api/history", historyController.routes(), historyController.allowedMethods());

// 附件 controller 里同时有 `/api/*` 和 `/uploads/*`，路径写全了，所以挂在根上。
// **放最后**：它挂在根上，放前面会先吃到别的路径。
router.use(attachmentsController.routes(), attachmentsController.allowedMethods());
