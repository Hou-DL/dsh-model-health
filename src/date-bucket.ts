const TZ = "Asia/Shanghai";

export function toDayKey(ms: number, tz = TZ): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(ms));
}

export function dayKeyToDate(key: string, _tz = TZ): Date {
  return new Date(key + "T12:00:00+08:00");
}

export function addDays(dayKey: string, n: number): string {
  const d = dayKeyToDate(dayKey);
  d.setDate(d.getDate() + n);
  return toDayKey(d.getTime());
}
