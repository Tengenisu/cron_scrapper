import { LOG_LEVEL } from "../constants.js";

/**
 * Everything logs to stderr, never stdout: stdout carries exactly one JSON
 * document so the n8n Execute Command node can parse it blind.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(LOG_LEVEL as Level) in LEVELS ? (LOG_LEVEL as Level) : "info"];

function emit(level: Level, message: string, ...rest: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString();
  console.error(`${stamp} ${level.toUpperCase().padEnd(5)} earnings: ${message}`, ...rest);
}

export const log = {
  debug: (message: string, ...rest: unknown[]) => emit("debug", message, ...rest),
  info: (message: string, ...rest: unknown[]) => emit("info", message, ...rest),
  warn: (message: string, ...rest: unknown[]) => emit("warn", message, ...rest),
  error: (message: string, ...rest: unknown[]) => emit("error", message, ...rest),
};
