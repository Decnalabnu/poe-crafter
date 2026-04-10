const fs = require('fs');
const itemsData = JSON.parse(fs.readFileSync('./src/data/items.json', 'utf8'));
const fossilData = JSON.parse(fs.readFileSync('./src/data/fossils.json', 'utf8'));

function getSmartWeight(m, tag) { return (m.base_weights && m.base_weights[tag]) || 0; }
function applyFossils(pool, fossils) {
  if (!fossils.length) return pool;
  return pool.map(mod => {
    if (mod.weight === 0) return { ...mod, _z: true };
    let w = mod.weight;
    for (const fid of fossils) {
      const f = fossilData[fid]; if (!f) continue;
      let m = 1, z = false;
      for (const t of (mod.mod_tags||[])) { if (f.multipliers[t]!==undefined) { if(f.multipliers[t]===0) z=true; else m*=f.multipliers[t]; } }
      if (z) w = 0; else w *= m;
    }
    return { ...mod, weight: w };
  }).filter(m => m.weight > 0 || m._z);
}
function sat(m, tm) {
  if (m.group !== tm.group) return false;
  if (m.tier !== undefined && tm.tier !== undefined) return m.tier <= tm.tier;
  return m.id === tm.id;
}
function ep(mask, draws, ntW, tgts, memo) {
  if (mask === 0) return 1;
  if (draws === 0) return 0;
  let tr = 0; for (let i = 0; i < tgts.length; i++) if (mask&(1<<i)) tr++;
  if (tr > draws) return 0;
  const key = mask+','+draws+','+ntW.join(',');
  const c = memo.get(key); if (c !== undefined) return c;
  let tw = 0; for (const w of ntW) tw += w;
  for (let i = 0; i < tgts.length; i++) if (mask&(1<<i)) tw += tgts[i].groupTotalWeight;
  if (!tw) { memo.set(key,0); return 0; }
  let r = 0;
  for (let i = 0; i < tgts.length; i++) {
    if (!(mask&(1<<i))) continue;
    const p = tgts[i].effectiveWeight/tw;
    if (p > 0) r += p * ep(mask&~(1<<i), draws-1, ntW, tgts, memo);
  }
  const seen = new Set();
  for (let j = 0; j < ntW.length; j++) {
    const w = ntW[j]; if (seen.has(w)) continue; seen.add(w);
    let cnt = 0; for (let k = 0; k < ntW.length; k++) if (ntW[k]===w) cnt++;
    const nn = ntW.slice(); nn.splice(nn.indexOf(w),1);
    r += (w*cnt/tw) * ep(mask, draws-1, nn, tgts, memo);
  }
  memo.set(key, r); return r;
}

function calcP(targetIds, fracId, fossils, configs) {
  const tag = 'int_armour';
  const pool = itemsData.body_armour;
  const ok = m => (m.required_level||0) <= 100;

  let vP = pool.prefixes.filter(m=>!m.influence).filter(m=>ok(m)||m.id===fracId)
    .map(m=>({...m,weight:getSmartWeight(m,tag),isPrefix:true})).filter(m=>m.weight>0||m.id===fracId);
  let vS = pool.suffixes.filter(m=>!m.influence).filter(ok)
    .map(m=>({...m,weight:getSmartWeight(m,tag),isPrefix:false})).filter(m=>m.weight>0);
  vP = applyFossils(vP, fossils); vS = applyFossils(vS, fossils);

  let fMod = fracId !== 'none' ? (vP.find(m=>m.id===fracId)||vS.find(m=>m.id===fracId)) : null;
  const ppG = fMod ? new Set([fMod.group]) : new Set();
  const rP = vP.filter(m=>!ppG.has(m.group)), rS = vS.filter(m=>!ppG.has(m.group));

  const pgw = new Map(), sgw = new Map();
  for (const m of rP) pgw.set(m.group,(pgw.get(m.group)||0)+m.weight);
  for (const m of rS) sgw.set(m.group,(sgw.get(m.group)||0)+m.weight);

  const all = vP.concat(vS);
  const res = targetIds.map(t=>all.find(m=>m.id===t)).filter(Boolean);
  const rem = fMod ? res.filter(tm=>!sat(fMod,tm)) : res;

  const ppP = fMod && fMod.isPrefix ? 1 : 0;
  const ppS = fMod && !fMod.isPrefix ? 1 : 0;

  const tgd = [];
  for (const tm of rem) {
    let eff=0,isP=null,grp=null;
    for (const m of rP) if (sat(m,tm)){eff+=m.weight;isP=true;grp=m.group;}
    if(isP===null) for(const m of rS) if(sat(m,tm)){eff+=m.weight;isP=false;grp=m.group;}
    tgd.push({effectiveWeight:eff,groupTotalWeight:(isP?pgw.get(grp):sgw.get(grp))||0,isPrefix:isP,group:grp});
  }
  const tPG=new Set(tgd.filter(t=>t.isPrefix).map(t=>t.group));
  const tSG=new Set(tgd.filter(t=>!t.isPrefix).map(t=>t.group));
  const ntP=Array.from(pgw.entries()).filter(([g])=>!tPG.has(g)).map(([,w])=>w).sort((a,b)=>b-a);
  const ntS=Array.from(sgw.entries()).filter(([g])=>!tSG.has(g)).map(([,w])=>w).sort((a,b)=>b-a);
  const pT=tgd.filter(t=>t.isPrefix),sT=tgd.filter(t=>!t.isPrefix);
  const pM=(1<<pT.length)-1,sM=(1<<sT.length)-1;
  const pm=new Map(),sm=new Map();
  let P=0;
  for(const c of configs){
    const rPP=c.p-ppP,rSS=c.s-ppS;
    if(rPP<0||rSS<0||rPP<pT.length||rSS<sT.length) continue;
    P+=c.prob*ep(pM,rPP,ntP,pT,pm)*ep(sM,rSS,ntS,sT,sm);
  }
  return P;
}

function makeConfigs(p4, p5, p6) {
  // p4/p5/p6 are percentages summing to 100, uniform P/S split within each count
  return [
    {p:1,s:3,prob:p4/300},{p:2,s:2,prob:p4/300},{p:3,s:1,prob:p4/300},
    {p:2,s:3,prob:p5/200},{p:3,s:2,prob:p5/200},
    {p:3,s:3,prob:p6/100}
  ];
}

const FOSSIL_CURR = makeConfigs(25,33,42);
const ES2  = ['LocalIncreasedEnergyShieldPercent7_','LocalIncreasedEnergyShieldPercentAndStunRecovery5'];
const COLD = 'ColdResist8';
const FRAC = 'LocalIncreasedEnergyShield11';

// Known reference points
// CoE calibration data:
// [A] Dense+Frigid, no frac, 2ES only          → 34   (prefix-only calibration)
// [B] Dense+Frigid, frac, 2ES+cold             → 493  (new issue)
// [C] Dense only,   frac, 2ES+cold             → 1827 (new issue)

console.log('=== Current FOSSIL_CONFIGS (25/33/42) ===');
const pA = calcP(ES2,'none',['dense','frigid'],FOSSIL_CURR);
const pB = calcP([...ES2,COLD],FRAC,['dense','frigid'],FOSSIL_CURR);
const pC = calcP([...ES2,COLD],FRAC,['dense'],FOSSIL_CURR);
console.log('[A] Dense+Frigid no frac 2ES:    CoE=34   ours='+Math.ceil(1/pA));
console.log('[B] Dense+Frigid frac 2ES+cold:  CoE=493  ours='+Math.ceil(1/pB));
console.log('[C] Dense frac 2ES+cold:         CoE=1827 ours='+Math.ceil(1/pC));

// Decompose: pPref and pSuff contributions per config
console.log('\n=== Per-config breakdown for scenario B (Dense+Frigid, frac, 2ES+cold) ===');
{
  const P = calcP;
  // manually log
  const tag = 'int_armour', fossils = ['dense','frigid'];
  const pool = itemsData.body_armour;
  let vP = pool.prefixes.filter(m=>!m.influence&&(m.required_level||0)<=100)
    .map(m=>({...m,weight:getSmartWeight(m,tag),isPrefix:true})).filter(m=>m.weight>0||m.id===FRAC);
  let vS = pool.suffixes.filter(m=>!m.influence&&(m.required_level||0)<=100)
    .map(m=>({...m,weight:getSmartWeight(m,tag),isPrefix:false})).filter(m=>m.weight>0);
  vP = applyFossils(vP, fossils); vS = applyFossils(vS, fossils);
  const fMod = vP.find(m=>m.id===FRAC);
  const ppG = new Set([fMod.group]);
  const rP = vP.filter(m=>!ppG.has(m.group)), rS = vS;
  const pgw = new Map(), sgw = new Map();
  for (const m of rP) pgw.set(m.group,(pgw.get(m.group)||0)+m.weight);
  for (const m of rS) sgw.set(m.group,(sgw.get(m.group)||0)+m.weight);

  // ES% targets
  const es1 = {group:'Local Energy Shield Percent',tier:2};
  const es2 = {group:'Local Energy Shield And Stun Recovery Percent',tier:2};
  const cold = {group:'Cold Resistance',tier:1};

  const pEff1=Array.from(rP).filter(m=>sat(m,es1)).reduce((s,m)=>s+m.weight,0);
  const pEff2=Array.from(rP).filter(m=>sat(m,es2)).reduce((s,m)=>s+m.weight,0);
  const sEffC=Array.from(rS).filter(m=>sat(m,cold)).reduce((s,m)=>s+m.weight,0);
  const pGT1=pgw.get('Local Energy Shield Percent')||0;
  const pGT2=pgw.get('Local Energy Shield And Stun Recovery Percent')||0;
  const sGTC=sgw.get('Cold Resistance')||0;
  const prefTotal=Array.from(pgw.values()).reduce((a,b)=>a+b,0);
  const suffTotal=Array.from(sgw.values()).reduce((a,b)=>a+b,0);

  console.log('Prefix pool (after frac+fossil): '+prefTotal);
  console.log('Suffix pool (after fossil):       '+suffTotal);
  console.log('ES% eff='+pEff1+'/'+pGT1+'  ES+Stun eff='+pEff2+'/'+pGT2+'  Cold eff='+sEffC+'/'+sGTC);

  const ntP=Array.from(pgw.entries()).filter(([g])=>g!=='Local Energy Shield Percent'&&g!=='Local Energy Shield And Stun Recovery Percent').map(([,w])=>w).sort((a,b)=>b-a);
  const ntS=Array.from(sgw.entries()).filter(([g])=>g!=='Cold Resistance').map(([,w])=>w).sort((a,b)=>b-a);

  const prefTgts=[{effectiveWeight:pEff1,groupTotalWeight:pGT1,isPrefix:true},{effectiveWeight:pEff2,groupTotalWeight:pGT2,isPrefix:true}];
  const suffTgts=[{effectiveWeight:sEffC,groupTotalWeight:sGTC,isPrefix:false}];

  // pPref(2 draws), pSuff(1), pSuff(2), pSuff(3)
  const pm=new Map(),sm=new Map();
  const pPref2=ep(3,2,ntP,prefTgts,pm);
  const pSuff1=ep(1,1,ntS,suffTgts,new Map());
  const pSuff2=ep(1,2,ntS,suffTgts,new Map());
  const pSuff3=ep(1,3,ntS,suffTgts,new Map());
  console.log('pPref(2)='+pPref2.toFixed(6)+' pSuff(1)='+pSuff1.toFixed(6)+' pSuff(2)='+pSuff2.toFixed(6)+' pSuff(3)='+pSuff3.toFixed(6));
  console.log('');

  // Contribution per config (ppP=1 so only p=3 configs)
  for (const c of FOSSIL_CURR) {
    const rPP=c.p-1, rSS=c.s;
    if(rPP<2||rSS<1) { console.log('('+c.p+'P,'+c.s+'S) prob='+c.prob.toFixed(4)+' SKIP (rP='+rPP+')'); continue; }
    const pS=rSS===1?pSuff1:rSS===2?pSuff2:pSuff3;
    const contrib=c.prob*pPref2*pS;
    console.log('('+c.p+'P,'+c.s+'S) prob='+c.prob.toFixed(4)+' rP='+rPP+' rS='+rSS+' pSuff('+rSS+')='+pS.toFixed(6)+' contrib='+contrib.toFixed(8));
  }
}

// Grid search: find p4/p5/p6 that simultaneously satisfies A=34, B=493, C=1827
console.log('\n=== Grid search: find fossil config matching all 3 CoE reference points ===');
let best={diff:Infinity,p4:0,p5:0,p6:0,a:0,b:0,c:0};
for(let p4=5;p4<=70;p4+=5) {
  for(let p5=5;p5<=70;p5+=5) {
    const p6=100-p4-p5;
    if(p6<5||p6>70) continue;
    const cfg=makeConfigs(p4,p5,p6);
    const a=Math.ceil(1/calcP(ES2,'none',['dense','frigid'],cfg));
    const b=Math.ceil(1/calcP([...ES2,COLD],FRAC,['dense','frigid'],cfg));
    const c=Math.ceil(1/calcP([...ES2,COLD],FRAC,['dense'],cfg));
    const diff=Math.abs(a-34)/34 + Math.abs(b-493)/493 + Math.abs(c-1827)/1827;
    if(diff<best.diff) best={diff,p4,p5,p6,a,b,c};
  }
}
console.log('Best fit: 4-mod='+best.p4+'% 5-mod='+best.p5+'% 6-mod='+best.p6+'%');
console.log('  [A]='+best.a+' (CoE 34)  [B]='+best.b+' (CoE 493)  [C]='+best.c+' (CoE 1827)');
console.log('  Total relative error: '+(best.diff*100).toFixed(1)+'%');

// Also check if P/S split non-uniformity explains it
// What if 6-mod split is not just (3P,3S) but we need to vary within-count weights?
console.log('\n=== What if 4-mod has non-uniform P/S split? ===');
// Try: within 4-mod (25%), bias toward (3P,1S) instead of equal 3-way split
for(const bias of [[1,1,1],[2,1,1],[3,1,1],[1,1,2],[1,1,3]]) {
  const total=bias[0]+bias[1]+bias[2];
  const cfg=[
    {p:1,s:3,prob:0.25*bias[1]/total},{p:2,s:2,prob:0.25*bias[0]/total},{p:3,s:1,prob:0.25*bias[2]/total},
    {p:2,s:3,prob:0.33/2},{p:3,s:2,prob:0.33/2},
    {p:3,s:3,prob:0.42}
  ];
  const sum=cfg.reduce((s,c)=>s+c.prob,0);
  // normalize
  cfg.forEach(c=>c.prob/=sum);
  const a=Math.ceil(1/calcP(ES2,'none',['dense','frigid'],cfg));
  const b=Math.ceil(1/calcP([...ES2,COLD],FRAC,['dense','frigid'],cfg));
  const c=Math.ceil(1/calcP([...ES2,COLD],FRAC,['dense'],cfg));
  console.log('4-mod split '+bias+': A='+a+' B='+b+' C='+c);
}
