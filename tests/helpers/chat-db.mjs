import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createSession } from '../../server/chat/auth.js';
import { handleChatRequest } from '../../server/chat/api.js';

export class SQLiteD1 {
  constructor(migrate = true) {
    this.sqlite = new DatabaseSync(':memory:');
    if (migrate) {
      const directory = new URL('../../migrations/', import.meta.url);
      for (const filename of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
        this.sqlite.exec(readFileSync(new URL(filename, directory), 'utf8'));
      }
    }
  }

  prepare(sql) {
    const prepared = this.sqlite.prepare(sql);
    let values = [];
    return {
      bind(...bindings) { values = bindings; return this; },
      async first(column) {
        const row = prepared.get(...values);
        return column ? row?.[column] ?? null : row ? { ...row } : null;
      },
      async all() { return { success: true, results: prepared.all(...values).map((row) => ({ ...row })) }; },
      async run() {
        const result = prepared.run(...values);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) }, results: [] };
      },
    };
  }

  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  close() { this.sqlite.close(); }
}

export function testEnv(migrate = true) {
  return { DB: new SQLiteD1(migrate), SITE_URL: 'https://morse.test',
    GOOGLE_CLIENT_ID: 'test-google-client', GOOGLE_CLIENT_SECRET: 'test-google-secret' };
}

export async function person(env, id, username = id, email = `${id}@example.com`) {
  env.DB.sqlite.prepare('INSERT INTO chat_users(id, username, email, created_at) VALUES (?, ?, ?, ?)').run(id, username, email, Date.now());
  return (await createSession(id, env)).split(';')[0];
}

export async function api(env, path, { method = 'GET', body, cookie, origin = env.SITE_URL } = {}) {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (method === 'POST' && origin !== null) headers.set('Origin', origin);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(new URL(path, env.SITE_URL), {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const response = await handleChatRequest(request, env);
  return { response, data: await response.json() };
}

export async function friends(env, aliceCookie, bobCookie, target = 'bob') {
  const request = await api(env, '/api/friends/request', { method: 'POST', cookie: aliceCookie, body: { target } });
  if (request.response.status !== 200) throw new Error(JSON.stringify(request.data));
  const inbox = await api(env, '/api/inbox', { cookie: bobCookie });
  const accepted = await api(env, '/api/friends/respond', { method: 'POST', cookie: bobCookie, body: { id: inbox.data.requests[0].id, accept: true } });
  if (accepted.response.status !== 200) throw new Error(JSON.stringify(accepted.data));
  return accepted.data.conversation.id;
}
