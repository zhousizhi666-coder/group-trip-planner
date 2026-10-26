import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('API validates before persistence, commits request metadata and keeps prior version on failure',async()=>{
  let plan={updatedPlaces:[{id:'la',name:'洛杉矶',nights:'2晚',dates:'2027-02-03 - 2027-02-05',days:[['2/3','到达']]}]};
  const mock=createServer((req,res)=>{req.resume();res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(plan)}}]}));});
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  const dir=await mkdtemp(join(tmpdir(),'trip-api-test-'));
  const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const child=spawn(process.execPath,['trip-ai-server.mjs'],{cwd:new URL('..',import.meta.url),env:{PATH:process.env.PATH,PORT:String(port),HOST:'127.0.0.1',ARK_API_KEY:'test-only',ARK_BASE_URL:`http://127.0.0.1:${mock.address().port}`,DATA_FILE:join(dir,'state.json')}});
  try {
    await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('startup timeout')),5000);child.stdout.on('data',d=>{if(d.toString().includes('Trip planner server:')){clearTimeout(t);resolve();}});child.once('error',reject);});
    const base=`http://127.0.0.1:${port}`;
    const input={trip:{templateId:'custom',generationMode:'initial',basics:{tripName:'测试行程',destination:'美国',dates:'2027-02-03 - 2027-02-05'},constraints:{destinations:[],order:[],orderMode:'flexible'}}};
    const post=()=>fetch(`${base}/api/plan`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    const response=await post();assert.equal(response.status,200);
    const data=await response.json();assert.equal(data.constraints.destinations[0].name,'洛杉矶');
    const stored=JSON.parse(await readFile(join(dir,'state.json'),'utf8'));
    assert.equal(stored.basics.destination,'美国');assert.equal(stored.versions.length,1);
    assert.equal(stored.generatedTrip.constraintsFingerprint,data.updatedTrip.constraintsFingerprint);
    const before=await readFile(join(dir,'state.json'),'utf8');
    plan={updatedPlaces:[]};
    const bad=await post();assert.equal(bad.status,422);
    assert.equal(await readFile(join(dir,'state.json'),'utf8'),before);
  } finally {
    child.kill(); await new Promise(r=>child.once('close',r));mock.close();await rm(dir,{recursive:true,force:true});
  }
});
