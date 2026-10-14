const accountId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;

export function normalizeProgress(value) {
  const completed = [...new Set(Array.isArray(value?.completed) ? value.completed.filter(level => Number.isInteger(level) && level >= 1 && level <= 18) : [])].sort((a, b) => a - b);
  const best = Object.fromEntries(completed.map(level => [level, Math.min(100, Math.max(0, Math.round(Number(value?.best?.[level]) || 0)))]));
  return { completed, best };
}

export function mergeProgress(...values) {
  const result = { completed: [], best: {} };
  for (const value of values) {
    const progress = normalizeProgress(value);
    for (const level of progress.completed) {
      if (!result.completed.includes(level)) result.completed.push(level);
      result.best[level] = Math.max(result.best[level] || 0, progress.best[level]);
    }
  }
  result.completed.sort((a, b) => a - b);
  return result;
}

export class LearningProgressSync {
  constructor({ curriculum, storage, fetcher = fetch, onChange = () => {}, onStatus = () => {} }) {
    this.curriculum = curriculum;
    this.storage = storage;
    this.fetcher = fetcher;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.base = `morse-room-progress:${curriculum}`;
    this.userId = accountId(this.read(`${this.base}:account`, null));
    this.progress = normalizeProgress(this.read(this.key(), {}));
    this.revision = 0;
    this.pending = null;
    this.dirty = false;
    this.status = this.userId ? 'offline' : 'local';
  }
  read(key, fallback) { try { return JSON.parse(this.storage.getItem(key)) ?? fallback; } catch { return fallback; } }
  write(key, value) { try { this.storage.setItem(key, JSON.stringify(value)); } catch { /* Offline practice also works without device storage. */ } }
  key() { return this.userId ? `${this.base}:user:${this.userId}` : this.base; }
  setStatus(value) { this.status = value; this.onStatus(value); }
  apply(value, switched = false) {
    const next = normalizeProgress(value);
    const changed = JSON.stringify(next) !== JSON.stringify(this.progress);
    Object.assign(this.progress, next);
    this.write(this.key(), this.progress);
    if (changed || switched) this.onChange(this.progress, switched);
  }
  setAccount(id) {
    const selected = accountId(id);
    if (selected !== this.userId) {
      const guest = this.userId === null ? normalizeProgress(this.progress) : null;
      this.write(this.key(), this.progress);
      this.revision += 1;
      this.userId = selected;
      this.pending = null;
      this.dirty = false;
      this.write(`${this.base}:account`, selected);
      const saved = this.read(this.key(), {});
      this.apply(selected && guest ? mergeProgress(saved, guest) : saved, true);
      // Once guest work belongs to an account, another account must not inherit it.
      if (selected && guest) this.write(this.base, { completed: [], best: {} });
    }
    this.setStatus(selected ? 'syncing' : 'local');
    return this.sync();
  }
  save() {
    this.apply(this.progress);
    this.dirty = true;
    return this.sync();
  }
  sync() {
    if (!this.userId) { this.setStatus('local'); return Promise.resolve(); }
    if (this.pending) { this.dirty = true; return this.pending; }
    const userId = this.userId;
    const revision = this.revision;
    const valid = () => this.userId === userId && this.revision === revision;
    const request = async body => {
      const response = await this.fetcher('/api/learning-progress', {
        method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', 'X-Morse-Account': userId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body), keepalive: true } : {}),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Learning progress could not sync.');
      const result = await response.json();
      if (result.curriculum !== this.curriculum || result.userId !== userId) throw new Error('Lesson account or sequence changed.');
      return normalizeProgress(result);
    };
    this.setStatus('syncing');
    const task = (async () => {
      try {
        const remote = await request();
        if (!valid()) return;
        this.apply(mergeProgress(this.progress, remote));
        if (JSON.stringify(remote) !== JSON.stringify(this.progress)) {
          this.dirty = false;
          const saved = await request({ curriculum: this.curriculum, ...normalizeProgress(this.progress) });
          if (!valid()) return;
          this.apply(mergeProgress(this.progress, saved));
        } else this.dirty = false;
        if (valid()) this.setStatus('saved');
      } catch { if (valid()) this.setStatus('offline'); }
      finally {
        if (valid()) {
          this.pending = null;
          if (this.dirty && this.status === 'saved') { this.dirty = false; void this.sync(); }
        }
      }
    })();
    this.pending = task;
    return task;
  }
}
