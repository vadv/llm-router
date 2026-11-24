// Self-check of the chart and usage math. Run: node scripts/check-math.mjs
// Node runs the .ts modules directly by stripping the types, so the checks
// need no test runner and no browser.
import assert from "node:assert/strict";
import {
  axisDecimals,
  change,
  frame,
  nearestIndex,
  runs,
  ticks,
} from "../src/components/chart-math.ts";
import { prepareCosts, makePivot, perMillion, amount, missing, calendarDay } from '../src/components/usage-pivot.ts';
import { allocatedSpend, buildSeries, providerEstimates, errorPercent, rankGroups, sumBuckets, valueOf } from "../src/components/usage-math.ts";
import { balanceRisk, balanceReading, burnPerDay, daysLeft, groupAmounts, readingGroups } from "../src/components/balance-math.ts";
import {
  groupByKnowledgeKey,
  splitModelGroup,
  looksLikeModelId,
  safeHttpUrl,
  vendorColor,
} from "../src/model-key.ts";

import { overviewPeriod, poolCoverage, recentOutcomes, trafficHours } from "../src/components/overview-math.ts";
import { compact, eta, money, tps } from "../src/format.ts";
import { callTimeline } from "../src/components/request-timeline.ts";
import { eventStory } from "../src/components/event-story.ts";
import { poolSuggestions } from '../src/pool-suggestions.ts';
import {
  benchmarks, comparable, defaultBenchmark, findModel, leaderboard, vendorOptions,
  wikiGroups, wikiModels, wikiResults,
} from "../src/wiki-catalog.ts";
import { benchmarkInfo, benchmarkOrder, lowerIsBetter } from "../src/benchmarks.ts";
import { benchmarkOf, modelSpecs, parsePricing, scoresOf, splitDescription, tagsOf } from "../src/model-facts.ts";

import { findCommands } from "../src/components/workspace-commands.ts";

import { poolEvidence, documentsImageInput } from "../src/pool-evidence.ts";
import { freeLabel, idleSlots, modelBrief, inventoryRows } from "../src/provider-inventory.ts";
let checks = 0;
function test(name, body) {
  body();
  checks += 1;
  console.log(`ok ${name}`);
}

test("workspace search puts exact pages first and keeps task filters in the destination", () => {
  const nav = [{route: "history", label: "Requests"}];
  assert.equal(findCommands(nav, "requests")[0].target, "#/history");
  assert.equal(findCommands(nav, "  FAILed   requests ")[0].target, "#/history?period=24h&outcome=error");
  assert.equal(findCommands(nav, "base url")[0].target, "connection");
  assert.deepEqual(findCommands(nav, "not-a-command"), []);
});

test('Pool finder explains exact catalog aliases, shared routes and task tags without changing member order', () => {
  const row=(provider_id,upstream_id,knowledge_key,context_tokens=null)=>({provider_id,upstream_id,knowledge_key,context_tokens});
  const a=row('one','alpha','a'), alias=row('two','vendor/alpha','a'), coder=row('three','lab-coder','c',32000), big=row('ten','long','long',200000), other=row('one','plain','z',128000);
  const rows=[other,big,alias,a,coder], pools=[{name:'backend',members:[a,coder]}], members=[a];
  const find=(goal='fit',ref='',q='',conn='',bans=[])=>poolSuggestions(rows,pools,members,ref,goal,q,conn,bans,10);
  assert.deepEqual(find().slice(0,2).map(r=>r.model),[alias,coder]);
  assert.match(find()[0].reasons.join(' '),/Primary model/);assert.match(find()[1].reasons.join(' '),/Paired in backend/);
  assert.equal(find('coding')[0].model,coder);assert.equal(find('context')[0].model,big);assert.equal(find('fit','','vendor alpha','two').length,1);
  assert.ok(!find().some(r=>r.model===a));assert.deepEqual(members,[a]);
  assert.equal(poolSuggestions(rows,pools,[],'backend','fit','','',[],10)[0].reasons[0],'In your backend pool');
  assert.equal(find('fit','','','',[{...alias,expires_at_unix:11}]).at(-1).model,alias);assert.equal(find('fit','','','',[{...alias,expires_at_unix:10}])[0].model,alias);
  assert.deepEqual(find('fit','','missing'),[]);
});

test("Wiki groups every listing of one key and reads the card under the key the core reports", () => {
  const row = (k,p,id,ctx=null) => ({knowledge_key:k, provider_id:p, upstream_id:id, context_tokens:ctx});
  const groups = wikiGroups([row("a","one","A"),row("a","two","vendor/A",200000),row("b","two","B"),row("c","one","C")],
    [{key:"a",canonical_name:"Alpha",vendor:"Alpha Labs",description:"Alpha is a small model. It is cheap.",ratings:[{source:"Lab",metric:"Index",value:0,as_of:null}],pricing_hint:"$1 per 1M input tokens and $2 per 1M output tokens.",use_cases:["Chat"]},
     {key:"b",ratings:[{source:"Elsewhere",metric:"Index",value:999}]}]);
  assert.deepEqual(groups.map(g=>g.key),["a","b","c"]);
  assert.deepEqual(groups[0].providers,["one","two"]);
  assert.equal(groups[0].context,200000);
  assert.equal(groups[0].scores.get("index").rating.value,0);
  // The benchmark order puts familiar families first.
  assert.equal(benchmarkOrder("gpqa diamond") < benchmarkOrder("vendor thing"),true);
  assert.deepEqual(groups[0].pricing,{currency:"USD",input:1,cachedInput:null,output:2,free:false,note:groups[0].pricing.note});
  // Too short to stand alone without its subject: the lead keeps it.
  assert.equal(groups[0].tagline,"Alpha is a small model.");
  assert.equal(groups[2].card,null);
  assert.equal(groups[2].tagline,"");
});

test("Wiki lists one model per researched name and keeps a rolling alias as a variant", () => {
  const row = (k,p,id) => ({knowledge_key:k, provider_id:p, upstream_id:id, context_tokens:null});
  const cards = [
    {key:"gpt-5-1",canonical_name:"GPT-5.1",vendor:"OpenAI",ratings:[
      {source:"Artificial Analysis",metric:"Intelligence Index",value:88},{source:"Artificial Analysis",metric:"GPQA Diamond",value:92},
      {source:"OpenAI",metric:"HLE (max)",value:71},{source:"Artificial Analysis",metric:"AIME (max)",value:90}]},
    {key:"gpt-5-1-latest",canonical_name:"GPT-5.1",vendor:"OpenAI",ratings:[
      {source:"Artificial Analysis",metric:"Intelligence Index",value:88},{source:"OpenRouter",metric:"SWE-bench Verified",value:70},
      {source:"Artificial Analysis",metric:"HLE (High)",value:60},{source:"Artificial Analysis",metric:"AIME (max)",value:95}]},
    {key:"gpt-5-1-pro",canonical_name:"GPT-5.1 Pro",vendor:"OpenAI",ratings:[]},
    {key:"mystery",vendor:"Nobody",canonical_name:null,ratings:[]},
    {key:"other-vendor",canonical_name:"GPT-5.1",vendor:"Someone Else",ratings:[]},
  ];
  const models = wikiModels(wikiGroups([
    row("gpt-5-1","openai","gpt-5.1"),row("gpt-5-1","openrouter","openai/gpt-5.1"),
    row("gpt-5-1-latest","openrouter","~openai/gpt-5.1-latest"),
    row("gpt-5-1-pro","openai","gpt-5.1-pro"),
    row("mystery","x","mystery"),
    row("other-vendor","y","other"),
  ], cards));
  const byKey = Object.fromEntries(models.map(m=>[m.key,m]));
  assert.equal(models.length,4);
  const gpt = byKey["gpt-5-1"];
  // The alias folds into the model: most listings name it, the rest become variants.
  assert.deepEqual(gpt.providers,["openai","openrouter"]);
  assert.deepEqual(gpt.variants.map(v=>v.key),["gpt-5-1-latest"]);
  // A score the primary lacks is read from a variant.
  assert.equal(gpt.scores.get("swe-bench verified").rating.value,70);
  assert.equal(gpt.origins.get("swe-bench verified").key,"gpt-5-1-latest");
  assert.equal(gpt.scores.get("gpqa diamond").rating.value,92);
  // A better reading of a benchmark the primary already scores is taken
  // from the variant: the lab's lower effort over the vendor's maximum.
  assert.equal(gpt.scores.get("hle").rating.value,60);
  assert.equal(gpt.origins.get("hle").key,"gpt-5-1-latest");
  // The same reading from both cards stays the primary's.
  assert.equal(gpt.scores.get("aime").rating.value,90);
  assert.equal(gpt.origins.get("aime").key,"gpt-5-1");
  // Another name or another vendor is another model.
  assert.ok(byKey["gpt-5-1-pro"]);
  assert.ok(byKey["other-vendor"]);
  // A tag most models have says little: the rare ones are named first.
  const tagged = wikiModels(wikiGroups([row("a","x","a"), row("b","x","b")], [
    {key:"a",canonical_name:"A",vendor:"V",ratings:[],tags:["coding","agents","embedding"]},
    {key:"b",canonical_name:"B",vendor:"V",ratings:[],tags:["agents","coding","vision"]},
  ]));
  assert.deepEqual(tagged.map((m) => m.tags), [["embedding","coding","agents"], ["vision","coding","agents"]]);
  // An unresearched name never folds.
  assert.ok(byKey["mystery"]);
  // A link by key, by alias key, by listing id or by a near spelling finds the model.
  assert.equal(findModel(models,"gpt-5-1").key,"gpt-5-1");
  assert.equal(findModel(models,"gpt-5-1-latest").key,"gpt-5-1");
  assert.equal(findModel(models,"~openai/gpt-5.1-latest").key,"gpt-5-1");
  assert.equal(findModel(models,"GPT-5-1").key,"gpt-5-1");
  assert.equal(findModel(models,"nope"),null);
  assert.equal(findModel(models,null),null);
});

test("benchmarks are families with a head count, split by index version and by whose scale", () => {
  const row = (k,p,id) => ({knowledge_key:k, provider_id:p, upstream_id:id, context_tokens:null});
  const r = (metric,value,source="Artificial Analysis",as_of="2026-10") => ({metric,value,source,as_of});
  const models = wikiModels(wikiGroups(
    ["a","b","c","d","e","f","g","h","i"].map(k=>row(k,"p",k)),
    [
      {key:"a",vendor:"V",ratings:[r("Intelligence Index v5.0.1 (Low effort)",50),r("GPQA Diamond",70),r("Terminal Bench 2.0",30),r("Vendor-only test",99,"V blog")]},
      {key:"b",vendor:"V",ratings:[r("Intelligence Index v5.0.1 (Low effort)",40),r("GPQA Diamond",60),r("Terminal Bench 4.0",35)]},
      {key:"c",vendor:"V",ratings:[r("Artificial Analysis Intelligence Index",45),r("GPQA Diamond",65,"V blog")]},
      // Dated before any v5 sighting: an older scale, even without a version in the name.
      {key:"d",vendor:"V",ratings:[r("Intelligence Index",68,"Artificial Analysis","2025-05")]},
      // Another site's index is on another scale.
      {key:"e",vendor:"V",ratings:[r("Intelligence Index (composite)",88,"TrustTheBench"),r("GPQA Diamond",55)]},
      {key:"g",vendor:"V",ratings:[r("Latency",1.2)]},
      {key:"h",vendor:"V",ratings:[r("Latency",0.8)]},
      {key:"i",vendor:"V",ratings:[r("Overall score",3,"One Site"),r("Overall score",9,"Other Site")]},
    ]));
  const options = benchmarks(models);
  // Most models first; among equals the better-sourced, then the name.
  assert.deepEqual(options.slice(0,3).map(o=>[o.id,o.count,o.lab]),[
    ["gpqa diamond",4,3],
    ["intelligence index v5",3,3],
    ["latency",2,2]]);
  assert.deepEqual(options.slice(3).map(o=>o.id).sort(),[
    "intelligence index before v5",
    "intelligence index v5 · trustthebench",
    "one site overall score","other site overall score",
    "terminal-bench 2.0","terminal-bench 4.0","vendor-only test"].sort());
  assert.equal(options[1].base,"intelligence index");
  assert.equal(options[1].latest,"2026-10");
  // A family fewer than five models were scored on is no default ranking.
  assert.equal(defaultBenchmark(options.filter(o=>o.count>=2)).id,"gpqa diamond");
  // The newest version of a composite wins once enough models carry it.
  const wider = wikiModels(wikiGroups(
    ["a","b","c","d2","d3","d4","e2","e3"].map(k=>row(k,"p",k)),
    [
      {key:"a",vendor:"V",ratings:[r("Intelligence Index v5",50),r("GPQA Diamond",70)]},
      {key:"b",vendor:"V",ratings:[r("Intelligence Index v5",40),r("GPQA Diamond",60)]},
      {key:"c",vendor:"V",ratings:[r("Intelligence Index v5",45),r("GPQA Diamond",65)]},
      {key:"d2",vendor:"V",ratings:[r("Intelligence Index v5",45),r("GPQA Diamond",65)]},
      {key:"e2",vendor:"V",ratings:[r("Intelligence Index v5",45),r("GPQA Diamond",65)]},
      {key:"d3",vendor:"V",ratings:[r("Intelligence Index v4.1",68,"Artificial Analysis","2025-05"),r("GPQA Diamond",65)]},
      {key:"d4",vendor:"V",ratings:[r("Intelligence Index v4.1",66,"Artificial Analysis","2025-05"),r("GPQA Diamond",65)]},
      {key:"e3",vendor:"V",ratings:[r("Intelligence Index v4.1",64,"Artificial Analysis","2025-05"),r("GPQA Diamond",65)]},
    ]));
  const wide = benchmarks(wider);
  assert.deepEqual(wide.map(o=>o.id),["gpqa diamond","intelligence index v5","intelligence index v4"]);
  assert.equal(defaultBenchmark(wide).id,"intelligence index v5");
  assert.deepEqual(vendorOptions(models).map(v=>v.value),["V"]);
  // The leaderboard is best first, within one version of one scale.
  assert.deepEqual(leaderboard(models,"intelligence index v5",false).map(r=>r.model.key),["a","c","b"]);
  assert.deepEqual(leaderboard(models,"intelligence index before v5",false).map(r=>r.model.key),["d"]);
  assert.deepEqual(leaderboard(models,"latency",false).map(r=>r.model.key),["h","g"]);
  // Vendor numbers stay out unless asked for, and the glossary knows the families.
  assert.equal(leaderboard(models,"gpqa diamond",true).length,3);
  assert.equal(leaderboard(models,"vendor-only test",true).length,0);
  assert.match(benchmarkInfo("terminal-bench 4.0").what,/shell/);
  assert.match(benchmarkInfo("intelligence index v5").what,/Artificial Analysis/);
  assert.equal(benchmarkInfo("intelligence index before v5").what,benchmarkInfo("intelligence index v5").what);
  assert.equal(lowerIsBetter("latency"),true);
  assert.equal(lowerIsBetter("gpqa diamond"),false);
  assert.equal(benchmarkInfo("gpqa diamond").scale,"% correct");
});

test("the directory filters on text and facets, orders by what was asked, and leaves the unknown last", () => {
  const row = (k,p,id,ctx=null) => ({knowledge_key:k, provider_id:p, upstream_id:id, context_tokens:ctx});
  const r = (metric,value) => ({metric,value,source:"Artificial Analysis",as_of:null});
  const models = wikiModels(wikiGroups(
    [row("a","one","A",128000),row("b","two","B",200000),row("c","one","C",null),row("d","three","D",64000)],
    [
      {key:"a",canonical_name:"Alpha",vendor:"Alpha Labs",description:"Alpha is a coder.",primary_use:"coding assistants",ratings:[r("Intelligence Index",50)],pricing_hint:"$1 per 1M input tokens and $2 per 1M output tokens.",use_cases:["Code"]},
      {key:"b",canonical_name:"Beta",vendor:"Beta Inc",ratings:[r("Intelligence Index",70),r("GPQA Diamond",90)],pricing:{currency:"USD",input_per_1m:0.25,cached_input_per_1m:null,output_per_1m:1,note:null},tags:["vision"]},
      {key:"c",canonical_name:"Gamma",vendor:"Beta Inc",ratings:[r("GPQA Diamond",95)],pricing:{currency:"USD",input_per_1m:0,cached_input_per_1m:null,output_per_1m:0,note:null}},
      // No summary for "d": the index only answers for keys with a card.
    ]));
  const keys = (filters, sort, bench) => wikiResults(models,filters,sort,bench).rows.map(m=>m.key);
  // Score order: scored first, best first; the unscored models follow by
  // name, whatever the column's direction.
  const top = wikiResults(models,{},"score","intelligence index");
  assert.deepEqual(top.rows.map(m=>m.key),["b","a","d","c"]);
  assert.deepEqual([...top.places],[["b",1],["a",2]]);
  assert.equal(top.measured,2);
  assert.deepEqual(keys({},"score-asc","intelligence index"),["a","b","d","c"]);
  // Nobody was measured on it: the honest order is by name.
  assert.deepEqual(keys({},"score","latency"),["a","b","d","c"]);
  assert.deepEqual(keys({},"name",null),["a","b","d","c"]);
  // Facets.
  assert.deepEqual(keys({connection:"one"},"name",null),["a","c"]);
  // Vendors are compared by their canonical name.
  assert.deepEqual(keys({vendor:"Beta"},"name",null),["b","c"]);
  assert.deepEqual(keys({vendor:"Beta Inc"},"name",null),[]);
  assert.deepEqual(keys({tag:"coding"},"name",null),["a"]);
  assert.deepEqual(keys({tag:"cheap"},"name",null),["b","c"]);
  assert.deepEqual(keys({research:"missing"},"name",null),["d"]);
  assert.deepEqual(keys({query:"beta"},"name",null),["b","c"]);
  assert.deepEqual(keys({query:"two b"},"name",null),["b"]);
  assert.deepEqual(keys({query:"zzz"},"name",null),[]);
  // Largest context first, and a listing with no context last.
  assert.deepEqual(keys({},"context",null),["b","a","d","c"]);
  // Cheapest first: free, then cheap, then dear, then no price.
  assert.deepEqual(keys({},"price",null),["c","b","a","d"]);
});

test("a tag is stated or read from a use case, never invented", () => {
  assert.deepEqual(tagsOf({ratings:[],tags:["Coding","vision","nonsense"]}),["coding","vision"]);
  assert.deepEqual(tagsOf({ratings:[],tags:[] ,primary_use:"",description:"",pricing_hint:"$0.10 per 1M input tokens and $0.50 per 1M output tokens."},"Repository editing and tool calls"),
    ["coding","cheap"]);
  // "Tool calls" is not an agent use: the use is read strictly.
  assert.deepEqual(tagsOf({ratings:[]},"Multi-step agents"),["agents"]);
  assert.deepEqual(tagsOf({ratings:[],tags:["vision"],pricing_hint:"$0.10 per 1M input tokens and $0.50 per 1M output tokens."},"coding"),
    ["vision","cheap"]);
  assert.deepEqual(tagsOf({ratings:[]},null),[]);
  assert.deepEqual(tagsOf({ratings:[],open_weights:true},""),["open-weights"]);
});

test("Wiki survives cards and queries the schema forbids: a bad card never blanks the page", () => {
  // A reader meets whatever a researcher once wrote: nulls where strings
  // belong, notes without a name, versions without numbers.
  const odd = [
    null, undefined, {}, { ratings: null }, { description: null, canonical_name: undefined, tags: "coding", pricing: "x", speed: [], context_window: "1M", release_date: 2026 },
    { ratings: [{ metric: null, value: null, source: null }] },
    { ratings: [{ metric: "", value: NaN }] },
    { ratings: [{ metric: "Intelligence Index v", value: 1 }] },
    { ratings: [{ metric: "GPQA", value: 1, note: "effort" }] },
    { ratings: [{ metric: "GPQA", value: 1, note: "max reasoning" }] },
    { ratings: [{ metric: "GPQA", value: 1, note: "reasoning effort set to XHigh" }] },
    { ratings: [{ metric: "GPQA (max)", value: 1, note: null, source: "" }] },
  ];
  for (const card of odd) {
    const safe = card ?? { ratings: [] };
    assert.doesNotThrow(() => { modelSpecs(safe); parsePricing(safe); splitDescription(safe); tagsOf(safe, undefined); scoresOf(safe.ratings, undefined); });
  }
  // The effort a note states is the variant a score is read under.
  assert.equal(benchmarkOf({ metric: "GPQA", value: 1, source: "Artificial Analysis", note: "max reasoning effort", as_of: null }).variant, "max effort");
  assert.equal(benchmarkOf({ metric: "GPQA", value: 1, source: "Artificial Analysis", note: "default reasoning effort max; v5", as_of: null }).variant, "max effort");
  assert.equal(benchmarkOf({ metric: "GPQA", value: 1, source: "Artificial Analysis", note: "effort", as_of: null }).variant, null);
  const rows = [{ provider_id: "p", upstream_id: "odd", knowledge_key: "odd", context_tokens: null }];
  const models = wikiModels(wikiGroups(rows, odd.slice(4).map((card, i) => ({ key: "odd", ratings: [], ...card, key: i === 0 ? "odd" : `odd-${i}` }))));
  const all = [...models, ...wikiModels(wikiGroups([], []))];
  for (const q of ["", "zzz qq", "' \" <script>", "κimi", "-", "  ", "~x/y"]) {
    for (const sort of ["score", "score-asc", "name", "context", "connections", "release", "price", "speed"]) {
      assert.doesNotThrow(() => wikiResults(all, { query: q }, sort, benchmarks(all)[0]?.id ?? null));
    }
  }
  assert.equal(findModel([], "x"), null);
  assert.equal(defaultBenchmark([]), undefined);
});

test("the lead sentence does not repeat the title, starts capitalized, and is about the model", () => {
  const lead = splitDescription({ratings:[],canonical_name:"DeepSeek V3.2 Thinking",description:"DeepSeek V3.2 Thinking is the reasoning mode of V3.2. It always reasons."});
  assert.deepEqual(lead,{lead:"The reasoning mode of V3.2.",rest:"It always reasons."});
  // An old card that opens with how the alias resolves leads with the model instead.
  const alias = splitDescription({ratings:[],canonical_name:"GPT-6.2 Astra",description:"OpenRouter's openai/gpt-6.2-astra entry resolves to OpenAI's GPT-6.2 Astra, a flagship reasoning model. It is the strongest coding model of the family. It costs $8 per 1M input tokens."});
  assert.equal(alias.lead,"It is the strongest coding model of the family.");
  assert.equal(alias.rest,"OpenRouter's openai/gpt-6.2-astra entry resolves to OpenAI's GPT-6.2 Astra, a flagship reasoning model. It costs $8 per 1M input tokens.");
  // Nothing better to lead with: the opening stays.
  const only = splitDescription({ratings:[],description:"The catalog alias auto resolves to the routing capability of the provider."});
  assert.equal(only.lead,"The catalog alias auto resolves to the routing capability of the provider.");
});

test("Request timeline preserves quiet minutes, unknown outcomes and exclusive edge bounds", () => {
  const report = {from_unix:65,to_unix:184,as_of_unix:183,step_secs:60,buckets:[
    {start:60,total:4,ok:1,errors:1,cancels:1,retried:2},
    {start:180,total:1,ok:1,errors:0,cancels:0,retried:0},
  ]};
  const bins = callTimeline(report);
  assert.deepEqual(bins.map(b=>[b.from,b.to,b.total,b.other,b.open]),[
    [65,120,4,1,false],[120,180,0,0,false],[180,184,1,0,true],
  ]);
  assert.equal(callTimeline({...report,as_of_unix:1000})[2].open,false);
  assert.deepEqual(callTimeline({...report,from_unix:null,buckets:[]}),[]);
});

const series = (label, points) => ({ label, color: "teal", points });
const bucket = (over) => ({
  bucket_unix: 0,
  group: "zai",
  requests: 1,
  attempts: 1,
  input_tokens: 10,
  output_tokens: 5,
  errors: 0,
  unknown_tokens: 0,
  cost: null,
  cost_reports: 0,
  ...over,
});

test("event headlines explain actual routing changes without implying recovery", () => {
  const story = (kind, detail) => eventStory({ kind, detail, provider_id: null });
  assert.equal(story("model_switch", {pool:"chat", from:"a/x", to:"b/y"}).note, "From a/x to b/y");
  assert.match(story("all_models_failed", {metamodel:"chat", members:2}).title, /No member of chat/);
  assert.match(story("ban_expired", {upstream_id:"m"}).note, /not a health check/);
  assert.match(story("balance_error", null).note, /not mean the balance is zero/);
  assert.equal(story("retention_purged", {requests:0,events:2}).note, "requests: 0 · events: 2");
});

test("missing or unknown event fields do not become JSON headlines or invented facts", () => {
  for (const kind of ["model_switch","server_started","retention_purged","future_event","ban_recorded"]) {
    for (const detail of [null, "text", {internal:"private fixture", from:{bad:1}}]) {
      const {title,note} = eventStory({kind,detail,provider_id:null});
      assert(!/private fixture|undefined|\[object Object\]|1970/.test(title + note));
    }
  }
});

test("overview keeps valid periods and rejects unknown hash values", () => {
  assert.equal(overviewPeriod("7d"), "7d");
  assert.equal(overviewPeriod("constructor"), "24h");
  assert.equal(overviewPeriod(null), "24h");
});

test("pool warnings match both connection and upstream, with empty pools visible", () => {
  const m = (provider_id, upstream_id) => ({ provider_id, upstream_id });
  const banned = m("p/a", "b"), allowed = m("p", "a/b");
  const pools = [["ok", [allowed]], ["partial", [banned, allowed]], ["blocked", [banned]], ["empty", []]];
  const coverage = poolCoverage(pools.map(([name, members]) => ({name, members})), [banned]);
  assert.deepEqual(coverage.map(p => [p.name, p.free]), [["blocked", 0], ["empty", 0], ["partial", 1], ["ok", 1]]);
});

test("recent success includes known cancels but not missing outcomes", () => {
  const rows = ["ok", "error", "client_cancel", null].map(outcome => ({ outcome }));
  assert.deepEqual(recentOutcomes(rows), {count: 3, ok: 1, errors: 1, cancels: 1, rate: 100/3});
  assert.equal(recentOutcomes([]).rate, null);
});

test("overview hours include idle edges and combine providers without counting retries as calls", () => {
  const rows = [bucket({bucket_unix: 3600, attempts: 2, errors: 1}), bucket({bucket_unix: 3600, attempts: 3})];
  assert.deepEqual(trafficHours(rows, 3590, 10800).map(h => [h.unix,h.attempts,h.errors]), [[0,0,0],[3600,5,1],[7200,0,0]]);
});

test("output speed uses measured milliseconds with a second-resolution legacy fallback", () => {
  const a = {started_at_unix: 10, finished_at_unix: 10, duration_ms: 500, output_tokens: 20};
  assert.equal(tps(a), 40);
  assert.equal(tps({...a, duration_ms: 0}), null);
  assert.equal(tps({...a, output_tokens: 0}), 0);
  assert.equal(tps({...a, duration_ms: null, finished_at_unix: 12}), 10);
});

test("client cancels do not enter the provider error rate", () => {
  assert.equal(errorPercent({ ok: 3, errors: 1, cancels: 6 }), 25);
  assert.equal(errorPercent({ ok: 0, errors: 0, cancels: 6 }), null);
  assert.equal(errorPercent({ ok: 2, errors: 0 }), 0);
});

test('pivot applies rates before grouping, never mixes units, and clips drilldown', () => {
  const row=(provider,ts,over)=>({...bucket({}), provider, group:'one key', bucket_unix:ts, attempts:1,input_tokens:90,output_tokens:10,input_reports:1,output_reports:1,cost:null,cost_reports:0,estimable_attempts:1,unpriced_tokens:100,...over});
  const {prepared,units}=prepareCosts([row('direct',60,{}),row('relay',60,{cost:0,cost_reports:1,estimable_attempts:0,unpriced_tokens:null}),row('plan',120,{}),row('unknown',120,{})],[{provider_id:'relay',reported_cost_unit:'USD'}],['direct','plan'].map((provider,i)=>({provider,primary_series:true,per_1000:5,unit:i?'credits':'USD'})));
  assert.deepEqual(units,['USD','credits (plan)']);const p=makePivot(prepared,'USD',{from:75,to:160},60,{from:75,to:120});
  assert.equal(p.bins[0].from,75);assert.equal(p.bins[1].to,160);assert.equal(p.total.outside,1);assert.equal(missing(p.total),1);assert.equal(perMillion(p.total),null);
  const group=p.groups.get('one key');assert.equal(group.attempts,2);assert.equal(amount(group,'spend'),0.5);assert.equal(amount(group,'reported'),0);assert.equal(perMillion(group),2500);
  const day=calendarDay(true,new Date(2025,4,14,19)); assert.equal(new Date(day.from*1000).getHours(),0);assert.equal(new Date(day.to*1000).getDate(),14);
});

test('token breakdown counts known input and output without any price or balance', () => {
  const rows = [[30, 5], [null, 2], [0, 0], [null, null]].map(([input, output], i) => ({
    ...bucket({}), bucket_unix: i * 60, group: i === 3 ? 'unknown' : 'coding', provider: 'example', attempts: 1,
    input_tokens: input, output_tokens: output, input_reports: Number(input !== null), output_reports: Number(output !== null),
    cost: null, cost_reports: 0, unpriced_tokens: null, estimable_attempts: 0,
  }));
  const { prepared } = prepareCosts(rows, [], []);
  const p = makePivot(prepared, 'USD', { from: 0, to: 240 }, 60, null);
  assert.deepEqual(p.bins.map(b => amount(b.cell, 'tokens')), [35, 2, 0, null]);
  assert.equal(amount(p.groups.get('unknown'), 'tokens'), null);
  assert.equal(amount(p.groups.get('coding'), 'tokens'), 37);
  assert.equal(amount(p.total, 'spend'), null);
});

test("small charges, reported zero and unknown cost stay distinct", () => {
  assert.equal(Number(money(0.0000012)), 0.0000012);
  assert.equal(money(0), "0.00");
  assert.equal(money(null), "—");
});

test("a count takes the largest unit that keeps three digits", () => {
  assert.equal(compact(null), "—");
  assert.equal(compact(23), "23");
  assert.equal(compact(3.006), "3.01");
  // A duration keeps its hundredths below a thousand.
  assert.equal(compact(12.3456), "12.35");
  assert.equal(compact(0.0123), "0.0123");
  assert.equal(compact(1000), "1K");
  assert.equal(compact(287_551), "288K");
  assert.equal(compact(94_260), "94.3K");
  assert.equal(compact(1_100_000), "1.1M");
  // Billions roll over instead of reading as thousands of millions.
  assert.equal(compact(9_426_500_000), "9.43B");
  assert.equal(compact(11_000_000_000), "11B");
  assert.equal(compact(2_400_000_000_000), "2.4T");
  assert.equal(compact(2400 * 1e12), "2400T");
  // Whole thousands and millions keep their zeros.
  assert.equal(compact(10_000), "10K");
  assert.equal(compact(10_000_000), "10M");
  assert.equal(compact(150_000), "150K");
  assert.equal(compact(-1_153_400_000), "-1.15B");
});

test("time left appears once a job has a pace", () => {
  const start = 1_000;
  // One or two units say nothing about the pace of four hundred.
  assert.equal(eta(start, 2, 439, start + 60), null);
  assert.equal(eta(null, 20, 439, start + 600), null);
  assert.equal(eta(start, 439, 439, start + 6000), null);
  // 20 units in 600 s is 30 s each; 419 remain.
  assert.equal(eta(start, 20, 439, start + 600), "about 3h 29m left");
  assert.equal(eta(start, 400, 439, start + 12_000), "about 19m left");
});

test("unpriced tokens keep each provider's rate and unit", () => {
  const rows = providerEstimates({ deepseek: 2000, zai: 1500, unmeasured: 2000 }, [
    { provider: "deepseek", primary_series: true, per_1000: 0.003, unit: "USD" },
    { provider: "zai", primary_series: true, per_1000: 4, unit: "credits" },
    { provider: "deepseek", primary_series: false, per_1000: 99, unit: "requests" },
  ]);
  assert.deepEqual(rows.map(r => [r.provider, r.amount, r.rate?.unit]), [
    ["deepseek", 0.006, "USD"], ["zai", 6, "credits"], ["unmeasured", null, undefined],
  ]);
  assert.equal(sumBuckets([bucket({ cost: 0, unpriced_tokens: null }), bucket({ unpriced_tokens: 100 })]).unpricedTokens, 100);
  assert.equal(sumBuckets([]).unpricedTokens, null);
});

test("allocate known tokens once at the primary provider rate", () => {
  const rate = { primary_series: true, per_1000: 0.2 };
  assert.equal(allocatedSpend(rate, 60_000), 12);
  assert.equal(allocatedSpend(rate, 0), 0);
  assert.equal(allocatedSpend(rate, null), null);
  assert.equal(allocatedSpend({ ...rate, per_1000: null }, 1), null);
  assert.equal(allocatedSpend({ ...rate, primary_series: false }, 1), null);
  assert.equal(allocatedSpend({ note: "reported cost" }, 1), null);
});

test("frame aligns series and keeps missing points as gaps", () => {
  const f = frame([series("a", [{ unix: 1, value: 2 }, { unix: 3, value: 4 }]), series("b", [{ unix: 2, value: 8 }])], false, true);
  assert.deepEqual(f.xs, [1, 2, 3]);
  assert.deepEqual(f.values, [[2, null, 4], [null, 8, null]]);
  assert.deepEqual(f.totals, [2, 8, 4]);
});

test("frame of empty input has a usable domain", () => {
  const f = frame([], false, true);
  assert.deepEqual(f.xs, []);
  assert.equal(f.max, 1);
});

test("a single point stays drawable", () => {
  const one = frame([series("a", [{ unix: 10, value: 0 }])], false, true);
  assert.deepEqual(one.xs, [10]);
  assert.equal(one.max, 1);
});

test("a flat zero row still divides safely", () => {
  const f = frame([series("a", [{ unix: 1, value: 0 }, { unix: 2, value: 0 }])], false, true);
  assert.equal(f.min, 0);
  assert.equal(f.max, 1);
});

test("stacked frame scales by the sum, not by one band", () => {
  const f = frame([series("a", [{ unix: 1, value: 3 }]), series("b", [{ unix: 1, value: 4 }])], true, true);
  assert.equal(f.max, 7);
});

test("a non-zero axis follows the data so a small slope stays visible", () => {
  const f = frame([series("a", [{ unix: 1, value: 100 }, { unix: 2, value: 110 }])], false, false);
  assert.ok(f.min < 100 && f.min > 90, `min ${f.min}`);
  assert.ok(f.max > 110 && f.max < 120, `max ${f.max}`);
});

test("ticks are round and at least two", () => {
  assert.deepEqual(ticks(0, 10, 4), [0, 2.5, 5, 7.5, 10]);
  assert.equal(ticks(5, 5).length, 2);
  assert.deepEqual(ticks(0, 0.0003, 3), [0, 0.0001, 0.0002, 0.0003]);
  assert.deepEqual(ticks(5, 5), [5, 5]);
  const odd = ticks(0, 37, 4);
  assert.ok(odd.length >= 2 && odd.every((value) => value >= 0 && value <= 37));
  // Below 1e-14 no decimal scaling makes the step an integer; ticks must
  // still come back distinct instead of all rounding to zero.
  const nano = ticks(0, 4e-15, 4);
  assert.ok(nano.length >= 2);
  assert.equal(new Set(nano).size, nano.length);
  assert.ok(nano.every((value) => value >= 0 && value <= 4e-15));
});

test("nearestIndex picks the closest stamp, including the edges", () => {
  assert.equal(nearestIndex([10, 20, 30], 24), 1);
  assert.equal(nearestIndex([10, 20, 30], 0), 0);
  assert.equal(nearestIndex([10, 20, 30], 99), 2);
  // A stamp exactly between two points stays on the earlier one.
  assert.equal(nearestIndex([10, 20, 30], 25), 1);
  assert.equal(nearestIndex([10, 20, 30], 26), 2);
  assert.equal(nearestIndex([], 5), 0);
});

test("runs never bridge a gap", () => {
  assert.deepEqual(runs([[1, 2, null, 4, 5]]), [[0, 1], [3, 4]]);
  // One series missing a stamp breaks the band for every series.
  assert.deepEqual(runs([[1, 2, 3], [1, null, 3]]), [[0], [2]]);
  assert.deepEqual(runs([]), []);
});

test("an unmeasured hour stays a gap and never bridges spend", () => {
  // Known at 0, unknown at 3600, known at 7200: the middle stamp must stay
  // on the axis as null, so the line breaks instead of joining 0 to 7200.
  const buckets = [
    bucket({ bucket_unix: 0, group: "zai", input_tokens: 10, output_tokens: 5 }),
    bucket({ bucket_unix: 3600, group: "zai", input_tokens: null, output_tokens: null, unknown_tokens: 1 }),
    bucket({ bucket_unix: 7200, group: "zai", input_tokens: 10, output_tokens: 5 }),
  ];
  const built = buildSeries(buckets, rankGroups(buckets, "tokens"), "tokens", 3600);
  assert.deepEqual(built[0].points.map((p) => p.value), [15, null, 15]);
  assert.deepEqual(runs([built[0].points.map((p) => p.value)]), [[0], [2]]);
});

test("one silent series does not blank the whole stacked chart", () => {
  // openrouter reports cost, zai never does. The measured band must draw.
  const buckets = [
    bucket({ bucket_unix: 0, group: "openrouter", cost: 1, cost_reports: 1 }),
    bucket({ bucket_unix: 3600, group: "openrouter", cost: 2, cost_reports: 1 }),
    bucket({ bucket_unix: 0, group: "zai", cost: null }),
    bucket({ bucket_unix: 3600, group: "zai", cost: null }),
  ];
  const built = buildSeries(buckets, rankGroups(buckets, "cost"), "cost", 3600);
  const values = built.map((one) => one.points.map((p) => p.value));
  assert.deepEqual(values, [[1, 2], [null, null]]);
  assert.deepEqual(runs(values), [[0, 1]]);
});

test("a provider with one unknown bucket does not seed a fake zero", () => {
  // Sparse reporter: zai has an unknown bucket at 0 and no bucket at all at
  // 3600. Filling that absent stamp with zero would make zai look like a
  // reporting series and cut the run of the series that do report.
  const buckets = [
    bucket({ bucket_unix: 0, group: "openrouter", cost: 1, cost_reports: 1 }),
    bucket({ bucket_unix: 3600, group: "openrouter", cost: 2, cost_reports: 1 }),
    bucket({ bucket_unix: 0, group: "zai", cost: null }),
  ];
  const built = buildSeries(buckets, rankGroups(buckets, "cost"), "cost", 3600);
  const values = built.map((one) => one.points.map((p) => p.value));
  assert.deepEqual(values, [[1, 2], [null, null]]);
  assert.deepEqual(runs(values), [[0, 1]]);
});

test("an idle hour between two busy ones lands on the axis as zero", () => {
  // Buckets exist only where calls happened. The axis itself must be a
  // regular grid, so hour 3600 shows as a real zero, not a skipped stamp.
  const buckets = [
    bucket({ bucket_unix: 0, group: "zai", input_tokens: 10, output_tokens: 5 }),
    bucket({ bucket_unix: 7200, group: "zai", input_tokens: 10, output_tokens: 5 }),
  ];
  const built = buildSeries(buckets, rankGroups(buckets, "tokens"), "tokens", 3600);
  assert.deepEqual(built[0].points.map((p) => p.value), [15, 0, 15]);
});

test("sums keep unknown tokens apart from real zeros", () => {
  const totals = sumBuckets([
    bucket({ input_tokens: 10, output_tokens: 5 }),
    bucket({ input_tokens: null, output_tokens: null, unknown_tokens: 2 }),
    bucket({ input_tokens: 0, output_tokens: 0 }),
  ]);
  assert.equal(totals.input, 10);
  assert.equal(totals.output, 5);
  assert.equal(totals.unknown, 2);
  assert.equal(totals.attempts, 3);
  assert.equal(totals.inputReports, 2);
  assert.equal(totals.outputReports, 2);
});

test("cost sums only reported numbers and counts the reports", () => {
  const totals = sumBuckets([bucket({ cost: 0.25, cost_reports: 1 }), bucket({ cost: null }), bucket({ cost: 0.5, cost_reports: 2 })]);
  assert.equal(totals.cost, 0.75);
  assert.equal(totals.costReports, 3);
  assert.equal(sumBuckets([]).costReports, 0);
});

test("valueOf returns null for an unreported amount, zero for a real zero", () => {
  assert.equal(valueOf(bucket({ input_tokens: null, output_tokens: null }), "tokens"), null);
  assert.equal(valueOf(bucket({ input_tokens: 0, output_tokens: 0 }), "tokens"), 0);
  assert.equal(valueOf(bucket({ input_tokens: null, output_tokens: 4 }), "tokens"), 4);
  assert.equal(valueOf(bucket({ cost: null }), "cost"), null);
  assert.equal(valueOf(bucket({ attempts: 7 }), "attempts"), 7);
});

test("ranking follows the chosen metric and breaks ties by name", () => {
  const buckets = [
    bucket({ group: "b", input_tokens: 1, output_tokens: 0, attempts: 9 }),
    bucket({ group: "a", input_tokens: 1, output_tokens: 0, attempts: 1 }),
    bucket({ group: "c", input_tokens: 50, output_tokens: 0, attempts: 2 }),
  ];
  assert.deepEqual(rankGroups(buckets, "tokens").map((l) => l.group), ["c", "a", "b"]);
  assert.deepEqual(rankGroups(buckets, "attempts").map((l) => l.group), ["b", "c", "a"]);
});

test("the tail becomes one other band and gaps stay gaps", () => {
  const buckets = [];
  for (let index = 0; index < 9; index += 1) {
    buckets.push(bucket({ bucket_unix: 100, group: `p${index}`, input_tokens: 100 - index, output_tokens: 0 }));
  }
  // The last group reported no tokens at the second stamp: a gap, not zero.
  buckets.push(bucket({ bucket_unix: 200, group: "p0", input_tokens: 5, output_tokens: 0 }));
  buckets.push(bucket({ bucket_unix: 200, group: "p8", input_tokens: null, output_tokens: null, unknown_tokens: 1 }));
  const leaders = rankGroups(buckets, "tokens");
  const built = buildSeries(buckets, leaders, "tokens", 100);
  assert.equal(built.length, 8);
  const other = built.at(-1);
  assert.equal(other.label, "other (2)");
  // p8 is in the tail. Its unknown bucket stays on the axis as null: the
  // stamp must not vanish, or the chart would bridge an unmeasured hour.
  assert.deepEqual(other.points.map((p) => p.unix), [100, 200]);
  assert.equal(other.points[1].value, null);
  assert.equal(built[0].points[1].value, 5);
  assert.equal(built[0].points.length, 2);
  // Every group is counted once: head bands plus the tail equal the total.
  const drawn = built.reduce((sum, one) => sum + one.points.reduce((s, p) => s + p.value, 0), 0);
  assert.equal(drawn, sumBuckets(buckets).input);
});

test("usage columns include quiet edges and clip to the requested period", () => {
  const rows = [bucket({bucket_unix: 3600, input_reports: 0, output_reports: 1, input_tokens: null, output_tokens: 0}),
    bucket({bucket_unix: 7200, input_reports: 0, output_reports: 0, input_tokens: null, output_tokens: null})];
  const [band] = buildSeries(rows, rankGroups(rows, "tokens"), "tokens", 3600, {sinceUnix: 60, toUnix: 10801});
  assert.deepEqual(band.points.map(p => [p.from, p.to, p.value, p.attempts, p.partial]), [
    [60, 3600, 0, 0, false], [3600, 7200, 0, 1, true], [7200, 10800, null, 1, true], [10800, 10801, 0, 0, false],
  ]);
});

test("long archives keep middle observations with a bounded number of columns", () => {
  const rows = [0, 4000, 6000].map(h => bucket({bucket_unix: h * 3600, cost: 0.25, cost_reports: 1}));
  const [band] = buildSeries(rows, rankGroups(rows, "cost"), "cost", 3600);
  assert.ok(band.points.length <= 180);
  assert.equal(band.points.reduce((sum, p) => sum + p.value, 0), 0.75);
  assert.equal(band.points.at(-1).to, 6001 * 3600);
});

test("no buckets means no series, not a fake zero line", () => {
  assert.deepEqual(buildSeries([], [], "tokens"), []);
});

const observation = (over) => ({
  provider_id: "deepseek",
  resource: "account",
  metric: "money",
  unit: "USD",
  limit: null,
  usage: null,
  remaining: "10",
  window: null,
  resets_at_unix: null,
  observed_at_unix: 0,
  ...over,
});

test("two currencies of one account are never added together", () => {
  const rows = [observation({ unit: "CNY", remaining: "419.29" }), observation({ remaining: "9.25" })];
  const { parts, percent } = groupAmounts(rows);
  assert.deepEqual(parts, [
    { unit: "CNY", usage: null, limit: null, remaining: 419.29 },
    { unit: "USD", usage: null, limit: null, remaining: 9.25 },
  ]);
  assert.equal(percent, null, "mixed units share no bar");
});

test("a balance without usage and limit is not a zero of zero", () => {
  const { parts, percent } = groupAmounts([observation({ remaining: "9.25" })]);
  assert.deepEqual(parts, [{ unit: "USD", usage: null, limit: null, remaining: 9.25 }]);
  assert.equal(percent, null);
  assert.deepEqual(groupAmounts([]).parts, []);
  assert.deepEqual(groupAmounts([observation({ remaining: null })]).parts, []);
});

test("counters of one unit sum and give a fill percent", () => {
  const rows = [
    observation({ metric: "requests", unit: null, usage: "30", limit: "100", remaining: null }),
    observation({ metric: "requests", unit: null, usage: "20", limit: "100", remaining: null }),
  ];
  const { parts, percent } = groupAmounts(rows);
  assert.deepEqual(parts, [{ unit: "", usage: 50, limit: 200, remaining: null }]);
  assert.equal(percent, 25);
});

test("burn and forecast need a shrinking money series", () => {
  const now = Math.floor(Date.now() / 1000);
  const current = observation({ remaining: "10", observed_at_unix: now });
  const history = [observation({ remaining: "20", observed_at_unix: now - 86_400 }), current];
  assert.equal(burnPerDay(current, history), 10);
  assert.equal(daysLeft(current, history), 1);
  // A top-up is not a negative forecast.
  const rising = [observation({ remaining: "5", observed_at_unix: now - 86_400 }), current];
  assert.equal(daysLeft(current, rising), null);
  // A five-minute sample must not become a confident yearly rate.
  const brief = [observation({ remaining: "10.01", observed_at_unix: now - 300 }), current];
  assert.equal(burnPerDay(current, brief), null);
  assert.equal(daysLeft(current, brief), null);
  // An hour of history shows the rate but not a "608 days left" guess.
  const hour = [observation({ remaining: "10.4", observed_at_unix: now - 3600 }), current];
  assert.ok(burnPerDay(current, hour) !== null);
  assert.equal(daysLeft(current, hour), null);
  // One point, a refillable window and a non-money metric give no forecast.
  assert.equal(daysLeft(current, [current]), null);
  assert.equal(daysLeft(observation({ window: "daily", remaining: "10" }), history), null);
  // Credits are also a balance that can run out; the same trend applies.
  assert.equal(burnPerDay(observation({ metric: "credits" }), history), 10);
});

test("balance risk marks exhausted and low snapshots", () => {
  assert.equal(balanceRisk(observation({ usage: "100", limit: "100", remaining: null })), "exhausted");
  assert.equal(balanceRisk(observation({ remaining: "0" })), "exhausted");
  assert.equal(balanceRisk(observation({ usage: "90", limit: "100", remaining: null })), "low");
  assert.equal(balanceRisk(observation({ remaining: "10" })), "ok");
  assert.equal(balanceRisk(observation({ remaining: "10", usage: null }, 5), 5), "low");
  // A daily counter reports used plus what is left until reset. Zero used
  // means a full quota; its remaining balance must never look exhausted.
  assert.equal(
    balanceRisk(
      observation({
        window: "daily",
        metric: "requests",
        usage: "0",
        limit: "20",
        remaining: "20",
      }),
    ),
    "ok",
  );
  assert.equal(
    balanceRisk(
      observation({
        window: "daily",
        metric: "requests",
        usage: "18",
        limit: "20",
        remaining: "2",
      }),
    ),
    "low",
  );
  assert.equal(
    balanceRisk(
      observation({
        window: "daily",
        metric: "requests",
        usage: "20",
        limit: "20",
        remaining: "0",
      }),
    ),
    "exhausted",
  );
  assert.equal(
    balanceRisk(observation({ usage: "10", limit: "0", remaining: "10" })),
    "ok"
  );
  // Kimi reports quota use as a zero-to-one ratio with no limit field.
  assert.equal(
    balanceRisk(observation({ metric: "ratio", usage: "1", limit: null, remaining: null })),
    "exhausted"
  );
  assert.equal(
    balanceRisk(observation({ metric: "ratio", usage: "0.9395", limit: null, remaining: null })),
    "low"
  );
  // A spent prepaid pack (no window) still runs out at zero left.
  assert.equal(balanceRisk(observation({ metric: "money", usage: "100", limit: "100", remaining: "0" })), "exhausted");
});

test("a zoomed level axis keeps the line off the floor and states the change", () => {
  // 419.29 -> 419.26 is 0.007%: the plot must not read as a crash to zero.
  const points = [
    { unix: 0, value: 419.29 },
    { unix: 3600, value: 419.26 },
  ];
  const built = frame([series("CNY", points)], false, false);
  // The domain has a floor of 2% of the level, so this 0.03 change draws a
  // nearly flat line. Padding alone would stretch it over the whole height.
  assert.ok(built.max - built.min >= 419.29 * 0.02, `span ${built.max - built.min}`);
  const share = (419.29 - 419.26) / (built.max - built.min);
  assert.ok(share < 0.05, `change takes ${share} of the plot height`);
  assert.ok(built.min < 419.26 && built.max > 419.29);
  // A real drop must still be readable: a fifth of the balance fills the plot.
  const drop = frame([series("CNY", [{ unix: 0, value: 100 }, { unix: 3600, value: 80 }])], false, false);
  assert.ok(20 / (drop.max - drop.min) > 0.5, `drop takes ${20 / (drop.max - drop.min)}`);
  const moved = change(built.values[0]);
  assert.equal(moved.from, 419.29);
  assert.equal(moved.to, 419.26);
  assert.ok(Math.abs(moved.delta + 0.03) < 1e-9);
  assert.ok(Math.abs(moved.percent + 0.00715) < 1e-4);
  // One point or an empty row says nothing about change.
  assert.equal(change([1]), null);
  assert.equal(change([null, null]), null);
  // A zero start has no percentage, but the amount still stands.
  assert.deepEqual(change([0, 5]), { from: 0, to: 5, delta: 5, percent: null });
});

test("a flat level still gets a readable axis", () => {
  // A drained account reports zero forever: the domain must not collapse to
  // 1e-16, or every axis label prints the same number.
  const flat = frame([series("CNY", [{ unix: 0, value: 0 }, { unix: 3600, value: 0 }])], false, false);
  assert.ok(flat.max - flat.min >= 1, `span ${flat.max - flat.min}`);
  const labels = ticks(flat.min, flat.max, 4).map((value) => value.toFixed(axisDecimals(flat.min, flat.max, 4)));
  assert.equal(new Set(labels).size, labels.length, labels.join(","));
  // A flat negative level keeps its sign and stays drawable.
  const owed = frame([series("CNY", [{ unix: 0, value: -5 }, { unix: 3600, value: -5 }])], false, false);
  assert.ok(owed.min < -5 && owed.max > -5);
});

test("axis labels keep enough decimals to stay apart", () => {
  assert.equal(axisDecimals(0, 100, 4), 0);
  assert.ok(axisDecimals(419.26, 419.29, 4) >= 3);
  assert.ok(axisDecimals(0, 0.0004, 4) >= 4);
  // A flat domain must not ask for infinite precision.
  assert.equal(axisDecimals(5, 5, 4), 0);
});

test("a quota shows capacity left; missing readings never look full or empty", () => {
  const row = observation({ metric: "requests", window: "daily", usage: "0", limit: "20", remaining: null });
  assert.deepEqual(balanceReading(row), { left: 20, used: 0, limit: 20, percentLeft: 100 });
  assert.equal(balanceReading({ ...row, remaining: "5", usage: null }).percentLeft, 25);
  assert.equal(balanceReading({ ...row, usage: null, remaining: " " }).left, null);
  assert.equal(balanceRisk({ ...row, remaining: "0", limit: null, usage: null }), "exhausted");
  assert.equal(balanceReading({ ...row, metric: "ratio", usage: "0.9395", limit: null }).used, 93.95);
});

test("account balances stay separate; only matching window counters share a display row", () => {
  const first = observation({ metric: "tokens", unit: "tokens", window: "daily", usage: "0", limit: "20", remaining: "20" });
  const next = { ...first, resource: "second" };
  const groups = readingGroups([first, next, { ...next, limit: "40" }, { ...next, unit: "USD" }, { ...next, resets_at_unix: 123 }]);
  assert.deepEqual(groups.map(g => g.length), [2, 1, 1, 1]);
  assert.equal(readingGroups([first, next].map(r => ({ ...r, window: null }))).length, 2);
});

test("extreme finite values cannot hang tick generation", () => {
  // Two 1e308 balances used to overflow the midpoint to Infinity and spin
  // the loop forever; the domain must fall back instead.
  const huge = frame(
    [series("a", [{ unix: 1, value: 1e308 }, { unix: 2, value: 1e308 }])],
    false,
    false,
  );
  assert.ok(Number.isFinite(huge.min));
  assert.ok(Number.isFinite(huge.max));
  assert.ok(huge.max > huge.min);
  const onHuge = ticks(huge.min, huge.max, 4);
  assert.ok(onHuge.every((tick) => Number.isFinite(tick)));
  // A tiny changing level must give distinct ticks and distinct labels.
  const tiny = frame(
    [series("a", [{ unix: 1, value: 1e-9 }, { unix: 2, value: 1.001e-9 }])],
    false,
    false,
  );
  const onTiny = ticks(tiny.min, tiny.max, 4);
  const decimals = axisDecimals(tiny.min, tiny.max, 4);
  const labels = onTiny.map((tick) => tick.toFixed(decimals));
  assert.equal(new Set(labels).size, labels.length);
});

test("catalog grouping uses the core's key, whatever spelling it chose", () => {
  // The UI must not normalize these ids itself: the key arrives in the row.
  const rows = [
    { upstream_id: "z-ai/glm-5.3:free", knowledge_key: "glm-5-3", provider_id: "openrouter" },
    { upstream_id: "glm-5.3", knowledge_key: "glm-5-3", provider_id: "zai" },
    { upstream_id: "cursor-hy4", knowledge_key: "hy4", provider_id: "tokenator" },
  ];
  const grouped = groupByKnowledgeKey(rows);
  assert.deepEqual([...grouped.keys()], ["glm-5-3", "hy4"]);
  assert.equal(grouped.get("glm-5-3").length, 2);
  assert.equal(grouped.get("hy4")[0].provider_id, "tokenator");
  // An unknown spelling simply becomes its own group, never a guessed merge.
  const single = groupByKnowledgeKey([{ upstream_id: "x", knowledge_key: "x" }]);
  assert.deepEqual([...single.keys()], ["x"]);
});

test("usage model groups split at the first slash only", () => {
  assert.deepEqual(splitModelGroup("zai/glm-4.6"), { providerId: "zai", upstreamId: "glm-4.6" });
  assert.deepEqual(splitModelGroup("openrouter/qwen/qwen3-coder:free"), {
    providerId: "openrouter",
    upstreamId: "qwen/qwen3-coder:free",
  });
  assert.equal(splitModelGroup("other (2)"), null);
  assert.equal(splitModelGroup("/no-provider"), null);
});

test("only model-shaped balance resources get a knowledge hover", () => {
  assert.equal(looksLikeModelId("qwen/qwen3-coder:free"), true);
  assert.equal(looksLikeModelId("glm-4.6"), true);
  assert.equal(looksLikeModelId("cursor-gpt-5"), true);
  assert.equal(looksLikeModelId("account"), false);
  assert.equal(looksLikeModelId("subscription"), false);
});

test("researched sources open only as http(s) links", () => {
  assert.equal(safeHttpUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(safeHttpUrl("http://example.com"), "http://example.com/");
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,x"), null);
  assert.equal(safeHttpUrl("not a url"), null);
});

test("vendor badges are stable and recognize known labs", () => {
  assert.equal(vendorColor("Anthropic"), "orange");
  assert.equal(vendorColor("OpenAI"), "teal");
  assert.equal(vendorColor("Alibaba Cloud"), "violet");
  assert.equal(vendorColor(null), "gray");
  assert.equal(vendorColor("Acme Labs"), vendorColor("Acme Labs"));
});

test("image-input evidence needs an input direction and excludes image output",()=>{
  for (const s of ["Text and image input; text output","Multimodal input (text, image, video); text output","Text, image, and video input; text output","text + images -> text"]) assert(documentsImageInput(s),s);
  for (const s of [null,"text","vision","Text input; image output","Text input, image output","text-to-image","no image input","text -> images","images generated from text input"]) assert(!documentsImageInput(s),s);
});
test("task evidence compares like measurements, not logo design or overall coding scores",()=>{
  const rows=["a","b","c","d"].map((id,i)=>({provider_id:"p",upstream_id:id,knowledge_key:id,context_tokens:null}));
  const rating=(metric,value,source="Lab")=>({metric,value,source,as_of:"2026-01"});
  const cards=[{key:"a",primary_use:"frontend implementation",ratings:[rating("WebDev Elo",1100),rating("Coding Index",90)]},
    {key:"b",modality:"image input; text output",ratings:[rating("WebDev Elo",1200),rating("ScreenSpot accuracy",0)]},
    {key:"c",description:"Not for UI tasks",ratings:[rating("WebDev Elo",5000,"Other lab"),rating("Logo Elo",99),rating("WebDev rank",1)]},
    {key:"d",ratings:[rating("WebDev Elo",1250),rating("WebDev Elo",1300)]}];
  const run=(goal,e,bans=[])=>poolSuggestions(rows,[],[],"",goal,"","",bans,0,e.byKey);
  const ui=poolEvidence(rows,cards,"design","");
  // One benchmark family is one column, whoever measured it: Coding Index and Logo Elo are not design tests.
  assert.equal(ui.options.length,1);assert.equal(ui.metric.id,"webdev arena elo");assert.equal(ui.metric.count,4);
  assert.equal(ui.byKey.get("c").task,null);
  assert.equal(ui.byKey.get("d").result.rating.value,1250);
  // Evidence ranks by the design score, all four models included.
  assert.deepEqual(run("design",ui).slice(0,4).map(r=>r.model.upstream_id),["c","d","b","a"]);
  // A requested benchmark the goal does not allow falls back to the allowed one.
  assert.equal(poolEvidence(rows,cards,"design","coding index").metric.id,"webdev arena elo");
  const alt=poolEvidence(rows,cards,"design","webdev arena elo");
  assert.equal(poolSuggestions(rows,[],[],"","design","","",[],0,alt.byKey,true)[0].model.upstream_id,"b");
  const vis=poolEvidence(rows,cards,"vision","");assert.equal(vis.options.length,1);assert.equal(vis.byKey.get("b").result.rating.value,0);
  assert.equal(run("vision",vis)[0].model.upstream_id,"b");assert.equal(run("vision",vis,[{...rows[1],expires_at_unix:9}]).at(-1).model.upstream_id,"b");
  assert.equal(poolEvidence(rows,[],"vision","").metric,undefined);
});
test("free labels belong to the route, not a family, vendor name or substring", () => {
  for (const id of ["vendor/x:free", "hy4-flash-free", "openrouter/free"]) assert.equal(freeLabel(id), true);
  for (const id of ["free-lab/x", "vendor/freedom", "vendor/x:preview", "x-free-pro"]) assert.equal(freeLabel(id), false);
});
test("inline use cases distinguish researched facts, hints and missing data", () => {
  const r = {upstream_id:"lab/x-coder"};
  assert.deepEqual(modelBrief(r), {text:"Coding",source:"ID hint"});
  assert.deepEqual(modelBrief(r,{primary_use:" Edit repositories ",description:"Other"}), {text:"Edit repositories",source:"Model Wiki"});
  assert.deepEqual(modelBrief(r,{description:"From Wiki"}), {text:"From Wiki",source:"Model Wiki"});
  assert.equal(modelBrief({upstream_id:"coder/ordinary"}).source,"");
});
test("inventory search includes the use case and keeps aliases and unknown context distinct", () => {
  const rows = ["lab/m","lab/m:free","lab/x"].map((upstream_id,i)=>({upstream_id,knowledge_key:i===2?"x":"m", context_tokens:[2000,1000,null][i]}));
  const cards = new Map([["m",{canonical_name:"Model",primary_use:"Code review"}]]);
  assert.deepEqual(inventoryRows(rows,cards,"review",true,"free").map(x=>x.row.upstream_id),["lab/m:free"]);
  assert.deepEqual(inventoryRows(rows,cards,"",false,"context").map(x=>x.row.context_tokens),[2000,1000,null]);
  assert.equal(inventoryRows(rows,cards,"absent",false,"name").length,0);
  assert.equal(inventoryRows(rows,cards,"",false,"free")[0].row.upstream_id,"lab/m:free");
});
test("idle capacity is not a price or a guess from invalid counts", () => {
  assert.equal(idleSlots({slots:4,busy:1}),3); assert.equal(idleSlots({slots:2,busy:2}),0);
  for(const busy of [null,-1,3,1.5]) assert.equal(idleSlots({slots:2,busy}),null);
});

console.log(`\n${checks} checks passed`);