import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {finalizeTripPlan, constraintsFingerprint} from '../trip-plan-rules.js';
const basics = {tripName:'美西十日游', destination:'美国', dates:'2027-02-03 - 2027-02-14'};
const places = [
  {id:'la',name:'洛杉矶',nights:'3晚',dates:'2027-02-03 - 2027-02-06',days:[['2/3','到达']]},
  {id:'parks',name:'国家公园',nights:'2晚',dates:'2027-02-06 - 2027-02-08'},
  {id:'lv',name:'拉斯维加斯',nights:'2晚',dates:'2027-02-08 - 2027-02-10'},
  {id:'sf',name:'旧金山',nights:'4晚',dates:'2027-02-10 - 2027-02-14'}
];
const request = {basics, templateId:'custom',constraints:{destinations:[],order:[],orderMode:'flexible'}};
const plan = {templateId:'custom',updatedPlaces:places};
const html = readFileSync(new URL('../australia-trip-planner.html',import.meta.url),'utf8');
function fn(name) {
  const start = html.indexOf(`    function ${name}(`);
  assert.ok(start >= 0);
  const end = html.indexOf('\n    }',start)+6;
  return html.slice(start,end);
}
test('country scope becomes four city modules; basics, dates and fingerprint survive persistence',()=>{
  const out = finalizeTripPlan(plan,request,{basics:{destination:''}});
  assert.equal(out.basics.destination,'美国');
  assert.equal(out.constraints.destinations.length,4);
  assert.equal(out.generatedTrip.constraintsFingerprint,constraintsFingerprint(out.constraints));
  const context = vm.createContext({getTripConstraints:()=>out.constraints,
    normalizeDestinations:d=>d,isAustraliaTemplate:()=>false,
    getOrderedDestinations:()=>out.constraints.destinations,
    createEmptyPlaceFromDestination:d=>({...d,days:[]}),getGeneratedTrip:()=>out.generatedTrip,
    orderPlacesByConstraints:p=>p});
  vm.runInContext(fn('getConstraintsFingerprint')+'\n'+fn('normalizeCustomPlace')+'\n'+fn('getCurrentTemplatePlaces'),context);
  assert.equal(vm.runInContext('getConstraintsFingerprint()',context),out.generatedTrip.constraintsFingerprint);
  const rendered = vm.runInContext('getCurrentTemplatePlaces()',context);
  assert.equal(rendered.length,4);
  assert.equal(rendered[0].days[0][1],'到达');
});
test('quick start never turns the basic scope into a destination hard constraint',()=>{
  const start = html.indexOf('const quickConstraints =');
  const end = html.indexOf('\n        };',start)+11;
  const context=vm.createContext({startDate:'2027-02-03',endDate:'2027-02-14',destination:'美国'});
  vm.runInContext(html.slice(start,end)+'\n globalThis.result = quickConstraints;',context);
  assert.equal(context.result.destinations.length,0);
  assert.equal(context.result.order.length,0);
  assert.equal(context.result.arrival,'2027-02-03 抵达 美国');
});
test('explicit city nights remain enforced even with flexible ordering',()=>{
  const r={...request,constraints:{destinations:[{id:'la',name:'洛杉矶',nights:'4晚'}],orderMode:'flexible'}};
  assert.throws(()=>finalizeTripPlan(plan,r),/应为 4晚/);
});
test('fixed destination order cannot be changed',()=>{
  const r={...request,constraints:{destinations:places,order:['sf','lv','parks','la'],orderMode:'fixed'}};
  assert.throws(()=>finalizeTripPlan(plan,r),/固定地点顺序/);
});
test('missing cities, incorrect total, inconsistent dates and duplicate IDs are rejected',()=>{
  assert.throws(()=>finalizeTripPlan(plan,{...request,constraints:{destinations:[{id:'ny',name:'纽约',nights:'1晚'}]}}),/缺少 纽约/);
  assert.throws(()=>finalizeTripPlan(plan,{...request,basics:{...basics,dates:'2027-02-03 - 2027-02-15'}}),/总晚数/);
  assert.throws(()=>finalizeTripPlan({...plan,updatedPlaces:[{...places[0],nights:'5晚'}]},request),/晚数与日期/);
  assert.throws(()=>finalizeTripPlan({...plan,updatedPlaces:[places[0],places[0]]},request),/重复/);
});
test('failed validation does not mutate the prior saved state',()=>{
  const state={generatedTrip:{summary:'old'},versions:[{id:'v1'}]};
  const before=structuredClone(state);
  assert.throws(()=>finalizeTripPlan({updatedPlaces:[]},request,state));
  assert.deepEqual(state,before);
});
test('browser script parses',()=>{
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
