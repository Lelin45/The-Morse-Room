import test from 'node:test';
import assert from 'node:assert/strict';
import {testEnv,person,api} from './helpers/chat-db.mjs';
import {hashToken} from '../server/chat/db.js';

async function fixture(){return {...testEnv(),PLAY_REVIEW_EMAIL:'review@example.invalid',PLAY_REVIEW_PASSWORD_HASH:await hashToken('fixture-review-code')};}
const login=env=>api(env,'/api/auth/reviewer',{method:'POST',body:{email:'review@example.invalid',password:'fixture-review-code'}});

test('review credentials create only seeded sandbox sessions and are never exposed in API responses',async()=>{
  const env=await fixture();
  try{
    const real=await person(env,'ordinary','play_reviewer');
    const signed=await login(env);assert.equal(signed.response.status,200);assert.equal(signed.data.user.isReviewer,true);
    assert.notEqual(signed.data.user.username,'play_reviewer');
    assert.equal(JSON.stringify(signed.data).includes('fixture-review-code'),false);
    assert.match(signed.response.headers.get('Set-Cookie'),/HttpOnly.*Secure/);
    const cookie=signed.response.headers.get('Set-Cookie').split(';')[0];
    const inbox=await api(env,'/api/inbox',{cookie});
    assert.equal(inbox.data.conversations.length,2);assert.equal(inbox.data.requests.length,1);
    const detail=await api(env,'/api/conversations/review-direct',{cookie});
    assert.equal(detail.data.messages.length,1);assert.equal(detail.data.conversation.peer.username,'review_bot');
    const profile=await api(env,'/api/profile',{method:'POST',cookie,body:{username:'claim_real_namespace'}});
    assert.equal(profile.response.status,403);
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM chat_users WHERE username='claim_real_namespace'").get().n,0);
    const ordinary=await api(env,'/api/me',{cookie:real});assert.equal(ordinary.data.user.username,'play_reviewer');
    assert.equal(Object.hasOwn(ordinary.data.user,'isReviewer'),false);
    await login(env);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_messages').get().n,2);
    assert.equal((await api(env,'/api/conversations/review-direct',{cookie:real})).response.status,404);
  }finally{env.DB.close();}
});

test('review sign-in requires configured proof and origin, throttles guesses and never seeds data on failure',async()=>{
  const env=await fixture();
  try{
    assert.equal((await api(env,'/api/auth/reviewer',{method:'POST',origin:'https://attacker.test',body:{email:env.PLAY_REVIEW_EMAIL,password:'fixture-review-code'}})).response.status,403);
    for(let attempt=0;attempt<5;attempt++)assert.equal((await api(env,'/api/auth/reviewer',{method:'POST',body:{email:env.PLAY_REVIEW_EMAIL,password:'wrong'}})).response.status,401);
    assert.equal((await login(env)).response.status,429);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_users').get().n,0);
    delete env.PLAY_REVIEW_PASSWORD_HASH;
    assert.equal((await login(env)).response.status,503);
  }finally{env.DB.close();}
});

test('a reviewer can delete and recreate the test account without altering real people or messages',async()=>{
  const env=await fixture();
  try{
    const ordinary=await person(env,'ordinary');
    const signed=await login(env),cookie=signed.response.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await api(env,'/api/account/delete',{method:'POST',cookie,body:{confirmation:'DELETE',userId:'ordinary'}})).response.status,200);
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM chat_review_users WHERE user_id='play-reviewer'").get().n,0);
    const again=await login(env);assert.equal(again.response.status,200);
    const next=again.response.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await api(env,'/api/conversations/review-group',{cookie:next})).response.status,200);
    assert.equal((await api(env,'/api/me',{cookie:ordinary})).data.user.id,'ordinary');
    assert.equal((await api(env,'/api/me',{cookie})).data.user,null);
  }finally{env.DB.close();}
});
