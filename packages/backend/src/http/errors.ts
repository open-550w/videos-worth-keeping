/** 业务错误。controller 里直接 throw，由 errorHandler 收敛成统一响应。 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = status,
    /** 附带的机器可读信息（如重复收藏时的已有条目 id），前端据此做跳转。 */
    readonly data: unknown = null,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (msg: string, data?: unknown) =>
  new AppError(400, msg, 400, data ?? null);
export const notFound = (msg = "not found") => new AppError(404, msg);
export const unauthorized = (msg = "unauthorized") => new AppError(401, msg);

/**
 * 409。`data` 用来告诉前端「撞上谁了」——
 * 需求确认会：「不允许（重复收藏），这种情况弹出提示即可」，
 * 而一个只弹「已收藏过」、不给跳转的提示是没用的：用户还是得自己去翻。
 */
export const conflict = (msg: string, data?: unknown) =>
  new AppError(409, msg, 409, data ?? null);
