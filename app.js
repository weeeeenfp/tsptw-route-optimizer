/* ════════════════════════════════════════════════════════════════
   LogiOps 前端 v2 — 後端驅動（前端不做路由/逾時/ETA 計算）
   ───────────────────────────────────────────────────────────────
   單一真實來源：
     S.loc[]  完整 locations（固定原始順序）；每站可帶
              status / rescheduled_time_window / priority / service_time_seconds
     S.resp   後端最後回傳的 data{}（route_indices 為原始 index）
     S.ui     介面狀態（mode/role/endMode/出發時間/手動順序…）
   單一 API：runOptimize() → buildPayload() → POST /api/v1/optimize-route → render()
   狀態 enum（後端契約）：pending/in_progress/completed/delayed/cancelled/skipped
   唯一的前端計算＝司機手動拖曳順序時自建 Google Maps 導航連結。
   ════════════════════════════════════════════════════════════════ */

const S = {
  raw: [], headers: [], colMap: {},
  loc: [],            // 完整 locations（含尾端休息點）
  restCount: 0,       // 尾端休息點數量
  resp: null,         // 後端 data{}
  receive: { raw:[], headers:[], colMap:{}, plan:null, active:false, deliverySnapshot:null },
  ui: { mode:'delivery', role:'user', endMode:'depot', manualEndIndices:[], finalEndIndex:null, manualOrder:null, dragIdx:null, optimizing:false, lastAction:null, collapseDone:false, dayRecorded:false, lastRecord:null, departedAt:null, testClock:null, endDirty:false },
};

const COLS = [
  { k:'id',       lbl:'ID',          req:true,  hints:['ID','id','編號','序號'] },
  { k:'name',     lbl:'名稱',         req:true,  hints:['Name (名稱)','Name','name','名稱','地點名稱','站點名稱'] },
  { k:'address',  lbl:'地址',         req:true,  hints:['Address (地址)','Address','address','地址','配送地址'] },
  { k:'tw_start', lbl:'最早可抵達',    req:false, hints:['Time Window Start','tw_start','time_window_start','開始時間','最早'] },
  { k:'tw_end',   lbl:'最晚可抵達',    req:false, hints:['Time Window End','tw_end','time_window_end','結束時間','最晚'] },
  { k:'priority', lbl:'優先權(1-5)',  req:false, hints:['Priority','priority','優先權','優先序'] },
  { k:'service',  lbl:'服務時間(秒)',  req:false, hints:['Service','service_time_seconds','服務時間'] },
];

const EXCLUDED = ['completed','cancelled','skipped'];   // 重排時後端會排除的狀態

/* ─── utils ──────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
function esc(s){ return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function secToHM(sec){ if(sec==null||isNaN(sec)) return '—'; sec=((Math.round(sec)%86400)+86400)%86400; const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60); return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; }
function hmToSec(hm){ if(!hm) return 0; const p=String(hm).split(':').map(Number); return (p[0]||0)*3600+(p[1]||0)*60+(p[2]||0); }
function fmtHM(min){ const t=Math.round(min||0),h=Math.floor(t/60),m=t%60; return h>0?`${h}h ${m}m`:`${m}m`; }
function nowHM(){ const d=new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
// 預計出發時間只有訂單上傳頁的 depTime 一個來源（送貨管理只顯示「實際出發時間」，不可回頭改預計）。
function departureHM(){ return ($('depTime') && $('depTime').value) || '09:00'; }   // 預計出發時間（預設 09:00）
// 管理員測試時鐘：不佔畫面欄位，開頭＝實際出發時間（未出發則用預計），之後隨標記送達往前推。
function testClockHM(){ return S.ui.testClock || S.ui.departedAt || departureHM(); }
function setTestClock(hm){ if(hm) S.ui.testClock=hm; }
function isAdmin(){ return S.ui.role==='admin'; }
// 新的一趟行程：清掉實際出發時間與測試時鐘，讓「出發」按鈕可以重新按一次。
function resetDeparture(){ S.ui.departedAt=null; S.ui.testClock=null; if($('departTime')) $('departTime').value=''; }
// 動作（送達／取消／跳過／延後／復原）與途中重排的基準時間：
// 一般使用者一律抓本地時間（不可自填）；系統管理員才用測試時鐘，方便重現特定時刻的情境。
function clockHM(){ return isAdmin() ? testClockHM() : nowHM(); }
function updateDriverClock(){ const el=$('driverClock'); if(el) el.textContent=nowHM(); }
function addMinutesHM(hm, minutes){
  const base=hmToSec(hm), next=Math.max(0, Math.min(86340, base + minutes*60));
  return secToHM(next);
}
function twToStrings(tw){ if(!Array.isArray(tw)) return ['00:00','23:59']; const f=v=>typeof v==='string'?v:(v>=86399?'23:59':secToHM(v)); return [f(tw[0]),f(tw[1])]; }
// 解析 Excel 時間窗欄位 → 統一輸出 "HH:MM"。支援兩種輸入：
//   ① "HH:MM" / "HH:MM:SS" 字串（README 建議格式）→ 原樣帶過
//   ② 數字秒數（舊測資 0~86399，>86399 或 0 的結束視為全天）→ 轉成 HH:MM
function parseTW(v, isEnd){
  const s = String(v ?? '').trim();
  if (s === '') return isEnd ? '23:59' : '00:00';                  // 未填 → 全天
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)){                         // 已是 24 小時制字串
    const [h, m] = s.split(':');
    return `${String(Math.min(+h, 23)).padStart(2,'0')}:${m.padStart(2,'0')}`;
  }
  const dt = new Date(s);
  if(!isNaN(dt.getTime()) && /\d{1,2}:\d{2}/.test(s)){
    return `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
  }
  const n = Number(s);                                             // 數字 → 視為秒數
  if (!isNaN(n)){
    if(n > 0 && n < 1) return secToHM(Math.round(n * 86400));      // Excel time fraction
    if(!Number.isInteger(n) && n > 1 && n < 60000) return secToHM(Math.round((n % 1) * 86400)); // Excel date serial
    if (isEnd && (n <= 0 || n > 86399)) return '23:59';
    return secToHM(Math.max(0, Math.min(n, 86399)));
  }
  return isEnd ? '23:59' : '00:00';
}
function apiBase(){ return $('apiBase').value.replace(/\/+$/,''); }
function toast(msg,type='i'){ const ic={s:'✓',e:'✕',i:'ℹ',w:'⚠'}; const el=document.createElement('div'); el.className=`toast ${type}`; el.innerHTML=`<span>${ic[type]||'ℹ'}</span><span>${esc(msg)}</span>`; $('toasts').appendChild(el); setTimeout(()=>el.style.cssText='opacity:0;transition:opacity .4s',3000); setTimeout(()=>el.remove(),3500); }
function setDot(s){ $('dot').className='dot '+s; }
function setBusy(on,msg){ const o=$('busyOverlay'); if(!o) return; if(msg) $('busyMsg').textContent=msg; o.classList.toggle('on',!!on); }
function setAlert(msg,type=''){ $('alertArea').innerHTML = msg ? `<div class="alert alert-${type}">${msg}</div>` : ''; }

/* ─── tabs / mode / role ─────────────────────────────────── */
function sw(id,btn){ document.querySelectorAll('.view').forEach(v=>v.classList.remove('on')); document.querySelectorAll('.tab').forEach(b=>b.classList.remove('on')); $('view-'+id).classList.add('on'); if(btn) btn.classList.add('on'); if(id==='history') renderHistoryView(); document.querySelectorAll('.tab').forEach(b=>b.setAttribute('aria-selected', b.classList.contains('on')?'true':'false')); renderUploadState(); }
function taskWord(){ return S.ui.mode==='receiving' ? '收貨' : '送貨'; }
function doneWord(){ return S.ui.mode==='receiving' ? '收貨' : '送達'; }
function doneActionLabel(){ return S.ui.mode==='receiving' ? '已收貨' : '已送達'; }
function serviceStartLabel(){ return S.ui.mode==='receiving' ? '開始收貨' : '開始卸貨'; }
function serviceDoneLabel(){ return S.ui.mode==='receiving' ? '完成收貨' : '完成卸貨'; }
function reportStatusLabels(){ return { delayed:`改約${taskWord()}時間`, cancelled:'客戶取消', skipped:'本輪暫時跳過' }; }
function setMode(mode, silent=false){
  S.ui.mode = mode;
  const recv = mode==='receiving';
  document.body.classList.toggle('mode-receiving',recv);
  $('dTabIco').textContent = recv?'📥':'🚚';
  $('dTabTxt').textContent = recv?'收貨管理':'送貨管理';
  $('endCardTtl').textContent = recv?'收貨':'送貨';
  $('dListTtl').textContent = recv?'收貨清單':'送貨清單';
  if(S.resp) render();
  if(!silent) toast(recv?'已切換為收貨模式（無裝車順序）':'已切換為送貨模式','i');
}
function applyRole(){
  const user = S.ui.role==='user';
  document.body.classList.toggle('role-user',user);
  if($('roleBtn')) $('roleBtn').textContent = user?'👤 一般使用者':'🛠 系統管理員';
  if(S.resp) render();   // 重繪以套用角色相關欄位（如「實際完成時間」測試輸入僅管理員可見）
}
function toggleRole(){
  S.ui.role = S.ui.role==='admin' ? 'user' : 'admin';
  applyRole();
}

/* ─── 上傳：解析 / 自動對應 / 預覽 / 歷史 ───────────────────── */
const drop=$('drop'), fi=$('fi');
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('drag');});
drop.addEventListener('dragleave',()=>drop.classList.remove('drag'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('drag');const f=e.dataTransfer.files[0];if(f)readXL(f);});
fi.addEventListener('change',e=>{ if(e.target.files[0]) readXL(e.target.files[0]); });
if($('recvFi')) $('recvFi').addEventListener('change',e=>{ if(e.target.files[0]) readReceiveXL(e.target.files[0]); });
const recvDrop=$('recvDrop');
if(recvDrop){
  recvDrop.addEventListener('dragover',e=>{e.preventDefault();recvDrop.classList.add('drag');});
  recvDrop.addEventListener('dragleave',()=>recvDrop.classList.remove('drag'));
  recvDrop.addEventListener('drop',e=>{e.preventDefault();recvDrop.classList.remove('drag');const f=e.dataTransfer.files[0];if(f)readReceiveXL(f);});
}
function inferColMap(headers){
  const out={};
  COLS.forEach(({k,hints})=>{
    out[k]=headers.find(h=>hints.some(hi=>String(h).trim().toLowerCase()===hi.toLowerCase()))||'';
  });
  return out;
}
const COMPANY_KEY='logiops_company_location';
const DEFAULT_COMPANY=Object.freeze({
  name:'國立勤益科技大學',
  address:'411030臺中市太平區坪林里中山路二段57號',
});
const LEGACY_COMPANY_ADDRESSES=new Set([
  normText('411臺中市太平區光明里中山路二段348號'),
  normText('411臺中市太平區光明里中山路二段348,350號'),
  normText('台中市太平區中山路二段348號'),
]);
function rowValue(row,colMap,k){ const c=colMap&&colMap[k]; return c?row[c]??'':''; }
function normText(s){ return String(s||'').trim().replace(/\s+/g,'').toLowerCase(); }
function companyName(){ return ($('companyName')?.value||DEFAULT_COMPANY.name).trim() || DEFAULT_COMPANY.name; }
function companyAddress(){ return ($('companyAddress')?.value||DEFAULT_COMPANY.address).trim() || DEFAULT_COMPANY.address; }
function companyLocation(){
  return {id:0,name:companyName(),address:companyAddress(),time_window:[departureHM(),'23:59'],service_time_seconds:0};
}
function setCompanyFields(company=DEFAULT_COMPANY){
  if($('companyName')) $('companyName').value=String(company.name||DEFAULT_COMPANY.name).trim()||DEFAULT_COMPANY.name;
  if($('companyAddress')) $('companyAddress').value=String(company.address||DEFAULT_COMPANY.address).trim()||DEFAULT_COMPANY.address;
}
function saveCompanySettings(){
  try{ localStorage.setItem(COMPANY_KEY, JSON.stringify({name:companyName(),address:companyAddress()})); }catch{}
}
function loadCompanySettings(){
  try{
    const saved=JSON.parse(localStorage.getItem(COMPANY_KEY)||'{}');
    const legacy=!saved.address || LEGACY_COMPANY_ADDRESSES.has(normText(saved.address));
    setCompanyFields(legacy?DEFAULT_COMPANY:saved);
    if(legacy) saveCompanySettings();
  }catch{}
}
function onCompanyChange(){
  saveCompanySettings();
  resetEndSelection(false);
  renderEndOptions();
  if(S.resp) setAlert('公司地點已更新，請重新送出後端排程。','warn');
}
function isCompanySourceRow(row,index,colMap){
  if(index!==0) return false;
  const rowAddress=String(rowValue(row,colMap,'address')||'').trim();
  const addr=companyAddress();
  return !!addr && !!rowAddress && normText(rowAddress)===normText(addr);
}
function adoptCompanyFromFirstRow(){
  if(companyAddress() || !S.raw.length || !S.colMap) return;
  const first=S.raw[0];
  if(Number(rowValue(first,S.colMap,'id'))!==0) return;
  const address=String(rowValue(first,S.colMap,'address')||'').trim();
  if(!address) return;
  if($('companyName')) $('companyName').value=String(rowValue(first,S.colMap,'name')||'公司').trim() || '公司';
  if($('companyAddress')) $('companyAddress').value=address;
  saveCompanySettings();
}
function rowToLocation(row,colMap,{defaultServiceSeconds=null}={}){
  const o={ id:Number(rowValue(row,colMap,'id'))||0, name:String(rowValue(row,colMap,'name')), address:String(rowValue(row,colMap,'address')),
    time_window:[ parseTW(rowValue(row,colMap,'tw_start'), false), parseTW(rowValue(row,colMap,'tw_end'), true) ] };
  const pr=Number(rowValue(row,colMap,'priority')); if(pr>=1&&pr<=5) o.priority=pr;
  const sv=Number(rowValue(row,colMap,'service'));
  if(defaultServiceSeconds!=null) o.service_time_seconds=sv>0?sv:defaultServiceSeconds;
  else if(sv>0) o.service_time_seconds=sv;
  return o;
}
function stationLocationsFromRows(raw,colMap,{defaultServiceSeconds=null,skipCompanyRow=true}={}){
  return raw
    .filter((row,index)=>!(skipCompanyRow && isCompanySourceRow(row,index,colMap)))
    .map(row=>rowToLocation(row,colMap,{defaultServiceSeconds}))
    .filter(l=>l.name && l.address)
    .sort((a,b)=>a.id-b.id);
}
function validateImportedRows(json,headers,kind){
  const validator=globalThis.ExcelImportValidation;
  if(!validator) throw new Error('Excel 驗證模組未載入，請重新整理頁面後再試');
  const result=validator.validateRows(json,headers,{
    kind,
    companyAddress:kind==='送貨'?companyAddress():'',
    inferCompanyFromFirstRow:kind==='送貨',
  });
  if(result.ok){
    (result.warnings||[]).forEach(message=>toast(message,'w'));
    return result;
  }
  const shown=result.errors.slice(0,3).join('；');
  const more=result.errors.length>3?`；另有 ${result.errors.length-3} 項錯誤`:'';
  const err=new Error(`${shown}${more}`);
  err.rowErrors=result.errors;   // 完整錯誤列表，供 #alertArea 常駐顯示
  throw err;
}
// 整檔被擋下時把原因常駐寫入 #alertArea；toast 數秒即消失，
// 使用者離開再回來仍看得到「檔案為何沒載入」。下次上傳或清除時解除。
function showUploadBlockedAlert(kind,fileName,err){
  const items=(err&&err.rowErrors&&err.rowErrors.length)?err.rowErrors:[(err&&err.message)||'未知錯誤'];
  setAlert(`<div><b>✕ ${kind} Excel「${esc(fileName)}」未載入</b>，整份已被擋下：`
    +`<ul style="margin:6px 0 4px 18px">${items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`
    +`<span style="opacity:.75">修正 Excel 後重新上傳即可；本訊息會保留到下次上傳或清除。</span></div>`,'err');
}
function readXL(file){
  if(file.size>10*1024*1024){ toast('檔案超過 10 MB','e'); return; }
  const rd=new FileReader();
  rd.onload=ev=>{ try{
    const wb=XLSX.read(new Uint8Array(ev.target.result),{type:'array'});
    const json=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
    if(!json.length){ toast('檔案為空','e'); return; }
    validateImportedRows(json,Object.keys(json[0]),'送貨');
    S.raw=json; S.headers=Object.keys(json[0]); S.ui.fileName=file.name;
    resetEndSelection(true); buildColMap(); adoptCompanyFromFirstRow(); renderPreview(); updateReceiveUploadAvailability();
    $('upPreview').style.display='block'; $('upHint').style.display='none'; setAlert('');
    saveHistory(file.name,json,S.headers); toast(`解析完成：${json.length} 筆`,'s');
  }catch(err){ toast('解析失敗：'+err.message,'e'); showUploadBlockedAlert('送貨',file.name,err); } };
  rd.readAsArrayBuffer(file);
}
function readReceiveXL(file){
  if(!S.raw.length){ toast('請先載入送貨 Excel，再上傳收貨 Excel','w'); return; }
  if(file.size>10*1024*1024){ toast('收貨檔案超過 10 MB','e'); return; }
  const rd=new FileReader();
  rd.onload=ev=>{ try{
    const wb=XLSX.read(new Uint8Array(ev.target.result),{type:'array'});
    const json=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
    if(!json.length){ toast('收貨檔案為空','e'); return; }
    validateImportedRows(json,Object.keys(json[0]),'收貨');
    S.receive.raw=json; S.receive.headers=Object.keys(json[0]); S.receive.colMap=inferColMap(S.receive.headers); S.receive.plan=null;
    S.ui.recvFileName=file.name;
    renderReceiveUpload(); renderUploadState();
    saveReceiveHistory(file.name,json,S.receive.headers);
    setAlert('');
    toast(`收貨資料解析完成：${json.length} 筆`,'s');
  }catch(err){ toast('收貨資料解析失敗：'+err.message,'e'); showUploadBlockedAlert('收貨',file.name,err); } };
  rd.readAsArrayBuffer(file);
}
function buildColMap(){
  S.colMap=inferColMap(S.headers); const grid=$('cmg'); grid.innerHTML='';
  COLS.forEach(({k,lbl,req,hints})=>{
    const match=S.colMap[k]||'';
    S.colMap[k]=match;
    const cls=match?'ok':(req?'miss':''), txt=match?esc(match):(req?'⚠ 未對應':'—（選填）');
    const el=document.createElement('div'); el.className='cmi';
    el.innerHTML=`<div class="cml">${lbl}${req?'<span class="cmr">*</span>':''}</div><div class="cms cms-ro ${cls}">${txt}</div>`;
    grid.appendChild(el);
  });
}
// 上傳頁狀態：已載入檔案列（取代整屏 dropzone）、三步驟指示、底部固定動作列。
// 集中在這裡計算，讓上傳／清除／換頁／改設定都只要呼叫這一支。
function renderUploadState(){
  const has=!!S.raw.length;
  const drop=$('drop'), chip=$('fileChip');
  if(drop&&chip){
    drop.style.display=has?'none':'';
    chip.style.display=has?'':'none';
    if(has){
      $('fileChipName').textContent=S.ui.fileName||'手動建立的訂單';
      $('fileChipSub').textContent=`${S.raw.length} 筆訂單 · 欄位已自動對應`;
    }
  }
  const rHas=!!S.receive.raw.length, rDrop=$('recvDrop'), rChip=$('recvFileChip');
  if(rDrop&&rChip){
    rDrop.style.display=rHas?'none':'';
    rChip.style.display=rHas?'':'none';
    if(rHas){
      $('recvFileChipName').textContent=S.ui.recvFileName||'收貨訂單';
      $('recvFileChipSub').textContent=`${S.receive.raw.length} 筆收貨點`;
    }
  }
  const setStep=(id,cls)=>{ const el=$(id); if(el) el.className='step'+(cls?' '+cls:''); };
  setStep('step1', has?'done':'on');
  setStep('step2', has?(S.resp?'done':'on'):'');
  setStep('step3', S.resp?'done':(has?'on':''));
  const bar=$('ctaBar'), sum=$('ctaSum');
  if(bar){
    const onUpload=$('view-upload')?.classList.contains('on');
    const show=has&&onUpload;
    bar.style.display=show?'':'none';
    document.body.classList.toggle('has-cta',show);
    if(has&&sum){
      const end=currentFinalStop();
      // 窄螢幕只留最關鍵的兩項，避免摘要換行把送出鈕擠掉（用 CSS 切換，縮放視窗也正確）
      sum.innerHTML=`<span class="cta-full">${taskWord()} <b>${S.raw.length}</b> 筆`
        +`　·　出發 <b>${esc(departureHM())}</b>`
        +`　·　最終站 <b>${esc(end.name||'—')}</b>`
        +(rHas?`　·　收貨 <b>${S.receive.raw.length}</b> 筆`:'')
        +(S.resp?'　·　<span class="ac">已排程，可重新送出</span>':'')
        +`</span><span class="cta-min">${taskWord()} <b>${S.raw.length}</b> 筆　·　出發 <b>${esc(departureHM())}</b></span>`;
    }
  }
}
function renderPreview(){
  const MAX=60; $('rowLbl').textContent=`${S.raw.length} 筆`;
  $('th').innerHTML=`<tr>${S.headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr>`;
  $('tb').innerHTML=S.raw.slice(0,MAX).map(r=>`<tr>${S.headers.map(h=>`<td>${esc(String(r[h]??''))}</td>`).join('')}</tr>`).join('')
    +(S.raw.length>MAX?`<tr><td colspan="${S.headers.length}" style="text-align:center;color:var(--txt3);padding:8px">… 另有 ${S.raw.length-MAX} 筆</td></tr>`:'');
  renderEndOptions();   // 重新整理送貨備選休息點清單（套用剛上傳的站點）
  renderUploadState();
}
function clearFile(){
  S.raw=[];S.headers=[];S.colMap={};resetEndSelection(true);fi.value='';
  S.ui.fileName=null;
  $('upPreview').style.display='none'; $('upHint').style.display='block'; setAlert(''); renderEndOptions();
  clearReceiveFile(false);
  updateReceiveUploadAvailability();
  renderUploadState();
}
const HKEY='logiops_uploads';
function loadHistory(){ try{ return JSON.parse(localStorage.getItem(HKEY)||'[]'); }catch{ return []; } }
function saveHistory(name,raw,headers){ try{ let h=loadHistory().filter(x=>x.name!==name); h.unshift({id:Date.now(),name,time:new Date().toISOString(),rows:raw.length,raw,headers}); localStorage.setItem(HKEY,JSON.stringify(h.slice(0,6))); }catch{} renderHistory(); }
function renderHistory(){
  const box=$('uploadHistory'); if(!box) return; const h=loadHistory();
  box.innerHTML=!h.length?'':`<div class="uh-hdr">📁 歷史上傳（點擊載入，免再次拖曳）</div>`+h.map(x=>{
    const d=new Date(x.time),p=n=>String(n).padStart(2,'0');
    return `<div class="uh-item"><button class="uh-load" onclick="loadHist(${x.id})"><span class="uh-name">${esc(x.name)}</span><span class="uh-meta">${x.rows} 筆 · ${d.getMonth()+1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}</span></button><button class="uh-del" onclick="delHist(${x.id})">✕</button></div>`;
  }).join('');
}
function loadHist(id){ const h=loadHistory().find(x=>x.id===id); if(!h)return; S.raw=h.raw;S.headers=h.headers;S.ui.fileName=h.name;resetEndSelection(true);buildColMap();adoptCompanyFromFirstRow();renderPreview();updateReceiveUploadAvailability();$('upPreview').style.display='block';$('upHint').style.display='none';setAlert('');toast(`已載入：${h.name}`,'s'); }
function delHist(id){ localStorage.setItem(HKEY,JSON.stringify(loadHistory().filter(x=>x.id!==id))); renderHistory(); }
// 收貨上傳歷史（與送貨同樣機制，獨立 localStorage key）
const RHKEY='logiops_recv_uploads';
function loadReceiveHistory(){ try{ return JSON.parse(localStorage.getItem(RHKEY)||'[]'); }catch{ return []; } }
function saveReceiveHistory(name,raw,headers){ try{ let h=loadReceiveHistory().filter(x=>x.name!==name); h.unshift({id:Date.now(),name,time:new Date().toISOString(),rows:raw.length,raw,headers}); localStorage.setItem(RHKEY,JSON.stringify(h.slice(0,6))); }catch{} renderReceiveHistory(); }
function renderReceiveHistory(){
  const box=$('recvUploadHistory'); if(!box) return; const h=loadReceiveHistory();
  box.innerHTML=!h.length?'':`<div class="uh-hdr">📁 收貨歷史上傳（點擊載入，免再次拖曳）</div>`+h.map(x=>{
    const d=new Date(x.time),p=n=>String(n).padStart(2,'0');
    return `<div class="uh-item"><button class="uh-load" onclick="loadReceiveHist(${x.id})"><span class="uh-name">${esc(x.name)}</span><span class="uh-meta">${x.rows} 筆 · ${d.getMonth()+1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}</span></button><button class="uh-del" onclick="delReceiveHist(${x.id})">✕</button></div>`;
  }).join('');
}
function loadReceiveHist(id){
  if(!S.raw.length){ toast('請先載入送貨 Excel，再載入收貨資料','w'); return; }
  const x=loadReceiveHistory().find(v=>v.id===id); if(!x)return; S.receive.raw=x.raw; S.receive.headers=x.headers; S.receive.colMap=inferColMap(x.headers); S.receive.plan=null; renderReceiveUpload(); setUploadTab('receive'); toast(`已載入收貨資料：${x.name}`,'s');
}
function delReceiveHist(id){ localStorage.setItem(RHKEY,JSON.stringify(loadReceiveHistory().filter(x=>x.id!==id))); renderReceiveHistory(); }
async function loadFixtureFromQuery(){
  const fixture = new URLSearchParams(location.search).get('fixture');
  if(!fixture) return;
  try{
    const fixturePath = `test_cases/frontend_${encodeURIComponent(fixture)}/${encodeURIComponent(fixture)}.json?v=${Date.now()}`;
    const res = await fetch(fixturePath, { cache:'no-store' });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setCompanyFields(data.company||DEFAULT_COMPANY);
    saveCompanySettings();
    const rows = Array.isArray(data.rows) ? data.rows.filter(r=>Object.values(r||{}).some(v=>String(v??'').trim()!=='')) : [];
    if(!rows.length) throw new Error('fixture 無資料');
    S.raw = rows;
    S.headers = data.headers || Object.keys(rows[0]);
    resetEndSelection(true);
    S.ui.fileName=data.name || fixture;
    buildColMap();
    adoptCompanyFromFirstRow();
    renderPreview();
    updateReceiveUploadAvailability();
    $('upPreview').style.display='block';
    $('upHint').style.display='none';
    toast(`已載入資料：${data.name || fixture}（${rows.length} 筆）`,'s');
  }catch(err){
    toast(`載入資料失敗：${err.message}`,'e');
  }
}
async function loadReceiveFixtureFromQuery(){
  const fixture = new URLSearchParams(location.search).get('receive_fixture');
  if(!fixture) return;
  if(!S.raw.length){ toast('請先載入送貨資料，再載入收貨 fixture','w'); return; }
  try{
    const fixturePath = `test_cases/frontend_${encodeURIComponent(fixture)}/${encodeURIComponent(fixture)}.json?v=${Date.now()}`;
    const res = await fetch(fixturePath, { cache:'no-store' });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rows = Array.isArray(data.rows) ? data.rows.filter(r=>Object.values(r||{}).some(v=>String(v??'').trim()!=='')) : [];
    if(!rows.length) throw new Error('receive fixture 無資料');
    S.receive.raw=rows;
    S.receive.headers=data.headers || Object.keys(rows[0]);
    S.receive.colMap=inferColMap(S.receive.headers);
    S.receive.plan=null;
    renderReceiveUpload();
    toast(`已載入收貨資料：${data.name || fixture}（${rows.length} 筆）`,'s');
  }catch(err){
    toast(`載入收貨資料失敗：${err.message}`,'e');
  }
}

/* ─── 新增訂單（手動輸入或丟檔案；途中新增會自動重排）────── */
// 新訂單寫回 S.raw（與 Excel 同一份資料源），欄名沿用 COLS 可辨識欄名；
// Excel 缺少的選填欄位（優先權/服務時間…）會自動補上欄位再寫入。
// 手動單筆與檔案批次共用 appendOrders()：已排程時 push 進 S.loc 尾端並重打後端重排。
const ADD_ORDER_HEADERS={ id:'ID', name:'名稱', address:'地址', tw_start:'開始時間', tw_end:'結束時間', priority:'優先權', service:'服務時間' };
const RECOMMENDED_STATIONS=24;   // 建議適用規模（連同公司共 25 個正式地點）；不是硬性上限，超過只提示
function stationRowCount(){ return (S.raw.length && S.colMap) ? stationLocationsFromRows(S.raw,S.colMap,{skipCompanyRow:true}).length : 0; }
function nextOrderId(){
  let mx=0;
  S.raw.forEach(r=>{ const v=Number(rowValue(r,S.colMap,'id')); if(isFinite(v) && v<900000 && v>mx) mx=v; });
  S.loc.forEach(l=>{ const v=Number(l&&l.id); if(isFinite(v) && v<900000 && v>mx) mx=v; });
  return mx+1;
}
function ensureOrderColumns(){
  if(!S.headers.length){ S.headers=Object.values(ADD_ORDER_HEADERS); S.colMap=inferColMap(S.headers); buildColMap(); return; }
  let added=false;
  Object.entries(ADD_ORDER_HEADERS).forEach(([k,h])=>{
    if(!S.colMap[k]){ if(!S.headers.includes(h)) S.headers.push(h); added=true; }
  });
  if(added) buildColMap();   // 重新自動對應並更新欄位對應顯示
}
function openAddOrder(){
  if(addOrderBlocked()) return;
  const m=$('addOrderModal'); if(!m) return;
  $('addOrderHint').textContent=S.ui.mode==='receiving'
    ? '收貨途中新增：收貨點會加入收貨清單，並固定收貨起點重新排程剩餘路線'
    : (S.resp
      ? '途中新增：訂單會加入送貨清單，並以目前狀態重新排程剩餘路線'
      : '填寫客戶名稱與地址即可；其餘欄位留空使用預設值');
  $('aoIdHint').textContent=`訂單 ID 由系統自動編號：#${S.ui.mode==='receiving'?nextReceiveOrderId():nextOrderId()}`;
  $('aoName').value=''; $('aoAddress').value='';
  $('aoTwStart').value='09:00'; $('aoTwEnd').value='18:00';
  $('aoPriority').value=''; $('aoService').value='';
  m.classList.add('on');
  $('aoName').focus();
}
function closeAddOrder(){ const m=$('addOrderModal'); if(m) m.classList.remove('on'); }
async function submitAddOrder(){
  if(addOrderBlocked()) return false;
  const name=$('aoName').value.trim(), address=$('aoAddress').value.trim();
  if(!name){ toast('請填寫客戶 / 地點名稱','w'); return false; }
  if(!address){ toast('請填寫配送地址','w'); return false; }
  const twS=$('aoTwStart').value||'00:00', twE=$('aoTwEnd').value||'23:59';
  if(hmToSec(twS)>hmToSec(twE)){ toast('最早可抵達不可晚於最晚可抵達','w'); return false; }
  if(S.ui.mode!=='receiving' && stationRowCount()>=RECOMMENDED_STATIONS){ toast(`送貨點將超過建議規模 ${RECOMMENDED_STATIONS} 筆；仍可新增，但建議提高求解 timeout`,'w'); }
  const pr=Number($('aoPriority').value)||null;
  const svcRaw=$('aoService').value;
  const svcMin=svcRaw===''?null:Number(svcRaw);
  if(svcMin!=null && !(svcMin>=0 && svcMin<=1440)){ toast('服務時間需為 0–1440 分鐘','w'); return false; }
  const svcSec=(svcMin && svcMin>0)?Math.round(svcMin*60):null;   // 0 或留空＝用後端預設（與 Excel 匯入規則一致）
  setBusy(true,'地址驗證中…');
  let vmap=null;
  try{ vmap=await validateAddressList([address]); }finally{ setBusy(false); }
  const v=vmap && vmap[address];
  if(v && !v.valid){ toast(`地址無法定位：${v.reason||'請確認地址是否正確'}`,'e'); return false; }
  if(v && v.partial_match) toast(`地址僅部分符合，Google 定位為：${v.formatted_address}`,'w');
  closeAddOrder();
  return appendOrders([{name,address,twS,twE,priority:pr,service_time_seconds:svcSec}]);
}
/* 地址驗證：新增訂單前先請後端打 Google Geocoding，擋掉查無或只到
   行政區層級（導航不到定點）的地址。服務不可用（後端沒金鑰/離線）回傳
   null，由呼叫端軟性放行，避免整個新增流程被驗證卡死。 */
async function validateAddressList(addresses){
  try{
    const unique=[...new Set(addresses.filter(Boolean))], map={};
    for(let offset=0;offset<unique.length;offset+=25){
      const batch=unique.slice(offset,offset+25);
      const res=await fetch(`${apiBase()}/api/v1/validate-address`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({google_maps_api_key:$('mapsKey').value.trim()||undefined, addresses:batch})});
      const j=await res.json().catch(()=>({}));
      if(j.status==='SKIPPED'){ toast('後端未設定 Google Maps 金鑰，本次略過地址驗證','w'); return null; }
      if(!res.ok || j.status!=='SUCCESS') throw new Error(j.message||`HTTP ${res.status}`);
      ((j.data&&j.data.results)||[]).forEach(r=>{ map[r.address]=r; });
    }
    return map;
  }catch(err){ toast(`地址驗證服務不可用（${err.message}），本次略過驗證`,'w'); return null; }
}

// 共用守門：計算中不可新增；收貨模式要等「開始收貨」建立行程後才有清單可加
function addOrderBlocked(){
  if(S.ui.optimizing){ toast('路線正在計算中，請等待後端回傳結果','w'); return true; }
  if(S.ui.mode==='receiving' && !S.receive.active){ toast('請先按「開始收貨」建立收貨行程，再新增收貨點','w'); return true; }
  return false;
}
async function appendOrders(orders){
  if(addOrderBlocked()) return false;
  if(!orders.length){ toast('沒有可新增的訂單','w'); return false; }
  if(S.ui.mode==='receiving') return appendReceiveOrders(orders);
  if(stationRowCount()+orders.length>RECOMMENDED_STATIONS){ toast(`送貨點共 ${stationRowCount()+orders.length} 筆，超過建議規模 ${RECOMMENDED_STATIONS} 筆；仍可執行，但建議提高求解 timeout`,'w'); }

  // 寫回 S.raw：之後重新送出排程、備選休息點、收貨判斷都吃同一份資料
  ensureOrderColumns();
  const added=[];
  orders.forEach(o=>{
    const id=nextOrderId();   // 每筆寫入 S.raw 後再取號，保證批次內 id 遞增
    const row={}; S.headers.forEach(h=>{ row[h]=''; });
    row[S.colMap.id]=id; row[S.colMap.name]=o.name; row[S.colMap.address]=o.address;
    row[S.colMap.tw_start]=o.twS; row[S.colMap.tw_end]=o.twE;
    if(o.priority && S.colMap.priority) row[S.colMap.priority]=o.priority;
    if(o.service_time_seconds!=null && S.colMap.service) row[S.colMap.service]=o.service_time_seconds;
    S.raw.push(row);
    added.push({id,o});
  });
  renderPreview();
  $('upPreview').style.display='block'; $('upHint').style.display='none';
  updateReceiveUploadAvailability();
  const label=added.length===1
    ? `訂單 #${added[0].id} ${added[0].o.name}`
    : `${added.length} 筆訂單（#${added[0].id}–#${added[added.length-1].id}）`;

  if(!S.resp || !S.loc.length){
    toast(`已新增${label}；按「⚡ 送出後端排程」計算路線`,'s');
    return true;
  }
  // 已排程：新訂單接在 locations 尾端（既有站點 index 不變），交由後端重排。
  // nextOrderId 保證新 id 為最大值，與 S.raw 依 id 排序後的順序一致。
  added.forEach(({id,o})=>{
    const nl={ id, name:o.name, address:o.address, time_window:[o.twS,o.twE], status:'pending' };
    if(o.priority) nl.priority=o.priority;
    if(o.service_time_seconds!=null) nl.service_time_seconds=o.service_time_seconds;
    S.loc.push(nl);
  });
  S.ui.dayRecorded=false;   // 有新任務，今日總覽需重新記錄
  const inTransit=S.loc.some(l=>l && l.status && l.status!=='pending');
  if(inTransit) sw('delivery', document.querySelector('.tabs .tab:nth-child(3)'));   // 途中新增：避免在上傳頁重建 S.loc 而遺失配送狀態
  toast(`已新增${label}，重新計算路線`,'i');
  const ok=await runOptimize(null, inTransit?clockHM():undefined);
  if(!ok){
    // 後端失敗：整批撤回，避免畫面與路線不同步
    added.forEach(()=>{ S.loc.pop(); S.raw.pop(); });
    renderPreview();
    toast(`新增訂單失敗，已撤回 ${label}`,'w');
  }
  return ok;
}
// 收貨途中新增：寫回 S.receive.raw（與收貨 Excel 同一份資料源），
// 收貨點接在 locations 尾端（收貨起點/既有站 index 不變），並依收貨規則
// 固定收貨起點重排（與收貨回報事件同一條路徑）；後端失敗整批撤回。
function nextReceiveOrderId(){
  let mx=0;   // 排除收貨起點 9900 與 990000+ 虛擬點
  S.receive.raw.forEach(r=>{ const v=Number(rowValue(r,S.receive.colMap,'id')); if(isFinite(v) && v<9000 && v>mx) mx=v; });
  S.loc.forEach(l=>{ const v=Number(l&&l.id); if(isFinite(v) && v<9000 && v>mx) mx=v; });
  return mx+1;
}
function ensureReceiveOrderColumns(){
  if(!S.receive.headers.length){ S.receive.headers=Object.values(ADD_ORDER_HEADERS); }
  else Object.entries(ADD_ORDER_HEADERS).forEach(([k,h])=>{
    if(!S.receive.colMap[k] && !S.receive.headers.includes(h)) S.receive.headers.push(h);
  });
  S.receive.colMap=inferColMap(S.receive.headers);
}
async function appendReceiveOrders(orders){
  if(!S.receive.active || !S.loc.length){ toast('請先按「開始收貨」建立收貨行程，再新增收貨點','w'); return false; }
  ensureReceiveOrderColumns();
  const added=[];
  orders.forEach(o=>{
    const id=nextReceiveOrderId();   // 每筆寫入後再取號，保證批次內 id 遞增
    const row={}; S.receive.headers.forEach(h=>{ row[h]=''; });
    row[S.receive.colMap.id]=id; row[S.receive.colMap.name]=o.name; row[S.receive.colMap.address]=o.address;
    row[S.receive.colMap.tw_start]=o.twS; row[S.receive.colMap.tw_end]=o.twE;
    if(o.priority && S.receive.colMap.priority) row[S.receive.colMap.priority]=o.priority;
    if(o.service_time_seconds!=null && S.receive.colMap.service) row[S.receive.colMap.service]=o.service_time_seconds;
    S.receive.raw.push(row);
    const nl={ id, name:o.name, address:o.address, time_window:[o.twS,o.twE], status:'pending' };
    if(o.priority) nl.priority=o.priority;
    if(o.service_time_seconds!=null) nl.service_time_seconds=o.service_time_seconds;
    S.loc.push(nl);
    added.push({id,o});
  });
  renderReceiveUpload();
  S.ui.dayRecorded=false;
  const label=added.length===1
    ? `收貨點 #${added[0].id} ${added[0].o.name}`
    : `${added.length} 筆收貨點（#${added[0].id}–#${added[added.length-1].id}）`;
  toast(`已新增${label}，重新計算收貨路線`,'i');
  const ok=await runOptimize(null, clockHM(), {keepReceivingStartOnly:true});
  if(!ok){
    added.forEach(()=>{ S.loc.pop(); S.receive.raw.pop(); });
    renderReceiveUpload();
    toast(`新增收貨點失敗，已撤回 ${label}`,'w');
  }
  return ok;
}
// 丟檔案批次新增：欄位辨識規則與送貨 Excel 相同（名稱、地址必填；
// ID 一律由系統重新編號，檔案裡的 ID 只用來略過公司列）。送貨/收貨模式皆可用。
function readAppendXL(file){
  if(addOrderBlocked()) return;
  if(file.size>10*1024*1024){ toast('檔案超過 10 MB','e'); return; }
  const rd=new FileReader();
  rd.onload=async ev=>{ try{
    const wb=XLSX.read(new Uint8Array(ev.target.result),{type:'array'});
    const json=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:''});
    if(!json.length){ toast('檔案為空','e'); return; }
    const colMap=inferColMap(Object.keys(json[0]));
    if(!colMap.name || !colMap.address){ toast('檔案缺少「名稱」或「地址」欄位，無法新增訂單','e'); return; }
    const orders=[]; let skipped=0;
    json.forEach(row=>{
      const name=String(rowValue(row,colMap,'name')||'').trim();
      const address=String(rowValue(row,colMap,'address')||'').trim();
      if(!name || !address){ skipped++; return; }
      const idRaw=String(rowValue(row,colMap,'id')??'').trim();
      const isCompany=(idRaw!=='' && Number(idRaw)===0) || (companyAddress() && normText(address)===normText(companyAddress()));
      if(isCompany){ skipped++; return; }
      const twS=parseTW(rowValue(row,colMap,'tw_start'),false), twE=parseTW(rowValue(row,colMap,'tw_end'),true);
      if(hmToSec(twS)>hmToSec(twE)){ skipped++; return; }
      const o={name,address,twS,twE,priority:null,service_time_seconds:null};
      const pr=Number(rowValue(row,colMap,'priority')); if(pr>=1&&pr<=5) o.priority=pr;
      const sv=Number(rowValue(row,colMap,'service')); if(sv>0) o.service_time_seconds=sv;   // 與 Excel 匯入規則一致：秒
      orders.push(o);
    });
    if(!orders.length){ toast('檔案中沒有可新增的有效訂單（名稱與地址必填）','e'); return; }
    // 地址驗證：無法定位的列直接略過，不擋整批
    let list=orders;
    setBusy(true,'地址驗證中…');
    let vmap=null;
    try{ vmap=await validateAddressList([...new Set(list.map(o=>o.address))]); }finally{ setBusy(false); }
    if(vmap){
      const bad=list.filter(o=>{ const v=vmap[o.address]; return v && !v.valid; });
      if(bad.length){
        list=list.filter(o=>{ const v=vmap[o.address]; return !(v && !v.valid); });
        toast(`已略過 ${bad.length} 筆無法定位的地址：${bad.slice(0,3).map(o=>o.name).join('、')}${bad.length>3?' 等':''}`,'e');
      }
      const partial=list.filter(o=>{ const v=vmap[o.address]; return v && v.partial_match; }).length;
      if(partial) toast(`${partial} 筆地址僅部分符合，請於清單確認定位是否正確`,'w');
      if(!list.length){ toast('檔案內沒有可定位的地址，未新增任何訂單','e'); return; }
    }
    closeAddOrder();
    if(skipped) toast(`已略過 ${skipped} 筆無效或公司列資料`,'w');
    await appendOrders(list);
  }catch(err){ toast('解析失敗：'+err.message,'e'); } };
  rd.readAsArrayBuffer(file);
}

/* ─── 最終站 / 出發 ───────────────────────────────────────── */
function deliveryPointOptionsFromRaw(){
  if(!S.raw.length || !S.colMap) return [];
  return stationLocationsFromRows(S.raw,S.colMap,{skipCompanyRow:true})
    .map((l,idx)=>({...l,idx:idx+1}));
}
function resetEndSelection(clearManual=false){
  S.ui.finalEndIndex=null;
  if(clearManual){ S.ui.manualEndIndices=[]; S.ui.endDirty=false; }
  S.receive.plan=null;
}
function setEndMode(m){
  S.ui.endMode=m;
  resetEndSelection(false);
  const w=$('manualEndWrap'); if(w) w.style.display=m==='manual'?'':'none';
  markEndDirty();
  renderEndOptions();
}
// 終點／備選休息點改一次就重排會打一堆 API（勾五個就送五次），改成累積變更、
// 由「✓ 套用終點設定」送一次；尚未排程過時本來就要按「送出後端排程」，不顯示套用列。
function markEndDirty(){ if(S.resp) S.ui.endDirty=true; }
function renderEndApplyBar(){
  const bar=$('endApplyBar'); if(!bar) return;
  bar.style.display=(S.resp && S.ui.endDirty)?'':'none';
}
async function applyEndSelection(){
  if(!S.ui.endDirty){ toast('終點設定沒有變更','i'); return false; }
  if(S.ui.mode==='delivery' && S.ui.endMode==='manual' && !manualEndCandidateIndices().length){ toast('請先勾選至少一個備選休息點','w'); return false; }
  const ok=await runOptimize();
  if(ok!==false){ S.ui.endDirty=false; renderEndApplyBar(); }
  return ok;
}
function manualEndCandidateIndices(){
  const valid = new Set(deliveryPointOptionsFromRaw().map(p=>p.idx));
  return [...new Set((S.ui.manualEndIndices||[]).map(Number))]
    .filter(idx=>valid.has(idx))
    .sort((a,b)=>a-b);
}
function manualEndCandidates(){
  const chosen = new Set(manualEndCandidateIndices());
  return deliveryPointOptionsFromRaw().filter(p=>chosen.has(p.idx));
}
function setManualEndCandidate(idx, checked){
  const chosen = new Set(manualEndCandidateIndices());
  if(checked) chosen.add(Number(idx));
  else chosen.delete(Number(idx));
  S.ui.manualEndIndices=[...chosen].sort((a,b)=>a-b);
  resetEndSelection(false);
  markEndDirty();
  renderEndOptions();
}
function deliveryEndCandidateIndices(){
  return deliveryPointOptionsFromRaw().map(p=>p.idx);
}
function currentFinalStop(){
  const selected = S.ui.finalEndIndex!=null ? S.ui.finalEndIndex : S.resp?.selected_end_index;
  if(selected!=null && S.loc[selected]){
    const idx=selected, l=S.loc[idx];
    return {idx, name:l.name||'公司', address:l.address||'—', resolved:true};
  }
  if(S.ui.endMode==='depot'){
    const depot=S.loc[0] || companyLocation();
    return {idx:0, name:(depot&&depot.name)||'公司', address:(depot&&depot.address)||'排程後顯示', resolved:!!(S.loc[0] || depot.address)};
  }
  if(S.ui.endMode==='manual'){
    const candidates=manualEndCandidates();
    return candidates.length
      ? {idx:null, name:`已選 ${candidates.length} 個備選休息點`, address:'排程後由系統從備選清單中挑選最終站', resolved:false}
      : {idx:null, name:'請選擇至少一個備選休息點', address:'系統會從勾選的送貨點中挑選最終站', resolved:false};
  }
  return {idx:null, name:S.resp?'系統推薦中':'排程後由系統推薦', address:'後端會從送貨點中挑選最終站', resolved:!!S.resp};
}
function renderEndOptions(){
  const list=$('manualEndList');
  const hint=$('manualEndHint');
  if(list){
    const opts=deliveryPointOptionsFromRaw();
    const chosen=new Set(manualEndCandidateIndices());
    list.innerHTML=opts.length
      ? opts.map(p=>`<label class="end-cand"><input type="checkbox" value="${p.idx}" ${chosen.has(p.idx)?'checked':''} onchange="setManualEndCandidate(${p.idx},this.checked)" /><span>#${p.id} ${esc(p.name)}</span></label>`).join('')
      : '<div class="empty-sub">請先上傳送貨資料，再勾選備選休息點</div>';
    if(hint) hint.textContent=opts.length
      ? `已選 ${chosen.size} 個備選；後端會從勾選名單中挑選最佳休息點`
      : '尚無送貨點可選';
  }
  const final=currentFinalStop(), box=$('endFinalBox');
  if(box){
    box.style.display='';
    $('endFinalName').textContent=final.name||'—';
    $('endFinalAddr').textContent=final.address||'—';
  }
  renderEndApplyBar();
  renderUploadState();
}
function onDepartureChange(){ renderUploadState(); if(S.resp) runOptimize(); }

/* ─── 由 Excel 建立 S.loc（含休息點）──────────────────────── */
function buildLocFromRaw(){
  const depot=companyLocation();
  if(!depot.address) return [];
  const dep=departureHM(), depEnd=twToStrings(depot.time_window)[1];
  depot.time_window=[dep, hmToSec(depEnd)>=hmToSec(dep)?depEnd:'23:59'];
  const loc=[depot, ...stationLocationsFromRows(S.raw,S.colMap,{skipCompanyRow:true})];
  S.restCount=0;
  return loc;
}
function buildLocationsFromRows(raw,colMap,{depot=null, defaultServiceSeconds=600, skipDepotRows=false}={}){
  const loc=stationLocationsFromRows(raw,colMap,{defaultServiceSeconds,skipCompanyRow:skipDepotRows});
  if(depot) loc.unshift({id:depot.id??0,name:depot.name||'公司',address:depot.address,time_window:['00:00','23:59'],service_time_seconds:0});
  return loc;
}
function receivingDeadlineHM(){
  if(!S.receive.raw.length) return null;
  const endCol=S.receive.colMap.tw_end;
  if(!endCol) return '23:29';
  const ends=S.receive.raw.map(r=>hmToSec(parseTW(r[endCol], true))).filter(v=>v>0);
  if(!ends.length) return '23:29';
  return secToHM(Math.max(0, Math.min(...ends)-1800));
}
// 建議最晚出發：以試算的收貨路線為準，從收貨起點起算各站「時間窗結束 − 預估抵達」的最小裕度，
// 再扣 30 分鐘安全緩衝。粗估版 receivingDeadlineHM()（死線前 30 分鐘）忽略整段路線所需的行駛/服務
// 時間，站數一多就會把最晚出發時間估得遠晚於實際可行，故改用路線實際時序推算。
const RECEIVE_DEPART_SAFETY_SECONDS=1800;
function latestDepartureHM(loc,data,restIndex){
  if(!data || !Array.isArray(data.route_details)) return receivingDeadlineHM();
  const details={}; data.route_details.forEach(d=>{ details[d.index]=d; });
  const restD=details[restIndex];
  const restDepart=restD ? (restD.service_completion_time_seconds ?? restD.arrival_time_seconds) : null;
  if(restDepart==null) return receivingDeadlineHM();
  let minSlack=Infinity;
  loc.forEach((l,i)=>{
    if(i===0 || i===restIndex || (l&&l._receiveRest)) return;   // 跳過公司終點與收貨起點
    const d=details[i]; if(!d || d.arrival_time_seconds==null) return;
    const end=hmToSec(twToStrings(l.time_window||['00:00','23:59'])[1]);
    minSlack=Math.min(minSlack, end - d.arrival_time_seconds);
  });
  if(!isFinite(minSlack)) return receivingDeadlineHM();          // 無可用收貨站點時退回粗估
  return secToHM(Math.max(0, restDepart + minSlack - RECEIVE_DEPART_SAFETY_SECONDS));
}
function receivingBaseLocations(restPoint){
  const depot=S.loc[0]||{};
  const loc=buildLocationsFromRows(S.receive.raw,S.receive.colMap,{depot,defaultServiceSeconds:600,skipDepotRows:true});
  loc.push({id:9900,name:`收貨起點：${restPoint.name}`,address:restPoint.address,time_window:['00:00','23:59'],service_time_seconds:0,_receiveRest:true});
  return loc;
}
function routePayloadForLocations(loc,{startIndex=0,endIndex=0,currentTime=null}={}){
  const locations=loc.map(l=>{
    const o={id:l.id,name:l.name,address:l.address,time_window:twToStrings(l.time_window)};
    if(l.service_time_seconds!=null) o.service_time_seconds=l.service_time_seconds;
    if(l.priority!=null) o.priority=l.priority;
    if(l.status && l.status!=='pending') o.status=l.status;
    if(l.rescheduled_time_window) o.rescheduled_time_window=l.rescheduled_time_window;
    return o;
  });
  const payload={
    google_maps_api_key:$('mapsKey').value.trim()||undefined,
    operation_type:'receiving',
    solver:'ortools',
    solver_timeout_seconds:Number($('solverTimeout').value)||5,
    depot_index:0,
    start_index:startIndex,
    end_index:endIndex,
    ortools:solverConfig(),
    locations,
    service:{default_service_time_seconds:600},
    constraints:{allow_late_arrival:true, waiting_time_cost_per_second:1, preserve_remaining_order:true}
  };
  if(currentTime!=null){
    payload.current_index=startIndex;
    payload.current_time_seconds=currentTime;
  }
  return payload;
}
async function postOptimizePayload(payload){
  const res=await fetch(`${apiBase()}/api/v1/optimize-route`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  if(!res.ok){ const e=await res.json().catch(()=>({})); throw new Error(e.detail||e.message||`HTTP ${res.status}`); }
  const j=await res.json();
  if(j.status!=='SUCCESS') throw new Error(j.message||j.status);
  return j.data;
}
async function prepareReceivingPlan(){
  if(!S.receive.raw.length || !S.resp || S.receive.active) return null;
  const requiredOk=['id','name','address'].every(k=>!!S.receive.colMap[k]);
  if(!requiredOk){ toast('收貨 Excel 缺少必要欄位，暫不建立收貨行程','w'); return null; }
  const rest=currentFinalStop();
  if(!rest || !rest.address || !rest.resolved){ toast('尚未決定送貨最終站，暫不建立收貨行程','w'); return null; }
  $('receivePrepStatus') && ($('receivePrepStatus').textContent='收貨路線試算中…');
  let best=null;
  try{
    const loc=receivingBaseLocations(rest);
    const restIndex=loc.length-1;
    const payload=routePayloadForLocations(loc,{startIndex:restIndex,endIndex:0});
    const data=await postOptimizePayload(payload);
    const score=[
      data.total_lateness_minutes||0,
      data.total_elapsed_minutes||data.total_time_minutes||0,
      data.total_travel_minutes||data.total_time_minutes||0
    ];
    best={rest,loc,restIndex,data,score,latestDeparture:latestDepartureHM(loc,data,restIndex)};
  }catch(err){
    console.warn('[LogiOps] receiving preview failed', rest, err);
  }
  S.receive.plan=best;
  renderReceivePrep();
  if(best) toast(`已建立收貨起點：${best.rest.name}`,'s');
  else toast('收貨路線試算失敗','w');
  return best;
}

/* ─── 建立 payload（所有情境共用）────────────────────────── */
function solverConfig(){ const fs=$('fsStrategy').value,lm=$('lsMeta').value,c={}; if(fs)c.first_solution_strategy=fs; if(lm)c.local_search_metaheuristic=lm; return Object.keys(c).length?c:undefined; }
function advanced(){
  const out={}; const sv=$('advService').value; if(sv!=='') out.service={default_service_time_seconds:Number(sv)};
  const c={}; const late=$('advLate').value; if(late) c.allow_late_arrival=(late==='true');
  const wc=$('advWaitCost').value; if(wc!=='') c.waiting_time_cost_per_second=Number(wc);
  const pr=$('advPreserve').value; if(pr) c.preserve_remaining_order=(pr==='true');
  if(Object.keys(c).length) out.constraints=c;
  return out;
}
function endpoint(){
  if(S.ui.mode==='receiving') return { end_index:0 };
  if(S.ui.finalEndIndex!=null) return { end_index:Number(S.ui.finalEndIndex) };
  if(S.ui.endMode==='manual'){
    const idxs=manualEndCandidateIndices();
    if(idxs.length) return { end_index:null, end_candidate_indices:idxs };
  }
  if(S.ui.endMode==='recommend'){
    const idxs=deliveryEndCandidateIndices();
    if(idxs.length) return { end_index:null, end_candidate_indices:idxs };
  }
  return { end_index:0 };
}
function buildPayload(currentIdx,currentTime,opts={}){
  const locations=S.loc.map(l=>{
    const o={ id:l.id, name:l.name, address:l.address, time_window:twToStrings(l.time_window) };
    if(l.rescheduled_time_window) o.rescheduled_time_window=l.rescheduled_time_window;
    if(l.priority!=null) o.priority=l.priority;
    if(l.service_time_seconds!=null) o.service_time_seconds=l.service_time_seconds;
    if(l.status && l.status!=='pending') o.status=l.status;
    return o;
  });
  if(opts.virtualCurrentFrom!=null && S.loc[opts.virtualCurrentFrom]){
    const src=S.loc[opts.virtualCurrentFrom];
    const t=currentTime || testClockHM();
    locations.push({
      id:990000 + Number(opts.virtualCurrentFrom),
      name:`目前位置：${src.name||opts.virtualCurrentFrom}`,
      address:src.address,
      time_window:[t,'23:59'],
      service_time_seconds:0,
      virtual_current_position:true
    });
    currentIdx=locations.length-1;
  }
  const completed_indices=[],cancelled_indices=[],skipped_indices=[]; let lastActed=null;
  S.loc.forEach((l,i)=>{ if(l.status==='completed'){completed_indices.push(i);lastActed=i;} else if(l.status==='cancelled')cancelled_indices.push(i); else if(l.status==='skipped')skipped_indices.push(i); });
  const inTransit = completed_indices.length||cancelled_indices.length||skipped_indices.length||currentIdx!=null;
  const receivingStartIndex = S.ui.mode==='receiving' && S.receive.active && S.receive.plan
    ? S.receive.plan.restIndex
    : null;
  const p={
    google_maps_api_key:$('mapsKey').value.trim()||undefined,
    operation_type:S.ui.mode==='receiving'?'receiving':'delivery',
    solver:'ortools',
    solver_timeout_seconds:Number($('solverTimeout').value)||5,
    depot_index:0,
    ortools:solverConfig(),
    locations,
    ...endpoint(),
    ...advanced(),
  };
  if(receivingStartIndex!=null) p.start_index=receivingStartIndex;
  // 手動調整順序：把使用者按下「完成調整」時的站點順序送給後端，後端據此重算時間（不再自行換順序）。
  if(Array.isArray(opts.manualOrder) && opts.manualOrder.length>1) p.manual_route_indices=opts.manualOrder.map(Number);
  if(inTransit){
    // 途中重排才送 current_index / current_time_seconds（初始路線的出發時間由 depot 時間窗決定，
    // 初始就送 current_time_seconds 會讓後端誤判為途中重排而求不出解）。
    // 收貨模式只有「標記收貨完成且帶 currentIdx」時送目前站與實際時間，讓下一站 ETA 從現況重算。
    // 收貨的改約/取消/跳過仍用 keepReceivingStartOnly 固定收貨起點，避免導航把收貨起點當成中途站。
    const canSendCurrent = receivingStartIndex==null || (currentIdx!=null && !opts.keepReceivingStartOnly);
    if(canSendCurrent){
      p.current_index = currentIdx!=null?currentIdx:(lastActed!=null?lastActed:0);
      p.current_time_seconds = currentTime || nowHM();
    }
    p.completed_indices=completed_indices; p.cancelled_indices=cancelled_indices; p.skipped_indices=skipped_indices;
  }
  return p;
}

/* ─── 單一 API 呼叫 ──────────────────────────────────────── */
async function runOptimize(currentIdx,currentTime,opts={}){
  if(S.ui.optimizing){ toast('路線正在計算中，請等待後端回傳結果','w'); return; }
  const onUpload=$('view-upload').classList.contains('on');
  if(onUpload){
    if(!S.raw.length){ toast('請先上傳送貨 Excel','w'); return; }
    if(!companyAddress()){ toast('請先在系統管理員模式設定公司地址','w'); return false; }
    S.loc=buildLocFromRaw(); S.ui.manualOrder=null;
    resetDeparture();   // 從上傳頁重新排程＝新的一趟，實際出發時間重來
    if(S.loc.length<2){ toast('送貨 Excel 至少需要 1 筆送貨點；公司地點請填在管理員欄位','w'); return false; }
  }
  if(S.ui.mode==='delivery' && S.ui.endMode==='manual' && !manualEndCandidateIndices().length){ toast('請先勾選至少一個備選休息點','w'); return false; }
  if(!S.loc.length){ toast('尚無路線資料','w'); return; }
  const btn=$('sendBtn');
  S.ui.optimizing=true;
  if(btn&&onUpload){ btn.disabled=true; btn.innerHTML='<span class="spin"></span> 計算中...'; }
  S.ui.manualOrder=null;   // 任何後端重排都清掉手動順序
  setBusy(true,'後端排程中…'); setAlert('');
  let res, ok=false;
  try{
    try{ res=await fetch(`${apiBase()}/api/v1/optimize-route`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(buildPayload(currentIdx,currentTime,opts))}); }
    catch(netErr){ setDot('off'); setAlert(`無法連線後端（離線或被 CORS 阻擋）：${netErr.message}。請從 http://127.0.0.1:5173 或 :3000 開啟前端。`,'warn'); toast('後端離線','e'); return; }
    setDot('on');
    if(!res.ok){ const e=await res.json().catch(()=>({})); throw new Error(e.detail||e.message||`HTTP ${res.status}`); }
    const j=await res.json();
    if(j.status!=='SUCCESS') throw new Error(j.message||j.status);
    S.resp=j.data;
    S.ui.endDirty=false;   // 這次重排已套用目前的終點設定
    if(S.ui.mode==='delivery' && S.resp.selected_end_index!=null && S.ui.finalEndIndex==null) S.ui.finalEndIndex=S.resp.selected_end_index;
    try{ render(); }
    catch(renderErr){
      console.error('[LogiOps] frontend render failed', renderErr, j);
      throw new Error(`前端渲染錯誤：${renderErr.message}`);
    }
    ok=true;
    renderEndOptions();
    if(onUpload && S.receive.raw.length) prepareReceivingPlan().catch(err=>console.warn('[LogiOps] receiving plan failed', err));
    setAlert('✓ 後端排程完成。','ok'); toast('排程成功','s');
  }catch(err){ setAlert(`後端回應錯誤：${err.message}`,'warn'); toast(`後端錯誤：${err.message}`,'e'); }
  finally{ S.ui.optimizing=false; setBusy(false); if(btn&&onUpload){ btn.disabled=false; btn.innerHTML='⚡ 送出後端排程'; } }
  if(ok && onUpload) sw('schedule', document.querySelector('.tabs .tab:nth-child(2)'));
  return ok;
}

/* ─── 由 S.resp + S.loc 整理顯示列（不做任何路由計算）──────── */
function orderedStops(){
  if(!S.resp) return [];
  const idxs = S.ui.manualOrder || S.resp.route_indices || [];
  const details={}; (S.resp.route_details||[]).forEach(d=>details[d.index]=d);
  const active=[], terminal=[], seen=new Set();
  // 仍在處理中的站點。終點若是實際送貨點仍要顯示；只有公司/虛擬收貨起點屬於純終點。
  idxs.forEach((idx,pos)=>{
    const l=S.loc[idx];
    const pureTerminal = pos===idxs.length-1 && (idx===0 || (l&&(l._rest||l._receiveRest||l.virtual_current_position)));
    if(!S.ui.manualOrder && (pos===0 || pureTerminal)) return;
    if(idx===0 || seen.has(idx) || (l&&(l._rest||l._receiveRest||l.virtual_current_position))) return;
    if(S.loc[idx] && EXCLUDED.includes(S.loc[idx].status)) return;   // 已完成（含逾時送達）/取消/跳過 → 歷史區
    seen.add(idx); active.push(makeRow(idx,details[idx]));
  });
  // 已完成（含逾時送達）/取消/跳過 → 移到下方歷史區（與後端是否重排無關，一律往下放）
  S.loc.forEach((l,idx)=>{ if(idx===0||l._rest||l._receiveRest||l.virtual_current_position||seen.has(idx)) return; if(EXCLUDED.includes(l.status)){ seen.add(idx); terminal.push(makeRow(idx,details[idx])); } });
  // 送貨編號（黃色圓圈）：第一次出現時依當下路線順序給號，之後永久凍結在 S.loc._seq。
  // 之後不論重排、送達、取消、跳過都不再改變；列表上下順序仍反映目前路線，但編號是固定身分。
  let maxSeq=0; S.loc.forEach(l=>{ if(l && typeof l._seq==='number' && l._seq>maxSeq) maxSeq=l._seq; });
  active.forEach(r=>{ const l=S.loc[r.idx]; if(l && l._seq==null) l._seq=++maxSeq; });   // 僅新站點補號
  active.forEach(r=>{ r.seq=(S.loc[r.idx]&&S.loc[r.idx]._seq)||r.id||r.idx; r.terminal=false; });
  terminal.forEach(r=>{ r.seq=(S.loc[r.idx]&&S.loc[r.idx]._seq)||r.id||r.idx; r.terminal=true; });
  return active.concat(terminal);
}
function makeRow(idx,d){
  const l=S.loc[idx]||{};
  const arrival = d?d.arrival_time_seconds:null;
  let lateness = d?(d.lateness_seconds||0):0;
  // 後端在軟性時間窗下可能回報 lateness=0，但實際抵達已超過（改約）時間窗結束 → 前端據實補算逾時
  const winEnd = hmToSec(twToStrings(l.rescheduled_time_window || l.time_window || ['00:00','23:59'])[1]);
  if(arrival!=null && arrival>winEnd) lateness=Math.max(lateness, arrival-winEnd);
  return { idx, id:l.id??idx, name:l.name||`#${idx}`, address:l.address||'—', status:l.status||'pending',
    rescheduled:l.rescheduled_time_window||null, priority:l.priority||null,
    arrival, lateness, waitingMin: d?(d.waiting_time_minutes||0):0,
    serviceStart: d?d.service_start_time_seconds:null,
    serviceComplete: d?d.service_completion_time_seconds:null,
    serviceSeconds: d?(d.charged_service_time_seconds ?? d.service_time_seconds ?? 0):0,
    deliveredLate: l.deliveredLate||false,
    deliveredAtTime: l.deliveredAtTime||null };
}
function numericSec(v, fallback=0){
  if(v==null || v==='') return fallback;
  if(typeof v==='number' && isFinite(v)) return Math.round(v);
  return hmToSec(v);
}
function localWindowSeconds(detail, loc){
  const win = detail?.effective_time_window || loc?.rescheduled_time_window || loc?.time_window || ['00:00','23:59'];
  return [numericSec(win[0],0), numericSec(win[1],86399)];
}
function detailCompletion(d){
  return numericSec(d?.service_completion_time_seconds ?? d?.service_start_time_seconds ?? d?.arrival_time_seconds, 0);
}
function detailServiceSeconds(d, loc){
  return Number(d?.charged_service_time_seconds ?? d?.service_time_seconds ?? loc?.service_time_seconds ?? 0) || 0;
}
function isPureControlStop(idx){
  const l=S.loc[idx];
  return idx===0 || !!(l && (l._rest || l._receiveRest || l.virtual_current_position));
}
function round1(v){ return Math.round((Number(v)||0)*10)/10; }
// 實際完成時間只造成後續 ETA 平移、且不會讓任何剩餘站點逾時時，前端直接更新時間，不回後端重排。
function applyLocalScheduleShift(idx, plannedHM, actualHM){
  if(!S.resp || !Array.isArray(S.resp.route_details)) return false;
  const details=S.resp.route_details.map(d=>({...d}));
  const pos=details.findIndex(d=>Number(d.index)===Number(idx));
  if(pos<0 || pos>=details.length-1) return false;

  let delta=hmToSec(actualHM)-hmToSec(plannedHM);
  if(delta>43200) delta-=86400;
  if(delta<-43200) delta+=86400;
  if(delta===0) return true;

  const current=details[pos];
  const currentService=detailServiceSeconds(current,S.loc[idx]);
  const actualCompletion=hmToSec(actualHM);
  current.service_completion_time_seconds=actualCompletion;
  if(currentService>0){
    current.service_start_time_seconds=Math.max(
      numericSec(current.arrival_time_seconds, actualCompletion-currentService),
      actualCompletion-currentService
    );
    current.waiting_time_seconds=Math.max(0,current.service_start_time_seconds-numericSec(current.arrival_time_seconds,current.service_start_time_seconds));
    current.waiting_time_minutes=round1(current.waiting_time_seconds/60);
  }

  const shifted=details;
  for(let i=pos+1;i<shifted.length;i++){
    const oldPrev=S.resp.route_details[i-1]||shifted[i-1];
    const oldCur=S.resp.route_details[i]||shifted[i];
    const prevNew=shifted[i-1];
    const loc=S.loc[oldCur.index]||{};
    const oldTravel=Math.max(0,numericSec(oldCur.arrival_time_seconds,0)-detailCompletion(oldPrev));
    const arrival=detailCompletion(prevNew)+oldTravel;
    const [winStart,winEnd]=localWindowSeconds(oldCur,loc);
    const serviceStart=Math.max(arrival,winStart);
    const serviceSeconds=detailServiceSeconds(oldCur,loc);
    const serviceCompletion=serviceStart+serviceSeconds;
    const waiting=Math.max(0,serviceStart-arrival);
    const lateness=Math.max(0,serviceStart-winEnd);

    if(lateness>0 && !isPureControlStop(oldCur.index) && !EXCLUDED.includes(loc.status)){
      return false;
    }

    shifted[i]={
      ...oldCur,
      arrival_time_seconds:arrival,
      service_start_time_seconds:serviceStart,
      waiting_time_seconds:waiting,
      waiting_time_minutes:round1(waiting/60),
      service_completion_time_seconds:serviceCompletion,
      lateness_seconds:lateness,
    };
  }

  S.resp.route_details=shifted;
  const first=shifted[0];
  const last=shifted[shifted.length-1];
  const firstTime=numericSec(first?.service_start_time_seconds ?? first?.arrival_time_seconds,0);
  const lastTime=detailCompletion(last);
  S.resp.total_elapsed_minutes=round1(Math.max(0,lastTime-firstTime)/60);
  S.resp.total_lateness_minutes=round1(
    shifted.reduce((sum,d)=>sum+(Number(d.lateness_seconds)||0),0)/60
  );
  S.resp.reoptimization={...(S.resp.reoptimization||{}), local_time_shift:{index:idx, planned_time:plannedHM, actual_time:actualHM, delta_seconds:delta}};
  return true;
}

/* ─── RENDER ─────────────────────────────────────────────── */
function render(){
  const has=!!S.resp;
  $('sEmpty').style.display=has?'none':'block'; $('sContent').style.display=has?'block':'none';
  $('dEmpty').style.display=has?'none':'block'; $('dContent').style.display=has?'block':'none';
  renderUploadState();
  if(!has) return;
  const rows=orderedStops();
  $('bS').textContent=rows.length; $('bD').textContent=rows.length;
  renderEndOptions(); renderStats(rows); renderTimeline(rows); renderStack(rows); renderNav(); renderDriverSim(rows); renderReceivePrep(rows); renderList(rows); renderCompleteDay(rows);
}
function renderDriverSim(rows){
  updateDriverClock();
  renderDepartureControl();
  if(!$('driverNextInfo')) return;
  const next=rows.find(r=>!EXCLUDED.includes(r.status));
  $('driverNextInfo').innerHTML=next
    ? `<span class="ni-ico">🚩</span><span class="ni-txt">下一站 <b>#${next.seq} ${esc(next.name)}</b>　·　抵達 <b>${secToHM(next.arrival)}</b>　·　完成 <b>${secToHM(next.serviceComplete)}</b></span>`
      +`<a class="dc-nav ni-nav" href="${stopNavUrl(next)}" target="_blank" rel="noopener" aria-label="導航到下一站 ${esc(next.name)}">🗺 導航</a>`
    : `<span class="ni-ico">✓</span><span class="ni-txt">沒有剩餘${taskWord()}站</span>`;
  const last=S.ui.lastAction;
  // 改約顯示新的時間窗（而非目前時間）；其餘顯示動作發生時間
  const lastDetail = last ? (last.status==='delayed' && last.tw ? `改約時間窗 ${esc(last.tw)}` : `時間 ${esc(last.time)}`) : '';
  $('driverLastInfo').innerHTML=last
    ? `<span class="ac">最新狀態</span>：${esc(last.name)} ${actionLabel(last.status)}，${lastDetail}`
    : '尚未標記送達';
}
// 實際出發時間：一般使用者只能按「出發」記錄本地時間；管理員可先填想模擬的時刻再按。
// 出發只按得了一次，記錄後欄位與按鈕都鎖住，避免同一趟行程出現兩個出發時間。
function renderDepartureControl(){
  const input=$('departTime'), text=$('departTimeText'), btn=$('departBtn');
  if(!input||!text||!btn) return;
  const departed=!!S.ui.departedAt;
  const editable=!departed && isAdmin();   // 只有管理員、且尚未出發時可自填時刻
  input.style.display=editable?'':'none';
  text.style.display=editable?'none':'';
  text.textContent=departed?S.ui.departedAt:'尚未出發';
  text.classList.toggle('ok',departed);
  if(departed) input.value=S.ui.departedAt;
  else if(editable && !input.value) input.value=departureHM();   // 管理員預設帶入預計出發時間
  btn.disabled=departed;
  btn.textContent=departed?`✓ 已出發 ${S.ui.departedAt}`:'🚚 出發';
  btn.classList.toggle('btn-pri',!departed);
  btn.classList.toggle('btn-ghost',departed);
}
async function markDeparted(){
  if(S.ui.departedAt){ toast('本趟行程已記錄出發時間','w'); return false; }
  if(S.ui.optimizing){ toast('路線正在計算中，請等待後端回傳結果','w'); return false; }
  if(!S.resp){ toast('尚無路線，請先送出後端排程','w'); return false; }
  const planned=departureHM();
  const t=(isAdmin() && $('departTime')?.value) || nowHM();
  S.ui.departedAt=t;
  setTestClock(t);
  renderDepartureControl();
  if(t===planned){
    render();
    setAlert(`✓ 已於 ${t} 出發，與預計出發時間相同，路線未重新計算。`,'ok');
    toast('已記錄出發','s');
    return true;
  }
  // 實際出發與預計不同 → 以起點（index 0）為目前位置、實際出發時間為基準重新推估後續 ETA。
  toast(`實際出發 ${t}（預計 ${planned}），重新推估路線時間`,'i');
  const ok=await runOptimize(0, t);
  if(!ok) render();
  return ok;
}
function renderStats(rows){
  const d=S.resp;
  const travel=(d.total_travel_minutes!=null?d.total_travel_minutes:d.total_time_minutes)||0;
  const elapsed=d.total_elapsed_minutes||0;
  const done=rows.filter(r=>r.status==='completed');
  // 逾時判定與徽章一致：已送達且（後端逾時 或 抵達超過時間窗）
  const isLate=r=>r.deliveredLate||r.lateness>0;
  const onT=done.filter(r=>!isLate(r)).length, late=done.filter(isLate).length;
  const exc=rows.filter(r=>r.status==='cancelled'||r.status==='skipped').length;
  $('statsRow').innerHTML=
    `<div class="stat"><div class="sl">行駛 / 總耗時</div><div class="sv">${fmtHM(travel)}<span class="sv2"> / ${fmtHM(elapsed)}</span></div><div class="su">行駛(導航加總) · 含服務時間</div></div>`
    +[{lbl:'總里程',val:(d.total_distance_km||0).toFixed(1),unit:'公里',cls:'g'},
       {lbl:taskWord()+'站點',val:rows.length,unit:'個站點',cls:'p'},
       {lbl:doneWord()+'紀錄',val:`${onT} / ${late}`,unit:`準時 / 逾時${exc?` · ⚠ ${exc} 異常`:''}`,cls:late>0?'r':'g'}
      ].map(s=>`<div class="stat"><div class="sl">${s.lbl}</div><div class="sv ${s.cls}">${s.val}</div><div class="su">${s.unit}</div></div>`).join('');
  const sm=d.solver_metadata, el=$('solverInfo');
  if(el) el.innerHTML=sm?`🧠 後端使用：求解器 <span class="ac">${esc(sm.solver||'—')}</span> · 首解 <span class="ac">${esc(sm.first_solution_strategy||'—')}</span> · 區域搜尋 <span class="ac">${esc(sm.local_search_metaheuristic||'—')}</span>`:'';
}
function statusBadge(r){
  if(r.status==='completed') return (r.deliveredLate||r.lateness>0)?['tl-overdue-badge',`⚠ 逾時${doneWord()}`]:['tl-done-badge',`✓ ${doneWord()}完成`];
  if(r.status==='delayed')   return ['tl-late-badge','⏰ 已改約'];
  if(r.status==='cancelled') return ['tl-exc-badge','✕ 已取消'];
  if(r.status==='skipped')   return ['tl-exc-badge','⤼ 已跳過'];
  if(r.lateness>0)           return ['tl-overdue-badge',`⚠ 預估逾時 ${Math.round(r.lateness/60)}分`];
  return ['tl-pending-badge','待'+taskWord()];
}
function tlStopHTML(r,isFirst=false,isLast=false){
  const [bc,bt]=statusBadge(r);
  const editable=S.ui.editing && !EXCLUDED.includes(r.status);
  const ctrl=editable?`<div class="tl-ctrl"><button class="tl-mv" ${isFirst?'disabled':''} onclick="moveStop(${r.idx},-1)" title="上移" aria-label="上移">▲</button><span class="tl-drag" draggable="true" ondragstart="dragStart(event,${r.idx})" ondragend="dragEnd()" title="拖曳調整（電腦）">⠿</span><button class="tl-mv" ${isLast?'disabled':''} onclick="moveStop(${r.idx},1)" title="下移" aria-label="下移">▼</button></div>`:'';
  const drag=editable?` ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="dragDrop(event,${r.idx})"`:'';
  const tw=r.rescheduled?`改約 ${twToStrings(r.rescheduled).join('–')}`:'';
  return `<div class="tl-connector"></div><div class="tl-stop${r.status==='completed'?' done':''}${(r.status==='cancelled'||r.status==='skipped')?' removed':''}${r.lateness>0?' risk':''}${editable?' tl-editable':''}"${drag}>
      <div class="tl-num">${r.seq}</div>
      <div class="tl-info"><div class="tl-loc">${esc(r.name)}${priorityTag(r)}</div>
        <div class="tl-cust">${esc(r.address)}</div>
        <div class="tl-meta">抵達 ${secToHM(r.arrival)}${r.waitingMin>0?` · 等待 ${r.waitingMin}分`:''}${tw?' · '+tw:''}${r.status==='completed'&&r.deliveredAtTime?` · 送達 ${esc(r.deliveredAtTime)}`:''}</div></div>
      <span class="${bc}">${bt}</span>${ctrl}</div>`;
}
function doneSectionHeader(n){
  const caret=S.ui.collapseDone?'▸':'▾';
  return `<div class="done-sec-hdr" onclick="toggleDoneSection()"><span class="caret">${caret}</span>已${doneWord()} / 已處理（${n}）<span class="done-sec-hint">${S.ui.collapseDone?'點擊展開':'點擊收合'}</span></div>`;
}
function toggleDoneSection(){ S.ui.collapseDone=!S.ui.collapseDone; if(S.resp) render(); }
function renderTimeline(rows){
  const d=S.resp, depot=(d.route_sequence||['公司'])[0];
  const active=rows.filter(r=>!r.terminal), terminal=rows.filter(r=>r.terminal);
  // 起點出發時間：取後端 depot 站的服務完成（＝離站）時間，沒有就退回抵達時間。
  // 後端已把起點鎖在時間窗開始時刻，所以這裡會等於「預計出發時間」；
  // 按過「出發」之後則等於實際出發時間（以該時刻重排的結果）。
  const depotIdx=(d.route_indices||[])[0];
  const depotD=(d.route_details||[]).find(x=>x.index===depotIdx);
  const departSec=depotD?(depotD.service_completion_time_seconds ?? depotD.arrival_time_seconds):null;
  const departTxt=departSec!=null?`<div class="tl-depot-time">出發 ${secToHM(departSec)}</div>`:'';
  let html=`<div class="tl-depot"><div class="tl-depot-ico">🏠</div><div><div class="tl-depot-name">${esc(depot)}</div><div class="tl-depot-label">起點</div>${departTxt}</div></div>`;
  const editIdxs=active.filter(r=>!EXCLUDED.includes(r.status)).map(r=>r.idx);
  active.forEach(r=>{ const p=editIdxs.indexOf(r.idx); html+=tlStopHTML(r,p===0,p===editIdxs.length-1); });
  // 終點往上移：放在「配送中站點」之後、歷史區之前
  html+=`<div class="tl-connector"></div><div class="tl-depot"><div class="tl-depot-ico">🏁</div><div><div class="tl-depot-name">${esc((d.route_sequence||[]).slice(-1)[0]||depot)}</div><div class="tl-depot-label">終點</div></div></div>`;
  // 已完成（含逾時送達）/取消/跳過 → 收合在終點下方
  if(terminal.length){
    html+=doneSectionHeader(terminal.length);
    if(!S.ui.collapseDone) terminal.forEach(r=>{ html+=tlStopHTML(r); });
  }
  $('routeTimeline').innerHTML=html;
}
function renderStack(rows){
  const active=rows.filter(r=>!EXCLUDED.includes(r.status)).reverse();
  $('stackList').innerHTML=active.length?active.map((r,i)=>`<div class="stack-item"><div class="stack-n">${i+1}</div><div class="stack-inf"><div class="stack-loc">${esc(r.name)}</div><div class="stack-note">${esc(r.address)}</div></div><span class="stack-deliv">送貨 #${r.seq}</span></div>`).join(''):'<div class="empty"><div class="empty-sub">無資料</div></div>';
}
function renderNav(){
  const urls = S.ui.manualOrder ? buildManualNav() : (S.resp.driver_navigation_urls||[]);
  const box=$('navSection');
  if(!urls.length){ box.style.display='none'; return; } box.style.display='';
  box.innerHTML=`<div class="nav-hdr"><div class="nav-hdr-ttl">🗺 ${S.ui.mode==='receiving'?'收貨':'司機'}導航連結 <span style="opacity:.6;font-size:10px">共 ${urls.length} 段</span></div><div class="nav-hdr-note">${S.ui.manualOrder?'✏️ 手動調整順序':'後端自動生成'}</div></div><div class="nav-segs">${urls.map((u,i)=>`<a href="${u}" target="_blank" rel="noopener" class="nav-btn"><div class="nav-btn-num">${i+1}</div><div class="nav-btn-info"><div class="nav-btn-ttl">路段 ${i+1} / ${urls.length}</div><div class="nav-btn-sub">點擊開啟 Google Maps</div></div></a>`).join('')}</div>`;
}
function renderList(rows){
  $('dProg').textContent=`${rows.filter(r=>r.status==='completed').length} / ${rows.length}${rows.filter(r=>r.status==='cancelled'||r.status==='skipped').length?` · 異常 ${rows.filter(r=>r.status==='cancelled'||r.status==='skipped').length}`:''}`;
  const active=rows.filter(r=>!r.terminal), terminal=rows.filter(r=>r.terminal);
  let html=active.map(cardHTML).join('');
  if(terminal.length){
    html+=doneSectionHeader(terminal.length);
    if(!S.ui.collapseDone) html+=`<div class="done-sec">${terminal.map(cardHTML).join('')}</div>`;
  }
  $('dList').innerHTML=html;
}
function deliveryComplete(rows=orderedStops()){
  return S.ui.mode==='delivery' && rows.filter(r=>!r.terminal && !EXCLUDED.includes(r.status)).length===0;
}
function renderReceivePrep(rows=orderedStops()){
  const box=$('receivePrepCard'); if(!box) return;
  const plan=S.receive.plan;
  if(!plan || S.ui.mode==='receiving'){ box.style.display='none'; return; }
  box.style.display='';
  const data=plan.data||{};
  const canStart=deliveryComplete(rows);
  $('receivePrepStatus').textContent=canStart?'送貨已完成，可開始收貨':'送貨完成後可開始收貨';
  $('receiveRestName').textContent=plan.rest.name||'收貨起點';
  $('receiveRestAddr').textContent=plan.rest.address||'—';
  $('receiveLatestDepart').textContent=plan.latestDeparture||'—';
  const travel=data.total_travel_minutes!=null?data.total_travel_minutes:(data.total_time_minutes||0);
  const elapsed=data.total_elapsed_minutes!=null?data.total_elapsed_minutes:(data.total_time_minutes||0);
  $('receiveTravelElapsed').innerHTML=`${fmtHM(travel)}<span class="sv2"> / ${fmtHM(elapsed)}</span>`;
  $('receiveDistance').textContent=(data.total_distance_km||0).toFixed(1);
  $('receiveStops').textContent=`${Math.max(0,(plan.loc||[]).length-2)}`;
  const btn=$('startReceivingBtn'); if(btn){ btn.disabled=!canStart; btn.title=canStart?'以目前時間開始收貨':'請先完成送貨'; }
}
/* ─── 今日工作完成：配送/收件總覽 + 紀錄審閱 ───────────────────
   一天的送貨（與選填的收貨）全部處理完後，跳出成就感總覽，並把
   明細存進 localStorage 供日後審閱；使用者按「結束並清空貨物」時
   只清空當前貨物資料，保留上傳歷史與配送紀錄。               */
const DRKEY='logiops_day_records';
function loadDayRecords(){ try{ return JSON.parse(localStorage.getItem(DRKEY)||'[]'); }catch{ return []; } }
function saveDayRecord(rec){ try{ const a=loadDayRecords(); a.unshift(rec); localStorage.setItem(DRKEY, JSON.stringify(a.slice(0,30))); }catch{} }
function delDayRecord(id){ try{ localStorage.setItem(DRKEY, JSON.stringify(loadDayRecords().filter(x=>x.id!==id))); }catch{} }
// 由某一階段的 loc[] + 後端 resp{} 整理出可記錄/顯示的明細（不做任何路由計算）
function phaseSummary(loc, resp){
  if(!loc || !resp) return null;
  const details={}; (resp.route_details||[]).forEach(d=>{ details[d.index]=d; });
  const stops=[];
  loc.forEach((l,idx)=>{
    if(!l || idx===0 || l._rest || l._receiveRest || l.virtual_current_position) return;   // 排除公司/休息點/虛擬位置
    const d=details[idx];
    const arrival=d?d.arrival_time_seconds:null;
    let lateness=d?(d.lateness_seconds||0):0;
    const winEnd=hmToSec(twToStrings(l.rescheduled_time_window||l.time_window||['00:00','23:59'])[1]);
    if(arrival!=null && arrival>winEnd) lateness=Math.max(lateness, arrival-winEnd);
    stops.push({ seq:l._seq||l.id||idx, id:l.id??idx, name:l.name||`#${idx}`, address:l.address||'—',
      window:twToStrings(l.rescheduled_time_window||l.time_window||['00:00','23:59']).join('–'),
      arrival, doneTime:l.deliveredAtTime||null, status:l.status||'pending',
      late:!!(l.deliveredLate||lateness>0) });
  });
  stops.sort((a,b)=>(a.seq||0)-(b.seq||0));
  const completed=stops.filter(s=>s.status==='completed');
  return { stops, total:stops.length, completed:completed.length,
    onTime:completed.filter(s=>!s.late).length, late:completed.filter(s=>s.late).length,
    exception:stops.filter(s=>s.status==='cancelled'||s.status==='skipped').length,
    distanceKm:resp.total_distance_km||0,
    travelMin:(resp.total_travel_minutes!=null?resp.total_travel_minutes:resp.total_time_minutes)||0,
    elapsedMin:resp.total_elapsed_minutes||0 };
}
// 收集今日紀錄：若已進入收貨，送貨明細取自 startReceiving 時保存的快照
function buildDayRecord(){
  let delivery, receive=null;
  if(S.receive.active && S.receive.deliverySnapshot){
    delivery=phaseSummary(S.receive.deliverySnapshot.loc, S.receive.deliverySnapshot.resp);
    receive=phaseSummary(S.loc, S.resp);
  } else {
    delivery=phaseSummary(S.loc, S.resp);
  }
  return { id:Date.now(), date:new Date().toISOString(), delivery, receive };
}
// 目前任務是否全部處理完（剩餘待處理站＝0），且沒有待接續的收貨階段
function dayAllDone(rows=orderedStops()){
  if(!S.resp || !rows.length) return false;
  const remaining=rows.filter(r=>!r.terminal && !EXCLUDED.includes(r.status)).length;
  if(remaining>0) return false;
  const receivePending = S.ui.mode==='delivery' && S.receive.raw.length && !S.receive.active;
  return !receivePending;
}
function renderCompleteDay(rows=orderedStops()){
  const box=$('completeDaySection'); if(!box) return;
  if(!dayAllDone(rows)){ box.style.display='none'; box.innerHTML=''; return; }
  box.style.display='';
  const word=S.receive.active?'收貨':'送貨';
  box.innerHTML=`<div class="cd-cta">
    <div class="cd-cta-emoji">🎉</div>
    <div class="cd-cta-txt"><div class="cd-cta-ttl">今日${word}任務全部完成！</div>
      <div class="cd-cta-sub">點擊查看今日配送與收件總覽，完整記錄今日成果</div></div>
    <button class="btn btn-grn" onclick="completeDay()">🏁 完成今日工作</button>
  </div>`;
}
function completeDay(){
  const rec=buildDayRecord();
  if(!rec.delivery || !rec.delivery.total){ toast('尚無可記錄的配送資料','w'); return; }
  if(!S.ui.dayRecorded){ saveDayRecord(rec); S.ui.dayRecorded=true; S.ui.lastRecord=rec; renderHistoryView(); }
  openSummary(S.ui.lastRecord||rec, false);
}
function findDayRecord(id){ return loadDayRecords().find(x=>x.id===id) || (S.ui.lastRecord&&S.ui.lastRecord.id===id?S.ui.lastRecord:null); }
function statusTag(s){
  if(s.status==='completed') return s.late?'<span class="cd-tag late">⚠ 逾時</span>':'<span class="cd-tag ok">✓ 準時</span>';
  if(s.status==='cancelled') return '<span class="cd-tag exc">✕ 取消</span>';
  if(s.status==='skipped')   return '<span class="cd-tag exc">⤼ 跳過</span>';
  if(s.status==='delayed')   return '<span class="cd-tag late">⏰ 改約</span>';
  return '<span class="cd-tag">待處理</span>';
}
function summaryPhaseHTML(title, ico, colLbl, doneWord, ph){
  if(!ph || !ph.total) return '';
  const rowsHtml=ph.stops.map(s=>`<tr><td class="mono">${s.seq}</td><td>${esc(s.name)}</td><td class="cd-addr">${esc(s.address)}</td><td class="mono">${esc(s.window)}</td><td class="mono">${s.doneTime?esc(s.doneTime):(s.arrival!=null?secToHM(s.arrival):'—')}</td><td>${statusTag(s)}</td></tr>`).join('');
  return `<div class="cd-phase">
    <div class="cd-phase-hdr">${ico} ${title}</div>
    <div class="cd-stats">
      <div class="stat"><div class="sl">已${doneWord}站點</div><div class="sv g">${ph.completed} / ${ph.total}</div><div class="su">已${doneWord} / 總站點</div></div>
      <div class="stat"><div class="sl">準時 / 逾時</div><div class="sv ${ph.late>0?'r':'g'}">${ph.onTime} / ${ph.late}</div><div class="su">${ph.exception?`⚠ ${ph.exception} 異常`:'準時抵達'}</div></div>
      <div class="stat"><div class="sl">總里程</div><div class="sv">${ph.distanceKm.toFixed(1)}</div><div class="su">公里</div></div>
      <div class="stat"><div class="sl">總耗時</div><div class="sv p">${fmtHM(ph.elapsedMin)}</div><div class="su">行駛 ${fmtHM(ph.travelMin)}</div></div>
    </div>
    <div class="cd-tbl-wrap"><table class="cd-tbl"><thead><tr><th>#</th><th>${colLbl}</th><th>地址</th><th>時間窗</th><th>完成</th><th>狀態</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
  </div>`;
}
function openSummary(rec, fromHistory=false){
  const o=$('summaryModal'); if(!o||!rec) return;
  const d=new Date(rec.date), p=n=>String(n).padStart(2,'0');
  const dateStr=`${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  o.querySelector('.cd-modal-head').innerHTML=fromHistory
    ? `<div class="cd-modal-ttl">📋 配送紀錄回顧</div><div class="cd-modal-sub">${dateStr}</div>`
    : `<div class="cd-modal-ttl">🎉 今日工作完成，辛苦了！</div><div class="cd-modal-sub">${dateStr} · 今日配送與收件總覽</div>`;
  o.querySelector('.cd-modal-body').innerHTML=
    summaryPhaseHTML('送貨總覽','🚚','送貨點','送達',rec.delivery)+summaryPhaseHTML('收貨總覽','📥','收貨點','收貨',rec.receive);
  o.querySelector('.cd-modal-foot').innerHTML=
    `<button class="btn btn-ghost btn-sm" onclick="exportDayCsv(${rec.id})">📥 匯出明細(CSV)</button>
     ${fromHistory?'':'<button class="btn btn-amb btn-sm" onclick="clearDay()">🗂 結束並清空貨物</button>'}
     <button class="btn btn-grn btn-sm" onclick="closeSummary()">關閉</button>`;
  o.classList.add('on');
}
function closeSummary(){ const o=$('summaryModal'); if(o) o.classList.remove('on'); }
function exportDayCsv(id){
  const rec=findDayRecord(id); if(!rec){ toast('找不到該筆紀錄','w'); return; }
  const rows=[['階段','序號','ID','名稱','地址','時間窗','完成時間','狀態','逾時']];
  const push=(label,ph)=>{ if(!ph) return; ph.stops.forEach(s=>rows.push([label,s.seq,s.id,s.name,s.address,s.window,s.doneTime||(s.arrival!=null?secToHM(s.arrival):''),s.status,s.late?'是':'否'])); };
  push('送貨',rec.delivery); push('收貨',rec.receive);
  const csv='﻿'+rows.map(r=>r.map(c=>`"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const d=new Date(rec.date),p=n=>String(n).padStart(2,'0');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  a.download=`配送紀錄_${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  toast('已匯出今日配送明細 CSV','s');
}
// 結束今日工作：清空當前貨物資料（保留上傳歷史與配送紀錄）
function clearDay(){
  if(!confirm('確定結束今日工作並清空貨物資料？\n（已上傳的 Excel 歷史與配送紀錄都會保留，可日後重新載入或審閱）')) return;
  S.raw=[]; S.headers=[]; S.colMap={}; S.loc=[]; S.restCount=0; S.resp=null;
  S.receive={ raw:[], headers:[], colMap:{}, plan:null, active:false, deliverySnapshot:null };
  S.ui.manualOrder=null; S.ui.lastAction=null; S.ui.editing=false; S.ui.collapseDone=false;
  S.ui.dayRecorded=false; S.ui.lastRecord=null; resetDeparture();
  resetEndSelection(true);
  if($('fi')) $('fi').value=''; if($('recvFi')) $('recvFi').value='';
  setMode('delivery', true);
  $('upPreview').style.display='none'; $('upHint').style.display='block'; setAlert('');
  renderEndOptions(); renderHistory(); renderReceiveHistory(); updateReceiveUploadAvailability(); render();
  closeSummary();
  renderHistoryView();
  sw('upload', document.querySelector('.tabs .tab:nth-child(1)'));
  toast('今日工作已結束，貨物資料已清空（上傳歷史保留）','s');
}
// 「📚 歷史紀錄」分頁：列出所有已存的配送紀錄，可隨時審閱、匯出、刪除
function renderHistoryView(){
  const recs=loadDayRecords();
  const badge=$('bH'); if(badge) badge.textContent=recs.length;
  if($('hEmpty')) $('hEmpty').style.display=recs.length?'none':'block';
  if($('hContent')) $('hContent').style.display=recs.length?'block':'none';
  const box=$('histList'); if(!box) return;
  if($('hCount')) $('hCount').textContent=`${recs.length} 筆`;
  box.innerHTML=recs.map(r=>{
    const d=new Date(r.date),p=n=>String(n).padStart(2,'0');
    const dv=r.delivery||{}, rv=r.receive;
    const lateTotal=(dv.late||0)+(rv?rv.late:0);
    const excTotal=(dv.exception||0)+(rv?rv.exception:0);
    return `<div class="hist-card">
      <div class="hist-card-main">
        <div class="hist-date">${d.getFullYear()}/${p(d.getMonth()+1)}/${p(d.getDate())} <span class="hist-time">${p(d.getHours())}:${p(d.getMinutes())}</span></div>
        <div class="hist-tags">
          <span class="hist-chip">🚚 送達 ${dv.completed||0}/${dv.total||0}</span>
          ${rv?`<span class="hist-chip">📥 收貨 ${rv.completed||0}/${rv.total||0}</span>`:''}
          ${lateTotal?`<span class="hist-chip warn">⚠ 逾時 ${lateTotal}</span>`:''}
          ${excTotal?`<span class="hist-chip exc">✕ 異常 ${excTotal}</span>`:''}
        </div>
      </div>
      <div class="fl gap8 ic hist-acts">
        <button class="btn btn-ghost btn-sm" onclick="exportDayCsv(${r.id})">📥 CSV</button>
        <button class="btn btn-grn btn-sm" onclick="openSummary(findDayRecord(${r.id}),true)">查看</button>
        <button class="uh-del" onclick="delDayRecord(${r.id});renderHistoryView()" title="刪除此筆紀錄">✕</button>
      </div>
    </div>`;
  }).join('');
}
function clearAllDayRecords(){
  if(!loadDayRecords().length) return;
  if(!confirm('確定清除全部配送紀錄？此動作無法復原（上傳的 Excel 歷史不受影響）。')) return;
  try{ localStorage.removeItem(DRKEY); }catch{}
  renderHistoryView(); toast('已清除全部配送紀錄','i');
}

// 送貨 / 收貨 上傳分頁切換（同一張卡片，按鈕切換）
function setUploadTab(which){
  if(which==='receive' && !S.raw.length){
    toast('請先載入送貨 Excel，再上傳收貨 Excel','w');
    which='deliver';
  }
  const receive = which==='receive';
  if($('upPanelDeliver')) $('upPanelDeliver').style.display=receive?'none':'';
  if($('upPanelReceive')) $('upPanelReceive').style.display=receive?'':'none';
  if($('upTabDeliver')) $('upTabDeliver').classList.toggle('on',!receive);
  if($('upTabReceive')) $('upTabReceive').classList.toggle('on',receive);
  if($('upTabHint')) $('upTabHint').textContent=receive
    ? '上傳收貨 Excel（選填）；送貨完成後可接續收貨行程'
    : '上傳送貨訂單 Excel，自動對應欄位、送後端排程';
}
function updateReceiveUploadAvailability(){
  const enabled=!!S.raw.length;
  const tab=$('upTabReceive');
  if(tab){ tab.style.display=enabled?'':'none'; tab.disabled=!enabled; }
  if(!enabled){
    if($('upPanelReceive')) $('upPanelReceive').style.display='none';
    if($('upPanelDeliver')) $('upPanelDeliver').style.display='';
    if($('upTabDeliver')) $('upTabDeliver').classList.add('on');
    if(tab) tab.classList.remove('on');
  }
  renderReceiveUpload();
}
// 共用：把欄位自動對應結果畫進指定格線（送貨用 #cmg、收貨用 #recvCmg）
function renderColMapGrid(gridId,colMap){
  const grid=$(gridId); if(!grid) return; grid.innerHTML='';
  COLS.forEach(({k,lbl,req})=>{
    const match=colMap[k]||'';
    const cls=match?'ok':(req?'miss':''), txt=match?esc(match):(req?'⚠ 未對應':'—（選填）');
    const el=document.createElement('div'); el.className='cmi';
    el.innerHTML=`<div class="cml">${lbl}${req?'<span class="cmr">*</span>':''}</div><div class="cms cms-ro ${cls}">${txt}</div>`;
    grid.appendChild(el);
  });
}
function renderReceiveUpload(){
  const deliveryReady=!!S.raw.length;
  const dot=$('recvDot'); if(dot) dot.style.display=(deliveryReady&&S.receive.raw.length)?'':'none';   // 切到送貨頁時仍提示已載入收貨
  const box=$('recvPreview'); if(!box) return;
  if(!deliveryReady || !S.receive.raw.length){ box.style.display='none'; return; }
  box.style.display='';
  $('recvCount').textContent=`${S.receive.raw.length} 筆`;
  const requiredOk = ['id','name','address'].every(k=>!!S.receive.colMap[k]);
  $('recvStatus').textContent=requiredOk?'欄位已對應':'缺少必要欄位';
  $('recvStatus').className=`ss ${requiredOk?'ac':'risk-text'}`;
  // 全表預覽（與送貨預覽一致）
  const MAX=60, hs=S.receive.headers;
  $('recvTh').innerHTML=`<tr>${hs.map(h=>`<th>${esc(h)}</th>`).join('')}</tr>`;
  $('recvTb').innerHTML=S.receive.raw.slice(0,MAX).map(r=>`<tr>${hs.map(h=>`<td>${esc(String(r[h]??''))}</td>`).join('')}</tr>`).join('')
    +(S.receive.raw.length>MAX?`<tr><td colspan="${hs.length}" style="text-align:center;color:var(--txt3);padding:8px">… 另有 ${S.receive.raw.length-MAX} 筆</td></tr>`:'');
  renderColMapGrid('recvCmg', S.receive.colMap);   // 欄位自動對應（管理員模式才顯示，由 CSS admin-only 控制）
}
function clearReceiveFile(showToast=true){
  S.receive={ raw:[], headers:[], colMap:{}, plan:null, active:false, deliverySnapshot:S.receive.deliverySnapshot||null };
  if($('recvFi')) $('recvFi').value='';
  S.ui.recvFileName=null;
  renderReceiveUpload();
  renderUploadState();
  if(showToast) toast('已清除收貨資料','i');
}
const ACTION_LABEL={ completed:'已送達', delayed:'已改約', cancelled:'已取消', skipped:'已跳過', pending:'已復原' };
function actionLabel(status){
  if(status==='completed') return doneActionLabel();
  return ACTION_LABEL[status] || status;
}
// 優先權徽章：只有「比預設更急」的站點才標，預設值標在每一站等於雜訊。
const DEFAULT_PRIORITY = 3;
function priorityTag(r){
  const p = Number(r.priority);
  if(!p || p >= DEFAULT_PRIORITY) return '';
  return ` <span class="risk-tag" title="優先權 ${p}（數字越小越急）">優先 ${p}</span>`;
}
// 單站導航：司機在站點按一下就開 Google Maps 導到該址，不必回上方找對應路段。
function stopNavUrl(r){
  const dest = (r && (r.address || r.name)) || '';
  return dest ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}&travelmode=driving` : '';
}
function firstActiveStopIndex(){
  return orderedStops().find(r=>!r.terminal && !EXCLUDED.includes(r.status))?.idx ?? null;
}
function cardHTML(r){
  const [pc,pt]=statusBadge(r);
  const pill={'tl-done-badge':'pill-ontime','tl-overdue-badge':'pill-overdue','tl-late-badge':'pill-late','tl-exc-badge':'pill-exc','tl-pending-badge':'pill-p'}[pc]||'pill-p';
  const tw=twToStrings(r.rescheduled||S.loc[r.idx].time_window).join(' – ');
  const done=r.status==='completed', removed=r.status==='cancelled'||r.status==='skipped';
  return `<div class="dc${done?' done':''}${removed?' removed':''}${r.lateness>0?' risk':''}" id="dc-${r.idx}">
    <div class="dc-hdr"><div class="dc-seq"><div class="dc-n">${r.seq}</div><div>
      <div class="dc-loc">${esc(r.name)}${priorityTag(r)}</div>
      <div class="dc-cid mono">ID: ${r.id} · index: ${r.idx}</div></div></div>
      <span class="pill ${pill}">${pt}</span></div>
    <div class="dc-main">
      <div class="dc-addr">${esc(r.address)}</div>
      <div class="dc-chips">
        <span class="chip chip-tw${r.rescheduled?' resched':''}">${r.rescheduled?'改約':'時間窗'} <b>${tw}</b></span>
        <span class="chip ${r.lateness>0?'chip-risk':'chip-eta'}">預估抵達 <b>${secToHM(r.arrival)}</b>${r.lateness>0?` ⚠ 逾時 ${Math.round(r.lateness/60)} 分`:''}</span>
        <span class="chip">${serviceStartLabel()} <b>${secToHM(r.serviceStart)}</b> → ${serviceDoneLabel()} <b>${done?(r.deliveredAtTime||secToHM(r.serviceComplete)):secToHM(r.serviceComplete)}</b></span>
        ${r.waitingMin>0?`<span class="chip">等待 <b>${r.waitingMin}</b> 分</span>`:''}
        ${done&&r.deliveredAtTime?`<span class="chip chip-done">實際${doneWord()} <b>${esc(r.deliveredAtTime)}</b></span>`:''}
      </div>
      ${!done&&!removed?`<div class="dc-admin admin-only"><div class="ig"><div class="il">實際完成時間（測試用）</div><input type="time" class="cms" id="done-time-${r.idx}" value="${secToHM(r.serviceComplete)}" /></div></div>`:''}
    </div>
    <div class="dc-ftr">
      ${done||removed?'<span class="sm mu mono">已處理</span>':`<a class="dc-nav" href="${stopNavUrl(r)}" target="_blank" rel="noopener" aria-label="用 Google Maps 導航到 ${esc(r.name)}">🗺 導航</a>`}
      <div class="fl gap8">
      ${done||removed?`<button class="btn btn-ghost btn-sm" onclick="revertStop(${r.idx})">↺ 還原狀態</button>`
        :`<button class="btn btn-ghost btn-sm" onclick="togglePanel(${r.idx})">⚠ 回報</button>
          <button class="btn btn-grn btn-sm" onclick="markDone(${r.idx})">✓ 標記${doneWord()}</button>`}
    </div></div>
    ${done||removed?'':`<div class="exc-panel" id="exc-${r.idx}" style="display:none">${panelHTML(r)}</div>`}
  </div>`;
}
// 站點下貨（服務）時間秒數：優先用該站設定，其次進階參數，最後後端預設 600 秒
function stationServiceSec(l){
  if(l && l.service_time_seconds>0) return l.service_time_seconds;
  const adv=Number($('advService')?.value); if(adv>0) return adv;
  return 600;
}
// 結束時間自動 ≥ 開始 + 下貨時間（避免結束比開始早，且保留下貨所需時間）
function syncRpEnd(idx){
  const sEl=$(`rp-start-${idx}`), eEl=$(`rp-end-${idx}`); if(!sEl||!eEl) return;
  const minEnd=addMinutesHM(sEl.value, Math.round(stationServiceSec(S.loc[idx])/60));
  if(hmToSec(eEl.value) < hmToSec(minEnd)) eEl.value=minEnd;
}
function panelHTML(r){
  const svcMin=Math.round(stationServiceSec(S.loc[r.idx])/60);
  const base=clockHM(), defStart=addMinutesHM(base,60), defEnd=addMinutesHM(defStart,svcMin);
  return `<div class="cmg2 mb10">
    <div class="cmi"><div class="cml">回報類型</div><select class="cms" id="rp-type-${r.idx}" onchange="onRpType(${r.idx})">${Object.entries(reportStatusLabels()).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></div>
    <div class="cmi" id="rp-twrap-${r.idx}"><div class="cml">新的可${taskWord()}時間窗</div><div class="fl gap8"><input type="time" class="cms" id="rp-start-${r.idx}" value="${defStart}" onchange="syncRpEnd(${r.idx})" /><input type="time" class="cms" id="rp-end-${r.idx}" value="${defEnd}" /></div><div class="sm mu mono" style="margin-top:4px">結束會自動 ≥ 開始 ＋ 作業時間（約 ${svcMin} 分）</div></div>
  </div>
  <div class="fl gap8"><button class="btn btn-amb btn-sm" onclick="submitReport(${r.idx})">送出回報</button><button class="btn btn-ghost btn-sm" onclick="togglePanel(${r.idx})">取消</button></div>`;
}
function togglePanel(idx){
  if(S.ui.optimizing){ toast('路線正在計算中，請等待後端回傳結果','w'); return; }
  if(EXCLUDED.includes(S.loc[idx]?.status)){ toast('此站已處理，需先還原狀態才能操作','w'); return; }
  const p=$('exc-'+idx); if(!p)return; const show=p.style.display==='none'; p.style.display=show?'':'none'; if(show) onRpType(idx);
}
function onRpType(idx){ const t=$('rp-type-'+idx).value, w=$('rp-twrap-'+idx); if(w) w.style.display=t==='delayed'?'':'none'; }

/* ─── 司機動作（改 status → 後端重排）────────────────────── */
async function markDone(idx){
  if(S.ui.optimizing){ toast('路線正在計算中，請等待後端回傳結果','w'); return false; }
  const l=S.loc[idx]; if(!l||l.status==='completed') return;
  if(EXCLUDED.includes(l.status)){ toast(`此站已處理，需先還原狀態才能標記${doneWord()}`,'w'); return false; }
  const expectedNextIdx=firstActiveStopIndex();
  const jumped=expectedNextIdx!=null && expectedNextIdx!==idx;
  const d=(S.resp.route_details||[]).find(x=>x.index===idx);
  const plannedTime = d ? secToHM(d.service_completion_time_seconds ?? d.service_start_time_seconds ?? d.arrival_time_seconds) : testClockHM();
  // 一般使用者：實際完成時間一律抓本地時間，不可自填；管理員才可用測試輸入指定時間。
  const enteredTime = isAdmin() ? ($(`done-time-${idx}`)?.value || '') : nowHM();
  const routeTime = enteredTime || plannedTime;
  // 逾時判定：後端回報逾時，或實際抵達/送達時間已超過（改約）時間窗結束
  const winEndSec = hmToSec(twToStrings(l.rescheduled_time_window || l.time_window || ['00:00','23:59'])[1]);
  const arrSec = (d && d.arrival_time_seconds!=null) ? d.arrival_time_seconds : hmToSec(routeTime);
  l.status='completed'; l.deliveredLate=!!(d&&d.lateness_seconds>0) || (arrSec>winEndSec); l.deliveredAt=new Date().toISOString(); l.deliveredAtTime=routeTime;
  S.ui.lastAction={idx, name:l.name, status:'completed', time:routeTime};
  if(isAdmin()) setTestClock(routeTime);   // 僅管理員測試時鐘隨進度推進；一般使用者保留自訂的預計出發時間
  if(routeTime===plannedTime && !jumped){
    render();
    setAlert(`✓ 已依預計時間更新${doneWord()}狀態，路線未重新計算。`,'ok');
    toast(`${doneActionLabel()}，未重排`,'s');
    return true;
  }
  if(!jumped && applyLocalScheduleShift(idx, plannedTime, routeTime)){
    render();
    setAlert(`✓ 已依實際完成時間調整後續預估，未重新計算路線。`,'ok');
    toast(`${doneActionLabel()}，已調整時間`,'s');
    return true;
  }
  if(jumped) toast(`已跳站${doneWord()}，重新推估剩餘路線`,'i');
  else toast('實際時間會造成後續逾時，交由後端重新規劃','i');
  const ok = await runOptimize(idx, routeTime);
  if(!ok) render();
}
async function submitReport(idx){
  if(S.ui.optimizing){ toast('路線正在計算中，請等待後端回傳結果','w'); return false; }
  const l=S.loc[idx]; if(!l) return;
  if(EXCLUDED.includes(l.status)){ toast('此站已處理，需先還原狀態才能回報','w'); return false; }
  const type=$('rp-type-'+idx).value;
  l.status=type;
  if(type==='delayed'){
    const svcMin=Math.round(stationServiceSec(l)/60);
    const start=$(`rp-start-${idx}`)?.value || addMinutesHM(clockHM(),60);
    let end=$(`rp-end-${idx}`)?.value || addMinutesHM(start,svcMin);
    const minEnd=addMinutesHM(start,svcMin);
    if(hmToSec(end)<hmToSec(minEnd)) end=minEnd;   // 結束自動加上下貨時間，避免比開始早
    l.rescheduled_time_window=[start,end];
  }
  else delete l.rescheduled_time_window;
  const actT=clockHM();   // 一般使用者＝本地時間，管理員＝測試時鐘
  S.ui.lastAction={idx, name:l.name, status:type, time:actT, tw: l.rescheduled_time_window?twToStrings(l.rescheduled_time_window).join('–'):null};
  // 收貨模式：固定以收貨起點為路線起點重排（與「重新最佳化」一致），不加虛擬目前位置/current_index，
  // 避免後端把收貨起點當成中途站而產生錯誤導航連結。改約的時間窗仍由 rescheduled_time_window 處理。
  if(S.ui.mode==='receiving' && S.receive.active){ await runOptimize(null, actT, {keepReceivingStartOnly:true}); }
  // 送貨改約（更改時間窗）代表司機已在途中取得新資訊：用同地址的虛擬目前位置當起點，
  // 原站保留為未來待處理站，ETA 由目前時間重新往後推。
  else if(type==='delayed') await runOptimize(idx, actT, {virtualCurrentFrom:idx});
  else await runOptimize(idx, actT, {});
}
async function revertStop(idx){
  if(S.ui.optimizing){ toast('路線正在計算中，請等待後端回傳結果','w'); return false; }
  const l=S.loc[idx]; if(!l)return;
  l.status='pending';
  delete l.rescheduled_time_window;
  delete l.deliveredAtTime;
  delete l.deliveredAt;
  delete l.deliveredLate;
  S.ui.lastAction={idx, name:l.name, status:'pending', time:clockHM()};
  await runOptimize(null, clockHM());
}
async function startReceiving(){
  if(S.ui.optimizing){ toast('路線正在計算中，請等待後端回傳結果','w'); return false; }
  const plan=S.receive.plan;
  if(!plan){ toast('尚無收貨行程','w'); return false; }
  if(!deliveryComplete()){ toast('請先完成送貨，再開始收貨','w'); return false; }
  const deliverySnapshot={loc:S.loc,resp:S.resp};
  S.receive.deliverySnapshot=deliverySnapshot;
  S.receive.active=true;
  S.loc=plan.loc.map(l=>({...l,status:'pending'}));
  S.loc.forEach(l=>{ delete l._seq; delete l.deliveredAt; delete l.deliveredAtTime; delete l.deliveredLate; });
  S.resp=null;
  S.ui.manualOrder=null;
  S.ui.lastAction=null;
  setMode('receiving', true);
  render();
  const current=secToHM(Math.max(hmToSec(clockHM() || nowHM()), hmToSec(departureHM())));
  if(S.loc[plan.restIndex]) S.loc[plan.restIndex].time_window=[current,current];
  // 「開始收貨」本身就是從休息點出發，直接記為收貨段的實際出發時間（不再按一次出發）。
  S.ui.departedAt=current;
  setTestClock(current);
  S.ui.optimizing=true;
  setBusy(true,'收貨路線排程中…');
  setAlert('');
  try{
    const payload=routePayloadForLocations(S.loc,{startIndex:plan.restIndex,endIndex:0,currentTime:current});
    const data=await postOptimizePayload(payload);
    setDot('on');
    S.resp=data;
    render();
    sw('delivery', document.querySelector('.tabs .tab:nth-child(3)'));
    setAlert('✓ 收貨排程完成。','ok');
    toast('已開始收貨行程','s');
    return true;
  }catch(err){
    S.receive.active=false;
    S.loc=deliverySnapshot.loc;
    S.resp=deliverySnapshot.resp;
    setMode('delivery', true);
    if(S.resp) render();
    setAlert(`收貨排程失敗：${err.message}`,'warn');
    toast(`收貨排程失敗：${err.message}`,'e');
    return false;
  }finally{
    S.ui.optimizing=false;
    setBusy(false);
  }
}

/* ─── 手動調整順序：編輯期間只改畫面，「完成調整」才送一次後端 ───── */
function setEditRouteBtn(){
  const b=$('editRouteBtn'); if(!b) return;
  b.textContent=S.ui.editing?'✓ 完成調整':'✏️ 手動調整';
  b.classList.toggle('btn-amb',S.ui.editing);
  b.classList.toggle('btn-ghost',!S.ui.editing);
}
async function toggleEditRoute(){
  if(S.ui.optimizing){ toast('路線正在計算中，請等待後端回傳結果','w'); return false; }
  if(!S.ui.editing){
    S.ui.editing=true; setEditRouteBtn();
    if(S.resp) render();
    toast('用 ▲▼ 按鈕（手機）或拖曳 ⠿（電腦）調整順序，按「完成調整」才送後端重算時間','i');
    return true;
  }
  // 完成調整：把編輯期間累積的順序一次送後端，依這個順序重算抵達/完成時間與導航。
  const order=S.ui.manualOrder;
  S.ui.editing=false; setEditRouteBtn();
  if(!order || order.length<2){ if(S.resp) render(); return true; }
  const inTransit=S.loc.some(l=>l&&l.status&&l.status!=='pending');
  const ok=await runOptimize(null, inTransit?clockHM():undefined, {manualOrder:order});
  if(ok) setAlert('✓ 已依手動順序重新計算各站時間。','ok');
  else { S.ui.manualOrder=order; render(); }   // 後端失敗時保留手動順序，不讓畫面跳回舊順序
  return ok;
}
function dragStart(e,idx){ S.ui.dragIdx=idx; e.dataTransfer.effectAllowed='move'; }
function dragOver(e){ e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function dragLeave(e){ e.currentTarget.classList.remove('drag-over'); }
function dragEnd(){ document.querySelectorAll('.tl-stop.drag-over').forEach(el=>el.classList.remove('drag-over')); }
function dragDrop(e,targetIdx){
  e.preventDefault(); dragEnd();
  const order=(S.ui.manualOrder||orderedStops().filter(r=>!EXCLUDED.includes(r.status)).map(r=>r.idx));
  const from=order.indexOf(S.ui.dragIdx), to=order.indexOf(targetIdx);
  if(from<0||to<0||from===to) return;
  order.splice(to,0,order.splice(from,1)[0]);
  S.ui.manualOrder=order; render(); toast('順序已更新，按「完成調整」送後端重算時間','s');
}
// 手機友善：▲▼ 按鈕將站點在順序中往上/下移一格（dir=-1 上、+1 下）；與拖曳共用同一份順序來源
function moveStop(idx,dir){
  const order=(S.ui.manualOrder||orderedStops().filter(r=>!EXCLUDED.includes(r.status)).map(r=>r.idx)).slice();
  const i=order.indexOf(idx); if(i<0) return;
  const j=i+dir; if(j<0||j>=order.length) return;
  [order[i],order[j]]=[order[j],order[i]];
  S.ui.manualOrder=order; render(); toast('順序已更新，按「完成調整」送後端重算時間','s');
}
function buildManualNav(){
  const depot=S.loc[0]||{}; const pts=[depot.address||depot.name, ...(S.ui.manualOrder||[]).map(i=>S.loc[i]?.address||S.loc[i]?.name), depot.address||depot.name].filter(Boolean);
  if(pts.length<2) return [];
  const MAX=10, urls=[];
  for(let i=0;i<pts.length-1;i+=(MAX-1)){
    const seg=pts.slice(i,i+MAX); if(seg.length<2) break;
    let u=`https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(seg[0])}&destination=${encodeURIComponent(seg[seg.length-1])}`;
    const wp=seg.slice(1,-1).map(encodeURIComponent).join('|'); if(wp) u+=`&waypoints=${wp}`;
    urls.push(u+'&travelmode=driving');
  }
  return urls;
}

/* ─── 初始化 ─────────────────────────────────────────────── */
async function pingHealth(){ const dot=$('dot'); try{ const r=await fetch(`${apiBase()}/api/v1/health`); setDot(r.ok?'on':'off'); if(dot) dot.title=r.ok?'後端已連線':'後端異常'; }catch{ setDot('off'); if(dot) dot.title='無法連線後端（請從 127.0.0.1:5173 或 :3000 開啟）'; } }
applyRole();
// 部署版（以 https 開啟、非本機）自動把 API Base 指向公開後端，讓手機/他人開公開頁免手動設定；
// 本機（http、localhost/127.0.0.1/區網 IP）維持欄位原值不動。
if(location.protocol==='https:' && $('apiBase') && /^https?:\/\/(localhost|127\.0\.0\.1)/.test($('apiBase').value)){
  $('apiBase').value='https://tsptw.onrender.com';
}
pingHealth();
loadCompanySettings();
renderHistory();
renderReceiveHistory();
renderHistoryView();
renderEndOptions();
updateReceiveUploadAvailability();
(async()=>{
  await loadFixtureFromQuery();
  await loadReceiveFixtureFromQuery();
})();
updateDriverClock();
setInterval(updateDriverClock, 30000);   // 目前時間：本地即時時鐘（到分）
