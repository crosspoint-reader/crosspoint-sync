import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { importBookorbitStats } from '../src/connectors/bookorbit-stats.js';
import { bookorbitDestination } from '../src/models/reading-sessions.js';
import { readBookorbitStats } from '../src/models/bookorbit-stats.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { upsertAccount, saveMatch, deleteAccount } from '../src/connectors/store.js';
import type { HttpTransport } from '../src/connectors/types.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY='c'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });
const record = { session_id:'session1', document:DOC, started_at:1609502400, ended_at:1609503000, seconds:600, utc_offset_minutes:0 };
const cred = { server:'https://orbit.example', username:'reader', password:'secret' };
async function fixture(autoSync = false) {
  const {app,db}=makeTestApp({}, { connectorTransport: (url, init) => http(url, init) }); const user=await registerUser(app);
  const id=(db.prepare('SELECT id FROM users WHERE username=?').get(user.username) as any).id;
  upsertAccount(db,id,'bookorbit',cred,'reader');
  saveMatch(db,id,'bookorbit',DOC,{externalId:'7',externalEdition:'9',confidence:1},'manual');
  const submit=async(items:unknown[]=[record], device='reader1')=>{
    // Export round-trip tests drive reconciliation explicitly.
    if (!autoSync) db.prepare('UPDATE connector_accounts SET enabled=0 WHERE user_id=?').run(id);
    const response=await app.request('/api/v1/stats/sessions',{
      method:'PUT',headers:user.headers,body:JSON.stringify({device_id:device,items}) });
    if (!autoSync) db.prepare('UPDATE connector_accounts SET enabled=1 WHERE user_id=?').run(id);
    return response;
  };
  const remote:any[]=[];const saved=new Map<string,number>();const posts:any[]=[];
  let lost=false; let brokenList=false; let ambiguous=false;
  const http:HttpTransport=async(url,init)=>{
    const u=new URL(url);const reply=(body:unknown,status=200)=>({status,json:async()=>body,text:async()=>JSON.stringify(body)});
    if(u.pathname.endsWith('/auth/login'))return reply({accessToken:'token'});
    if(u.pathname.endsWith('/auth/me'))return reply({settings:{timezone:'UTC'}});
    if(init.method==='POST' && u.pathname.endsWith('/sessions')){
      const body=JSON.parse(init.body as string);posts.push(body);
      if(!saved.has(body.sessionId)){
        const id=remote.length+1; saved.set(body.sessionId,id);
        remote.push({id,bookFileId:9,source:'web',...body});
        if(ambiguous) remote.push({...remote.at(-1),id:id+1});
      }
      else {
        const row=remote.find(s=>s.id===saved.get(body.sessionId));
        if(body.durationSeconds>row.durationSeconds) Object.assign(row,body);
      }
      if(lost){lost=false;throw new Error('lost POST response');}
      return reply(null,204);
    }
    if(u.pathname.endsWith('/sessions')){
      if(brokenList)throw new Error('offline');
      const page=Number(u.searchParams.get('page'));const from=u.searchParams.get('dateFrom');const to=u.searchParams.get('dateTo');
      const rows=remote.filter(s=>(!from||s.startedAt>=from)&&(!to||s.startedAt<=to));
      return reply({items:rows.slice((page-1)*100,page*100),total:rows.length,page,pageSize:100});
    }
    throw new Error(`Unexpected ${init.method} ${url}`);
  };
  return {app,db,user,id,submit,remote,posts,http,setLost:()=>{lost=true;},setBroken:(v:boolean)=>{brokenList=v;},setAmbiguous:()=>{ambiguous=true;}};
}

describe('device session ingestion',()=>{
  it('delivers uploaded sessions without a periodic poll',async()=>{
    const f=await fixture(true); await f.submit();
    await importBookorbitStats(f.db,f.id,f.http); // await the already-started job
    expect(f.posts).toHaveLength(1);
  });
  it('delivers an uploaded batch larger than the old periodic worker limit',async()=>{
    const f=await fixture(true);
    await f.submit(Array.from({length:8},(_,i)=>({...record,session_id:`batch${i}`,
      started_at:record.started_at+i*1000,ended_at:record.ended_at+i*1000})));
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.posts).toHaveLength(8);
  });
  it('acknowledges stable IDs, retries safely, and leaves all legacy counters untouched',async()=>{
    const f=await fixture();
    expect(await (await f.submit()).json()).toMatchObject({accepted_session_ids:['session1']});
    expect((await f.submit()).status).toBe(200);
    expect((f.db.prepare('SELECT COUNT(*) n FROM reading_sessions').get() as any).n).toBe(1);
    expect((await f.submit([{...record,seconds:500}])).status).toBe(200);
    const moved=await f.submit([{...record,document:'b'.repeat(32)}]);
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({accepted_session_ids:['session1'],refused:[{session_id:'session1',reason:'conflict'}]});
    expect((f.db.prepare('SELECT document FROM reading_sessions').get() as any).document).toBe(record.document);
    expect((f.db.prepare('SELECT COUNT(*) n FROM stats_device_global').get() as any).n).toBe(0);
    expect((f.db.prepare('SELECT COUNT(*) n FROM stats_device_book').get() as any).n).toBe(0);
    expect((f.db.prepare('SELECT COUNT(*) n FROM stats_device_day').get() as any).n).toBe(0);
  });
  it('clears sessions and export state when clearing account data',async()=>{
    const f=await fixture();await f.submit();await importBookorbitStats(f.db,f.id,f.http);
    expect((await f.app.request('/api/v1/account/data',{method:'DELETE',headers:f.user.headers})).status).toBe(200);
    for(const table of ['reading_sessions','bookorbit_session_exports','bookorbit_session_destination'])
      expect((f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as any).n).toBe(0);
    expect((f.db.prepare('SELECT COUNT(*) n FROM users').get() as any).n).toBe(1);
  });
  it('stores the good sessions of a batch and acknowledges the ones it refuses',async()=>{
    const f=await fixture();
    const now=Math.floor(Date.now()/1000);
    const good=(i:number)=>({...record,session_id:`good${i}`,started_at:record.started_at+i*1000,ended_at:record.ended_at+i*1000});
    const bad=[{...record,session_id:'long',seconds:601},{...record,session_id:'ended',ended_at:0},
      {...record,session_id:'zone',utc_offset_minutes:999},{...record,session_id:'ahead',started_at:now+3000,ended_at:now+3600}];
    const res=await f.submit([good(1),...bad,good(2),{...record,session_id:'bad/id'}]);
    expect(res.status).toBe(200);
    const body=await res.json();
    expect(body.accepted_session_ids).toEqual(['good1','long','ended','zone','ahead','good2']);
    expect(body.refused).toEqual([{session_id:'long',reason:'invalid'},{session_id:'ended',reason:'invalid'},
      {session_id:'zone',reason:'invalid'},{session_id:'ahead',reason:'future'}]);
    expect((f.db.prepare('SELECT session_id FROM reading_sessions ORDER BY session_id').all() as any[]).map((r)=>r.session_id))
      .toEqual(['good1','good2']);
  });
  it('lets later sessions through once an earlier session ID conflicts',async()=>{
    // The reader resends its oldest unacknowledged sessions first, so a refused session that is not
    // acknowledged would block every session after it.
    const f=await fixture(); await f.submit();
    const later={...record,session_id:'session2',started_at:record.started_at+5000,ended_at:record.ended_at+5000};
    const res=await f.submit([{...record,document:'b'.repeat(32)},later]);
    expect(res.status).toBe(200);
    expect((await res.json()).accepted_session_ids).toEqual(['session1','session2']);
    expect((f.db.prepare('SELECT COUNT(*) n FROM reading_sessions').get() as any).n).toBe(2);
  });
  it('merges checkpoints of one session that disagree on time zone or direction',async()=>{
    const f=await fixture(); await f.submit();
    expect((await f.submit([{...record,utc_offset_minutes:60,ended_at:record.ended_at+300,seconds:900}])).status).toBe(200);
    expect((await f.submit([{...record,ended_at:record.ended_at+350,seconds:800}])).status).toBe(200);
    expect(f.db.prepare('SELECT seconds,ended_at,utc_offset_minutes FROM reading_sessions').get())
      .toMatchObject({seconds:900,ended_at:record.ended_at+350,utc_offset_minutes:0});
  });
  it('grows a stored session even when another session matches the new checkpoint',async()=>{
    const f=await fixture(); await f.submit([{...record,ended_at:record.started_at+1200}]);
    await f.submit([{...record,ended_at:record.started_at+1000,seconds:900}],'reader2');
    expect((await f.submit([{...record,ended_at:record.started_at+1000,seconds:900}])).status).toBe(200);
    expect((f.db.prepare("SELECT seconds FROM reading_sessions WHERE device_id='reader1'").get() as any).seconds).toBe(900);
  });
  it('rejects malformed requests and isolates device/user identities',async()=>{
    const f=await fixture();
    for(const body of [{items:[record]},{device_id:'reader1',items:[]},{device_id:'reader1',items:{}},
      {device_id:'reader1',items:Array.from({length:21},(_,i)=>({...record,session_id:`s${i}`}))}]){
      const res=await f.app.request('/api/v1/stats/sessions',{method:'PUT',headers:f.user.headers,body:JSON.stringify(body)});
      expect(res.status).toBe(403);
    }
    expect((f.db.prepare('SELECT COUNT(*) n FROM reading_sessions').get() as any).n).toBe(0);
    const twice=await f.submit([record,{...record,seconds:700,ended_at:record.ended_at+100}]);
    expect(await twice.json()).toMatchObject({accepted_session_ids:['session1'],refused:[]});
    expect((f.db.prepare('SELECT seconds FROM reading_sessions').get() as any).seconds).toBe(700);
    await f.submit(); await f.submit([{...record,started_at:record.started_at+1,ended_at:record.ended_at+1}],'reader2');
    const other=await registerUser(f.app);
    expect((await f.app.request('/api/v1/stats/sessions',{method:'PUT',headers:other.headers,body:JSON.stringify({device_id:'reader1',items:[record]})})).status).toBe(200);
    expect((f.db.prepare('SELECT COUNT(*) n FROM reading_sessions').get() as any).n).toBe(3);
  });
});

describe('BookOrbit session export round trips',()=>{
  it('exports once, counts independent Kindle reading, and never adds its own export back to totals',async()=>{
    const f=await fixture();await f.submit();
    f.remote.push({id:1,bookFileId:9,source:'koreader',startedAt:'2021-01-01T13:00:00.000Z',endedAt:'2021-01-01T13:05:00.000Z',durationSeconds:300});
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.posts).toHaveLength(1);
    expect(f.remote).toHaveLength(2);
    expect(readBookorbitStats(f.db,f.id)).toMatchObject({global:{seconds:300},excluded_sessions:1,excluded_seconds:600});
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.posts).toHaveLength(1);
    deleteAccount(f.db,f.id,'bookorbit'); upsertAccount(f.db,f.id,'bookorbit',cred,'reader');
    saveMatch(f.db,f.id,'bookorbit',DOC,{externalId:'7',externalEdition:'9',confidence:1},'manual');
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.posts).toHaveLength(1);
    expect(readBookorbitStats(f.db,f.id).global.seconds).toBe(300);
  });
  it('updates the same BookOrbit session for later checkpoints and ignores stale retries',async()=>{
    const f=await fixture();await f.submit();await importBookorbitStats(f.db,f.id,f.http);
    const later={...record,ended_at:record.ended_at+600,seconds:1200};
    expect((await f.submit([later])).status).toBe(200);
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.remote).toHaveLength(1);expect(f.remote[0].durationSeconds).toBe(1200);
    expect(f.posts[0].sessionId).toBe(f.posts[1].sessionId);
    expect((await f.submit()).status).toBe(200);
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.posts).toHaveLength(2);
    expect(readBookorbitStats(f.db,f.id).global.seconds).toBe(0);
    expect((f.db.prepare('SELECT seconds FROM reading_sessions').get() as any).seconds).toBe(1200);
  });
  it('recovers a lost POST response using the same outbound ID and defers uncertain book imports',async()=>{
    const f=await fixture(); await f.submit();f.setLost();
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.remote).toHaveLength(1);
    expect(readBookorbitStats(f.db,f.id).global.seconds).toBe(0);
    expect((f.db.prepare('SELECT prior_ids,remote_id FROM bookorbit_session_exports').get() as any)).toMatchObject({prior_ids:'[]',remote_id:null});
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.remote).toHaveLength(1);
    expect(f.posts[1].sessionId).toBe(f.posts[0].sessionId);
    expect(readBookorbitStats(f.db,f.id)).toMatchObject({global:{seconds:0},excluded_sessions:1});
  });
  it('finishes uncertain ownership before exporting a newer checkpoint',async()=>{
    const f=await fixture();await f.submit();f.setLost();
    await importBookorbitStats(f.db,f.id,f.http);
    await f.submit([{...record,seconds:1200,ended_at:record.ended_at+600}]);
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.remote).toHaveLength(1);expect(f.remote[0].durationSeconds).toBe(600);
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.remote).toHaveLength(1);expect(f.remote[0].durationSeconds).toBe(1200);
    expect(readBookorbitStats(f.db,f.id).global.seconds).toBe(0);
  });
  it('keeps a pre-existing identical session and excludes only the newly exported row',async()=>{
    const f=await fixture();await f.submit();
    f.remote.push({id:1,bookFileId:9,source:'web',startedAt:new Date(record.started_at*1000).toISOString(),endedAt:new Date(record.ended_at*1000).toISOString(),durationSeconds:600});
    await importBookorbitStats(f.db,f.id,f.http);
    expect(readBookorbitStats(f.db,f.id)).toMatchObject({global:{seconds:600},excluded_sessions:1});
    expect((f.db.prepare('SELECT remote_id FROM bookorbit_session_exports').get() as any).remote_id).toBe(2);
  });
  it('does not guess ownership when verification is ambiguous',async()=>{
    const f=await fixture();await f.submit();f.setAmbiguous();
    await importBookorbitStats(f.db,f.id,f.http);
    expect((f.db.prepare('SELECT remote_id,last_error FROM bookorbit_session_exports').get() as any)).toMatchObject({remote_id:null,last_error:expect.stringContaining('ownership')});
    expect(readBookorbitStats(f.db,f.id).global.seconds).toBe(0);
  });
  it('keeps outbound identities when equivalent server URLs are entered on reconnect',async()=>{
    const f=await fixture();await f.submit();await importBookorbitStats(f.db,f.id,f.http);
    for(const server of ['orbit.example','https://ORBIT.example:443/','https://orbit.example///']){
      upsertAccount(f.db,f.id,'bookorbit',{...cred,server},'reader');
      saveMatch(f.db,f.id,'bookorbit',DOC,{externalId:'7',externalEdition:'9',confidence:1},'manual');
      await importBookorbitStats(f.db,f.id,f.http);
    }
    expect(f.posts).toHaveLength(1);
    expect((f.db.prepare('SELECT COUNT(*) n FROM bookorbit_session_exports').get() as any).n).toBe(1);
  });
  it('scopes export ownership to the destination account and keeps old mappings',async()=>{
    const f=await fixture();await f.submit();await importBookorbitStats(f.db,f.id,f.http);
    upsertAccount(f.db,f.id,'bookorbit',{...cred,username:'other'},'other');
    saveMatch(f.db,f.id,'bookorbit',DOC,{externalId:'7',externalEdition:'9',confidence:1},'manual');
    const oldId=f.posts[0].sessionId;
    await importBookorbitStats(f.db,f.id,f.http);
    expect(f.posts).toHaveLength(2);expect(f.posts[1].sessionId).not.toBe(oldId);
    expect((f.db.prepare('SELECT COUNT(*) n FROM bookorbit_session_exports').get() as any).n).toBe(2);
    expect((f.db.prepare('SELECT destination FROM bookorbit_session_destination').get() as any).destination).toBe(bookorbitDestination({...cred,username:'other'}));
  });
});
