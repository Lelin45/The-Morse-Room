import test from 'node:test';
import assert from 'node:assert/strict';
import {testEnv,person,api} from './helpers/chat-db.mjs';
import {startOAuth,sessionUser} from '../server/chat/auth.js';
import {makeMobileRedirect} from '../server/chat/mobile-auth.js';
import {hashToken,randomToken} from '../server/chat/db.js';
import {base64url} from '../server/chat/db.js';
import {handleChatRequest} from '../server/chat/api.js';

async function providerFixture(env,query){
  const start=await startOAuth('google',new Request(`${env.SITE_URL}/api/auth/google${query}`),env);
  const authorization=new URL(start.headers.get('Location'));
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const kid=crypto.randomUUID();
  const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid,alg:'RS256',use:'sig'};
  const encode=value=>base64url(new TextEncoder().encode(JSON.stringify(value)));
  const now=Math.floor(Date.now()/1000);
  const unsigned=`${encode({alg:'RS256',kid})}.${encode({iss:'https://accounts.google.com',aud:env.GOOGLE_CLIENT_ID,
    sub:crypto.randomUUID(),exp:now+3600,iat:now,nonce:authorization.searchParams.get('nonce')})}`;
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(unsigned));
  const token=unsigned+'.'+base64url(signature);
  const fetcher=async url=>{
    if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({id_token:token});
    if(String(url)==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[jwk]});
    throw new Error('Unexpected provider endpoint.');
  };
  const params=new URLSearchParams({state:authorization.searchParams.get('state'),code:'provider-test-code'});
  return {request:new Request(`${env.SITE_URL}/api/auth/google/callback?${params}`,
    {headers:{Cookie:start.headers.get('Set-Cookie').split(';')[0]}}),fetcher};
}

test('mobile login keeps the website Google callback and stores app proof separately from provider PKCE',async()=>{
  const env=testEnv();
  try {
    const verifier=randomToken(),state=randomToken();
    const challenge=await hashToken(verifier);
    const response=await startOAuth('google',new Request(`${env.SITE_URL}/api/auth/google?mobile_challenge=${challenge}&mobile_state=${state}`),env);
    const redirect=new URL(response.headers.get('Location'));
    assert.equal(redirect.searchParams.get('redirect_uri'),env.SITE_URL+'/api/auth/google/callback');
    assert.notEqual(redirect.searchParams.get('code_challenge'),challenge);
    const pending=env.DB.sqlite.prepare('SELECT * FROM chat_oauth_states').get();
    assert.equal(pending.mobile_challenge,challenge);assert.equal(pending.mobile_state,state);
    for(const query of ['mobile_challenge=bad','mobile_state='+state,'mobile_challenge='+challenge+'&mobile_state=bad']){
      await assert.rejects(startOAuth('google',new Request(`${env.SITE_URL}/api/auth/google?${query}`),env),error=>error.code==='invalid_mobile_request');
    }
    await startOAuth('google',new Request(`${env.SITE_URL}/api/auth/google?return=delete-account`),env);
    assert.equal(env.DB.sqlite.prepare("SELECT return_path FROM chat_oauth_states WHERE return_path IS NOT NULL").get().return_path,'/delete-account.html');
    await startOAuth('google',new Request(`${env.SITE_URL}/api/auth/google?return=https://attacker.test`),env);
    assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) n FROM chat_oauth_states WHERE return_path='https://attacker.test'").get().n,0);
  } finally{env.DB.close();}
});

test('app handoff is hashed, expires in two minutes and creates a secure cookie only after the correct one-use proof',async()=>{
  const env=testEnv();
  try {
    await person(env,'alice');
    env.DB.sqlite.exec('DELETE FROM chat_sessions');
    const verifier=randomToken(),state=randomToken();
    const redirect=await makeMobileRedirect({id:'alice'},{challenge:await hashToken(verifier),state},env);
    const location=new URL(redirect.headers.get('Location'));
    assert.equal(location.origin,'null');assert.equal(location.protocol,'morsenepal:');assert.equal(location.hostname,'auth');
    assert.equal(location.searchParams.get('state'),state);assert.equal(location.searchParams.has('session'),false);
    assert.match(redirect.headers.get('Set-Cookie'),/__Host-morse_oauth_google=;.*Max-Age=0/);
    const code=location.searchParams.get('code');
    const saved=env.DB.sqlite.prepare('SELECT * FROM chat_mobile_codes').get();
    assert.equal(saved.token_hash,await hashToken(code));assert.notEqual(saved.token_hash,code);
    assert.ok(saved.expires_at>Date.now()+115_000&&saved.expires_at<=Date.now()+120_000);
    const wrong=await api(env,'/api/auth/mobile/finish',{method:'POST',body:{code,verifier:randomToken()}});
    assert.equal(wrong.response.status,400);assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_mobile_codes').get().n,1);
    const cross=await api(env,'/api/auth/mobile/finish',{method:'POST',body:{code,verifier},origin:'https://attacker.test'});
    assert.equal(cross.response.status,403);assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_mobile_codes').get().n,1);
    const valid=await api(env,'/api/auth/mobile/finish',{method:'POST',body:{code,verifier}});
    assert.equal(valid.response.status,200);assert.equal(valid.data.user.id,'alice');
    assert.match(valid.response.headers.get('Set-Cookie'),/__Host-morse_session=.*HttpOnly; SameSite=Lax; Max-Age=2592000; Secure/);
    assert.equal(Object.keys(valid.data).includes('token'),false);
    const cookie=valid.response.headers.get('Set-Cookie').split(';')[0];
    assert.equal((await sessionUser(new Request(env.SITE_URL,{headers:{Cookie:cookie}}),env)).id,'alice');
    assert.equal((await api(env,'/api/auth/mobile/finish',{method:'POST',body:{code,verifier}})).response.status,400);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_sessions').get().n,1);
  } finally{env.DB.close();}
});

test('expired app handoffs and malformed proofs do not install a session',async()=>{
  const env=testEnv();
  try{
    await person(env,'alice');env.DB.sqlite.exec('DELETE FROM chat_sessions');
    const verifier=randomToken();
    const redirect=await makeMobileRedirect({id:'alice'},{challenge:await hashToken(verifier),state:randomToken()},env);
    const code=new URL(redirect.headers.get('Location')).searchParams.get('code');
    env.DB.sqlite.exec('UPDATE chat_mobile_codes SET expires_at=1');
    assert.equal((await api(env,'/api/auth/mobile/finish',{method:'POST',body:{code,verifier}})).response.status,400);
    assert.equal((await api(env,'/api/auth/mobile/finish',{method:'POST',body:{code:'bad',verifier}})).response.status,400);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_sessions').get().n,0);
    await assert.rejects(makeMobileRedirect({id:'alice'},{challenge:'bad',state:randomToken()},env),error=>error.code==='invalid_mobile_request');
  }finally{env.DB.close();}
});

test('the complete Google callback returns a verified mobile user with a bound handoff, without a browser session',async()=>{
  const env=testEnv(),original=globalThis.fetch;
  try{
    const verifier=randomToken(),state=randomToken();
    const fixture=await providerFixture(env,`?mobile_challenge=${await hashToken(verifier)}&mobile_state=${state}`);
    globalThis.fetch=fixture.fetcher;
    const returned=await handleChatRequest(fixture.request,env);
    assert.equal(returned.status,303);
    const target=new URL(returned.headers.get('Location'));
    assert.equal(target.protocol,'morsenepal:');assert.equal(target.searchParams.get('state'),state);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_users').get().n,1);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_sessions').get().n,0);
    const finished=await api(env,'/api/auth/mobile/finish',{method:'POST',body:{code:target.searchParams.get('code'),verifier}});
    assert.equal(finished.response.status,200);
  }finally{globalThis.fetch=original;env.DB.close();}
});

test('a database failure after verified Google sign-in returns a safe native error with the original app state',async()=>{
  const env=testEnv(),original=globalThis.fetch;
  try{
    const state=randomToken();
    const fixture=await providerFixture(env,`?mobile_challenge=${await hashToken(randomToken())}&mobile_state=${state}`);
    globalThis.fetch=fixture.fetcher;
    env.DB.batch=async()=>{throw new Error('Injected database failure');};
    const response=await handleChatRequest(fixture.request,env),target=new URL(response.headers.get('Location'));
    assert.equal(target.protocol,'morsenepal:');assert.equal(target.hostname,'auth');
    assert.equal(target.searchParams.get('state'),state);assert.equal(target.searchParams.get('error'),'sign_in_not_completed');
    assert.equal(target.searchParams.has('code'),false);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_sessions').get().n,0);
  }finally{globalThis.fetch=original;env.DB.close();}
});

test('the public deletion sign-in returns to its allowlisted form and keeps the normal website session',async()=>{
  const env=testEnv(),original=globalThis.fetch;
  try{
    const fixture=await providerFixture(env,'?return=delete-account');globalThis.fetch=fixture.fetcher;
    const response=await handleChatRequest(fixture.request,env);
    assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/delete-account.html');
    assert.match(response.headers.get('Set-Cookie'),/__Host-morse_session=/);
    assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) n FROM chat_mobile_codes').get().n,0);
  }finally{globalThis.fetch=original;env.DB.close();}
});
