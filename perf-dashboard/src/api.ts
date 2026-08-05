import type { Metric, MetricSummary, PageStat, Timeseries } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const MESSAGES: Record<number, string> = {
  400: "查询参数不对",
  500: "查询服务出错了，请稍后再试",
  502: "查询服务暂时不可用",
  503: "查询服务暂时不可用",
};

function baseUrl(): string {
  return import.meta.env.VITE_PERF_API_URL ?? "";
}

async function getJSON<T>(path: string, params: Record<string, string>): Promise<T> {
  const query = new URLSearchParams(
    // An empty page means "all pages"; sending it as page= would filter on
    // the empty string and always come back with nothing.
    Object.entries(params).filter(([, value]) => value !== ""),
  );

  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}?${query}`);
  } catch {
    throw new ApiError("网络连接失败，请检查网络后重试", null);
  }

  if (!response.ok) {
    throw new ApiError(MESSAGES[response.status] ?? `请求失败（${response.status}）`, response.status);
  }
  return (await response.json()) as T;
}

export interface Filters {
  site: string;
  page: string;
  range: string;
}

export function fetchSites(): Promise<{ sites: string[] }> {
  return getJSON<{ sites: string[] }>("/api/sites", {});
}

export function fetchPages(site: string): Promise<{ pages: string[] }> {
  return getJSON<{ pages: string[] }>("/api/pages", { site });
}

export function fetchSummary(filters: Filters): Promise<{ metrics: MetricSummary[] }> {
  return getJSON<{ metrics: MetricSummary[] }>("/api/summary", {
    site: filters.site,
    page: filters.page,
    range: filters.range,
  });
}

export function fetchTimeseries(filters: Filters, metric: Metric): Promise<Timeseries> {
  return getJSON<Timeseries>("/api/timeseries", {
    site: filters.site,
    page: filters.page,
    range: filters.range,
    metric,
  });
}

export function fetchBreakdown(filters: Filters, metric: Metric): Promise<{ pages: PageStat[] }> {
  return getJSON<{ pages: PageStat[] }>("/api/breakdown", {
    site: filters.site,
    range: filters.range,
    metric,
  });
}
