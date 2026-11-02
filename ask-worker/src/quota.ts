import { DurableObject } from "cloudflare:workers";
import {
  BURST_MAX,
  BURST_WINDOW_MS,
  DAILY_LIMIT,
  currentDayKey,
  nextResetAt,
} from "./day";
import type { Env, QuotaState } from "./types";

export type ConsumeResult =
  | { ok: true; state: QuotaState }
  | { ok: false; code: "daily_limit" | "too_fast"; state: QuotaState };

export class QuotaCounter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS recent (
        ts INTEGER NOT NULL
      );
    `);
  }

  private getDayCount(day: string): number {
    const row = this.ctx.storage.sql
      .exec("SELECT value FROM meta WHERE key = ?", `count:${day}`)
      .toArray()[0] as { value: string } | undefined;
    return row ? Number(row.value) || 0 : 0;
  }

  private setDayCount(day: string, count: number): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
      `count:${day}`,
      String(count),
    );
  }

  private pruneRecent(now: number): number[] {
    this.ctx.storage.sql.exec("DELETE FROM recent WHERE ts < ?", now - BURST_WINDOW_MS);
    return this.ctx.storage.sql
      .exec("SELECT ts FROM recent ORDER BY ts ASC")
      .toArray()
      .map((r) => Number((r as { ts: number }).ts));
  }

  private buildState(day: string, count: number, now = new Date()): QuotaState {
    return {
      remaining: Math.max(0, DAILY_LIMIT - count),
      count,
      day,
      resetAt: nextResetAt(now),
    };
  }

  async getQuota(nowIso?: string): Promise<QuotaState> {
    const now = nowIso ? new Date(nowIso) : new Date();
    const day = currentDayKey(now);
    const count = this.getDayCount(day);
    return this.buildState(day, count, now);
  }

  async consume(nowIso?: string): Promise<ConsumeResult> {
    const now = nowIso ? new Date(nowIso) : new Date();
    const day = currentDayKey(now);
    const count = this.getDayCount(day);
    const state = this.buildState(day, count, now);

    if (count >= DAILY_LIMIT) {
      return { ok: false, code: "daily_limit", state };
    }

    const ts = now.getTime();
    const recent = this.pruneRecent(ts);
    if (recent.length >= BURST_MAX) {
      return { ok: false, code: "too_fast", state };
    }

    this.ctx.storage.sql.exec("INSERT INTO recent (ts) VALUES (?)", ts);
    const next = count + 1;
    this.setDayCount(day, next);
    return { ok: true, state: this.buildState(day, next, now) };
  }

  async refund(nowIso?: string): Promise<QuotaState> {
    const now = nowIso ? new Date(nowIso) : new Date();
    const day = currentDayKey(now);
    const count = this.getDayCount(day);
    const next = Math.max(0, count - 1);
    this.setDayCount(day, next);
    // 也刪掉最近一次 recent，避免 refund 後仍被 burst 卡住
    const last = this.ctx.storage.sql
      .exec("SELECT rowid AS id FROM recent ORDER BY ts DESC LIMIT 1")
      .toArray()[0] as { id: number } | undefined;
    if (last) {
      this.ctx.storage.sql.exec("DELETE FROM recent WHERE rowid = ?", last.id);
    }
    return this.buildState(day, next, now);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const nowIso = url.searchParams.get("now") || undefined;
    if (url.pathname === "/quota" && request.method === "GET") {
      return Response.json(await this.getQuota(nowIso));
    }
    if (url.pathname === "/consume" && request.method === "POST") {
      return Response.json(await this.consume(nowIso));
    }
    if (url.pathname === "/refund" && request.method === "POST") {
      return Response.json(await this.refund(nowIso));
    }
    return new Response("Not found", { status: 404 });
  }
}
