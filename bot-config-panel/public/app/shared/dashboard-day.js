export const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

// Dashboard days follow modern Asia/Shanghai time (UTC+8).
export function dashboardDayStart(timestamp) {
  return Math.floor((timestamp + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
}

export function dashboardDayKey(dayStart) {
  return new Date(dayStart + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}
