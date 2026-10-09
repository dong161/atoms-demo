// 模型健康度：记录每个模型最近的成功率与耗时，用于自动挑选赛马阵容、Mike 规划/验收的候选顺序。
// 上游模型的可用性会变化（限流、地区限制、变慢），手动维护阵容跟不上；这里按实际表现动态排序。

const ALPHA = 0.4; // 指数加权：越新的表现权重越高
const COOLDOWN_MS = 20 * 60_000; // 连续失败的模型在这段时间内排到最后

export class ModelHealth {
  constructor(now = () => Date.now()) {
    this.stats = new Map();
    this.now = now;
  }

  get(model) {
    if (!this.stats.has(model)) this.stats.set(model, { ok: 0.75, ms: 60_000, streak: 0, lastFail: 0, runs: 0 });
    return this.stats.get(model);
  }

  /** ok: 是否成功；ms: 耗时（失败时也传，便于识别“慢到超时”） */
  record(model, { ok, ms = 0 }) {
    if (!model || model === 'mock') return;
    const s = this.get(model);
    s.runs += 1;
    s.ok = s.ok * (1 - ALPHA) + (ok ? 1 : 0) * ALPHA;
    if (ok) {
      s.ms = s.ms * (1 - ALPHA) + ms * ALPHA;
      s.streak = 0;
    } else {
      s.streak += 1;
      s.lastFail = this.now();
    }
  }

  /** 分数越高越优先：成功率为主，耗时为辅；最近连续失败 2 次以上的暂时排到最后 */
  score(model) {
    const s = this.get(model);
    const cooling = s.streak >= 2 && this.now() - s.lastFail < COOLDOWN_MS;
    return s.ok * 100 - s.ms / 3000 - (cooling ? 1000 : 0);
  }

  /** 按健康度排序（同分保持原配置顺序） */
  rank(models) {
    return models
      .map((m, i) => ({ m, i, s: this.score(m) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.m);
  }

  snapshot(models) {
    return models.map((m) => {
      const s = this.get(m);
      return { model: m, ok: Math.round(s.ok * 100) / 100, ms: Math.round(s.ms), streak: s.streak, runs: s.runs };
    });
  }
}
