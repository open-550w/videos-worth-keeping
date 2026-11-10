import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

/** 开发时用 pino-pretty 可读，生产（或未装）时退回 JSON。 */
export const logger = pino({
  level,
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
        },
});
