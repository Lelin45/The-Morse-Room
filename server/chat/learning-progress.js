import { LEVELS } from '../../trainer.js';
import { ApiError, all, batch, rateLimit } from './db.js';

export const CURRICULUM = LEVELS.map(level => level.newCharacters).join('');

export async function readLearningProgress(user, env) {
  const rows = await all(env, 'SELECT level, best_score AS score FROM chat_lesson_progress WHERE user_id = ? AND curriculum = ? ORDER BY level', user.id, CURRICULUM);
  return { userId: user.id, curriculum: CURRICULUM, completed: rows.map(row => row.level), best: Object.fromEntries(rows.map(row => [row.level, row.score])) };
}

export async function saveLearningProgress(user, body, env) {
  if (body.curriculum !== CURRICULUM || !Array.isArray(body.completed) || body.completed.length > LEVELS.length
      || body.completed.some(level => !Number.isInteger(level) || level < 1 || level > LEVELS.length)
      || !body.best || typeof body.best !== 'object' || Array.isArray(body.best)
      || Object.keys(body.best).some(key => !/^(?:[1-9]|1[0-8])$/.test(key)
        || !Number.isInteger(body.best[key]) || body.best[key] < 0 || body.best[key] > 100)) {
    throw new ApiError(400, 'invalid_progress', 'Choose valid completed lessons and scores.');
  }
  await rateLimit(env, `progress:${user.id}`, 120, 3600);
  const now = Date.now();
  const levels = [...new Set(body.completed)];
  if (levels.length) await batch(env, levels.map(level => [
    `INSERT INTO chat_lesson_progress(user_id, curriculum, level, best_score, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, curriculum, level) DO UPDATE SET
      best_score = MAX(chat_lesson_progress.best_score, excluded.best_score), updated_at = excluded.updated_at`,
    user.id, CURRICULUM, level, body.best[level] || 0, now, now,
  ]));
  return readLearningProgress(user, env);
}
