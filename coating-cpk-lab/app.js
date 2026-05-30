const $ = id => document.getElementById(id);
const inputIds = ["metricName","sampleSize","lsl","usl","target","sigma","offset","drift","wear","burst"];
const I = Object.fromEntries(inputIds.map(id => [id, $(id)]));
let rows = [];
let lastReport = "";

const n = id => Number(I[id].value);
const f = (v, d = 3) => Number.isFinite(v) ? Number(v).toFixed(d) : "--";
const esc = s => String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function normal() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function cfg() {
  const c = {
    metricName: I.metricName.value.trim() || "过程指标",
    n: clamp(Math.round(n("sampleSize")), 30, 3000),
    lsl: n("lsl"), usl: n("usl"), target: n("target"),
    baseSigma: Math.max(n("sigma"), 0.001),
    offset: n("offset"), drift: n("drift"), wear: n("wear"), burst: n("burst") / 100
  };
  if (!(c.lsl < c.usl)) throw Error("规格下限必须小于规格上限");
  if (!(c.target > c.lsl && c.target < c.usl)) throw Error("目标值应位于规格范围内");
  return c;
}

function sync() {
  $("offsetOut").textContent = f(n("offset"), 2);
  $("driftOut").textContent = f(n("drift"), 2);
  $("wearOut").textContent = f(n("wear"), 2);
  $("burstOut").textContent = `${f(n("burst"), 1)}%`;
}

function timeStr(d) {
  const p = x => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function generateData() {
  let c;
  try { c = cfg(); } catch(e) { alert(e.message); return; }
  const start = new Date();
  rows = Array.from({length: c.n}, (_, i) => {
    const x = c.n === 1 ? 0 : i / (c.n - 1);
    const sigma = c.baseSigma * (1 + c.wear * x * 1.6);
    const drift = c.drift * (x - 0.5);
    const wearBias = -0.45 * c.wear * x;
    let value = c.target + c.offset + drift + wearBias + normal() * sigma;
    let tag = "normal";
    if (Math.random() < c.burst) {
      value -= (0.7 + Math.random() * 1.9) * c.baseSigma * 3;
      tag = "bubble_or_leak";
    } else if (c.wear > 0.65 && x > 0.55 && Math.random() < c.wear * 0.12) {
      value -= Math.random() * c.baseSigma * 2;
      tag = "wear_tail";
    } else if (Math.abs(c.drift) > 0.75 && Math.random() < 0.08) {
      tag = "drift_zone";
    }
    return { idx: i + 1, time: timeStr(new Date(start.getTime() + i * 60000)), value, tag };
  });
  analyze();
}

function stat(vals) {
  const mean = vals.reduce((a,b)=>a+b,0) / vals.length;
  const sigma = Math.sqrt(vals.reduce((s,v)=>s+(v-mean)**2,0) / Math.max(vals.length-1,1));
  return { mean, sigma, n: vals.length };
}

function cap(vals, lsl, usl) {
  const s = stat(vals);
  const cp = (usl - lsl) / (6 * s.sigma);
  const cpu = (usl - s.mean) / (3 * s.sigma);
  const cpl = (s.mean - lsl) / (3 * s.sigma);
  const cpk = Math.min(cpu, cpl);
  const oos = vals.filter(v => v < lsl || v > usl).length;
  return {...s, cp, cpu, cpl, cpk, oos, ppm: oos / vals.length * 1_000_000};
}

function rolling(vals, lsl, usl, w) {
  const out = [];
  for (let i = 0; i <= vals.length - w; i++) out.push({start:i+1, end:i+w, ...cap(vals.slice(i,i+w), lsl, usl)});
  return out;
}

function patterns(vals, c, r) {
  const out = [];
  const a = stat(vals.slice(0, Math.floor(vals.length/2)));
  const b = stat(vals.slice(Math.floor(vals.length/2)));
  const shift = b.mean - a.mean;
  if (Math.abs(shift) > Math.max(0.25, r.sigma * 0.8)) out.push({type:"trend", level:"warn", text:`前后半段均值变化 ${f(shift)}，存在趋势漂移或过程中心迁移。`});
  if (r.cp - r.cpk > 0.25) out.push({type:"centering", level:"warn", text:`Cp 与 Cpk 差值 ${f(r.cp-r.cpk)}，过程能力主要受中心偏移影响。`});
  if (r.cpk < 1.33) out.push({type:"capability", level:"bad", text:`Cpk=${f(r.cpk)}，低于 1.33，建议触发工程分析或 FACA。`});
  else if (r.cpk < 1.67) out.push({type:"capability", level:"warn", text:`Cpk=${f(r.cpk)}，处于观察区间，建议确认波动来源。`});
  else out.push({type:"capability", level:"good", text:`Cpk=${f(r.cpk)}，当前过程能力良好。`});
  const burst = rows.filter(x => x.tag === "bubble_or_leak").length;
  if (burst > Math.max(2, vals.length * 0.01)) out.push({type:"burst", level:"bad", text:`识别到 ${burst} 个气泡/漏箔型低值冲击点，建议检查脱泡、过滤、管路高点积气和涂布阀动作稳定性。`});
  const roll = rolling(vals, c.lsl, c.usl, Math.min(30, Math.max(12, Math.floor(vals.length/8))));
  const weak = roll.filter(x => x.cpk < 1.33);
  if (weak.length) {
    const worst = weak.reduce((a,b)=>a.cpk<b.cpk?a:b);
    out.push({type:"rolling", level:"bad", text:`Rolling CPK 最差窗口为 #${worst.start}-#${worst.end}，Cpk=${f(worst.cpk)}。`});
  }
  return out;
}

function analyze() {
  if (!rows.length) return;
  let c;
  try { c = cfg(); } catch(e) { alert(e.message); return; }
  const vals = rows.map(x => x.value);
  const r = cap(vals, c.lsl, c.usl);
  const p = patterns(vals, c, r);
  $("meanCard").textContent = f(r.mean);
  $("sigmaCard").textContent = f(r.sigma);
  $("cpCard").textContent = f(r.cp);
  $("cpkCard").textContent = f(r.cpk);
  $("oosCard").textContent = `${r.oos}/${r.n}`;
  $("ppmCard").textContent = f(r.ppm,0);
  $("cpkHero").textContent = `Cpk ${f(r.cpk)}`;
  $("statusBadge").textContent = r.cpk < 1.33 ? "Action" : r.cpk < 1.67 ? "Watch" : "Stable";
  $("heroHint").textContent = r.cpk < 1.33 ? "建议触发工程分析" : r.cpk < 1.67 ? "建议持续观察" : "过程能力良好";
  $("diagnosis").innerHTML = p.map(x => `<div>${x.level === "bad" ? "●" : x.level === "warn" ? "◆" : "✓"} ${esc(x.text)}</div>`).join("");
  drawTrend(rows, r, c); drawHist(vals, r, c); drawTable(rows);
  lastReport = faca(r, p, c);
  $("facaBox").textContent = lastReport;
}

function sc(v,a,b,c,d){ return b===a ? (c+d)/2 : c + (v-a)/(b-a)*(d-c); }
function lineLimit(name, value, y, w, pad) { const yy = y(value); return `<line class="limit-line" x1="${pad.l}" y1="${yy}" x2="${w-pad.r}" y2="${yy}"></line><text class="chart-label" x="${w-78}" y="${yy-6}">${name}</text>`; }

function drawTrend(data, r, c) {
  const svg = $("trendChart"), w = 920, h = 320, pad = {l:56,r:24,t:22,b:42};
  const vals = data.map(x=>x.value), ymin = Math.min(c.lsl, ...vals) - r.sigma, ymax = Math.max(c.usl, ...vals) + r.sigma;
  const x = i => sc(i, 0, data.length-1, pad.l, w-pad.r), y = v => sc(v, ymin, ymax, h-pad.b, pad.t);
  const grid = Array.from({length:5}, (_,i)=>{ const yy=sc(i,0,4,h-pad.b,pad.t), val=sc(i,0,4,ymin,ymax); return `<line class="gridline" x1="${pad.l}" y1="${yy}" x2="${w-pad.r}" y2="${yy}"></line><text class="chart-label" x="10" y="${yy+4}">${f(val,2)}</text>`; }).join("");
  const path = data.map((p,i)=>`${i?"L":"M"} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  svg.innerHTML = `${grid}<line class="axis" x1="${pad.l}" y1="${h-pad.b}" x2="${w-pad.r}" y2="${h-pad.b}"></line><line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${h-pad.b}"></line>${lineLimit("USL",c.usl,y,w,pad)}${lineLimit("LSL",c.lsl,y,w,pad)}<line class="mean-line" x1="${pad.l}" y1="${y(r.mean)}" x2="${w-pad.r}" y2="${y(r.mean)}"></line><path class="chart-line" d="${path}"></path>${data.map((p,i)=>`<circle class="dot ${p.value<c.lsl||p.value>c.usl||p.tag!=="normal"?"bad":""}" cx="${x(i)}" cy="${y(p.value)}" r="${p.tag!=="normal"?3.8:2.2}"></circle>`).join("")}`;
}

function drawHist(vals, r, c) {
  const svg = $("histChart"), w = 920, h = 300, pad = {l:56,r:24,t:22,b:42}, bins = 24;
  const min = Math.min(c.lsl, ...vals) - r.sigma, max = Math.max(c.usl, ...vals) + r.sigma, step = (max-min)/bins;
  const counts = Array(bins).fill(0); vals.forEach(v => counts[clamp(Math.floor((v-min)/step),0,bins-1)]++);
  const mc = Math.max(...counts,1), x = v => sc(v,min,max,pad.l,w-pad.r), y = v => sc(v,0,mc,h-pad.b,pad.t);
  svg.innerHTML = `<line class="axis" x1="${pad.l}" y1="${h-pad.b}" x2="${w-pad.r}" y2="${h-pad.b}"></line><line class="axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${h-pad.b}"></line>${counts.map((ct,i)=>`<rect class="bar" x="${x(min+i*step)+1}" y="${y(ct)}" width="${Math.max(1,x(min+(i+1)*step)-x(min+i*step)-2)}" height="${h-pad.b-y(ct)}"></rect>`).join("")}<line class="limit-line" x1="${x(c.lsl)}" y1="${pad.t}" x2="${x(c.lsl)}" y2="${h-pad.b}"></line><line class="limit-line" x1="${x(c.usl)}" y1="${pad.t}" x2="${x(c.usl)}" y2="${h-pad.b}"></line><line class="mean-line" x1="${x(r.mean)}" y1="${pad.t}" x2="${x(r.mean)}" y2="${h-pad.b}"></line>`;
}

function drawTable(data) {
  $("dataTable").innerHTML = data.slice(0,160).map(r => `<tr><td>${r.idx}</td><td>${esc(r.time)}</td><td>${f(r.value,4)}</td><td>${esc(r.tag)}</td></tr>`).join("");
}

function suspect(patterns, r) {
  const t = new Set(patterns.map(x=>x.type));
  if (t.has("burst")) return "主要疑似方向：气泡/漏箔型瞬态冲击。机理上，管路积气、脱泡不足、过滤器排气不充分或涂布阀瞬态供料不足，会导致局部面密度向低侧突降。";
  if (t.has("trend")) return "主要疑似方向：过程趋势漂移。机理上，浆料粘度、温度补偿、供料压力或阀时序缓慢变化，会推动均值持续偏移。";
  if (r.cp - r.cpk > 0.25) return "主要疑似方向：过程中心偏移。当前均值靠近一侧规格线，需要优先校正目标中心。";
  return "主要疑似方向：普通波动偏大。建议拆分机台、班次、卷号、头尾位置，识别波动来源。";
}

function faca(r, p, c) {
  const abnormal = rows.filter(x => x.value<c.lsl || x.value>c.usl || x.tag!=="normal").length;
  return `# FACA 草稿：${c.metricName} 过程能力异常分析\n\n## 1. 问题描述\n检测项目：${c.metricName}\n样本数量：${r.n}\n规格范围：${f(c.lsl,2)} ~ ${f(c.usl,2)}\n过程均值：${f(r.mean)}\n过程 Sigma：${f(r.sigma)}\nCp：${f(r.cp)}\nCpk：${f(r.cpk)}\n超规数量：${r.oos}\n异常/冲击标记点数量：${abnormal}\n\n结论：${r.cpk<1.33?"当前过程能力不足，建议启动 FACA 或专项改善。":r.cpk<1.67?"当前过程能力处于观察区间，建议趋势确认与风险围堵。":"当前过程能力较好，建议持续监控。"}\n\n## 2. 影响评估\n- 若低值点与气泡、漏箔或供料瞬态不足相关，可能造成局部面密度不足。\n- 优先锁定 CPK 最差窗口、超规点前后 30 个样本及同卷号/同机台数据。\n- 若异常点已进入后工序，应结合 AOI、β-ray、CCD、分切/卷绕追溯结果确认隔离范围。\n\n## 3. 初步根因判断\n${suspect(p,r)}\n\n## 4. 临时围堵措施\n1. 冻结异常窗口对应卷料，按卷号、EA 序号、机台号进行追溯。\n2. 复核 β-ray/CCD 原始曲线，确认异常是连续漂移、单点冲击还是周期性波动。\n3. 点检供料泵、涂布阀、回流阀、过滤器压差、缓存罐真空保持状态。\n4. 对超规点前后样本进行复测，必要时执行开卷确认。\n\n## 5. 5Why 分析\n| Why | 分析 |\n| --- | --- |\n| 1 | Cpk 变差，因为过程 Sigma 扩大或均值向规格边界偏移。 |\n| 2 | Sigma 扩大/均值偏移，因为数据呈现 ${p.map(x=>x.type).join("、") || "暂未识别到明显模式"} 特征。 |\n| 3 | 该模式可能与供料压力波动、泵/阀磨损、气泡释放、过滤阻塞或温度补偿漂移有关。 |\n| 4 | 现有监控可能只关注单点超规，未对 Rolling CPK、均值漂移和异常冲击点联动预警。 |\n| 5 | 设备状态、过程窗口和数据预警阈值未形成闭环管理。 |\n\n## 6. 纠正措施\n| 措施 | 责任人 | 完成时间 | 状态 |\n| --- | --- | --- | --- |\n| 建立 Rolling CPK 预警规则，低于 1.33 时触发工程确认 | 工艺/质量 | 【待补充】 | Open |\n| 点检供料泵定子、阀动作一致性、过滤器压差和管路高点排气 | 设备 | 【待补充】 | Open |\n| 对异常窗口卷料进行隔离、复测和后工序追溯 | 质量 | 【待补充】 | Open |\n| 建立参数-缺陷-卷号关联表 | 生产/工艺 | 【待补充】 | Open |\n\n## 7. 效果验证\n- 连续 3 个班次或连续 3 卷验证。\n- 目标：Cpk ≥ 1.67，OOS = 0，Rolling CPK 无低于 1.33 窗口。\n- 保留原始检测数据、趋势图、直方图、异常点清单及措施执行记录。\n`;
}

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split(",").map(x => x.trim().toLowerCase());
  const timeIdx = headers.findIndex(x => ["time","datetime","date","时间"].includes(x));
  let valueIdx = headers.findIndex(x => ["value","data","measurement","面密度","膜长","数值"].includes(x));
  if (valueIdx < 0) valueIdx = headers.length > 1 ? 1 : 0;
  const out = [];
  for (let i=1;i<lines.length;i++) {
    const cells = lines[i].match(/("[^"]*"|[^,]+)/g) || [];
    const value = Number((cells[valueIdx] || "").replaceAll('"',""));
    if (Number.isFinite(value)) out.push({idx:out.length+1, time: timeIdx>=0 ? cells[timeIdx].replaceAll('"',"") : String(out.length+1), value, tag:"imported"});
  }
  if (!out.length) throw Error("没有解析到有效数值");
  return out;
}

function exportCsv() {
  if (!rows.length) return;
  const text = "idx,time,value,tag\n" + rows.map(r => `${r.idx},"${r.time}",${f(r.value,6)},${r.tag}`).join("\n");
  const url = URL.createObjectURL(new Blob([text], {type:"text/csv;charset=utf-8"}));
  const a = document.createElement("a"); a.href = url; a.download = "coating_cpk_lab_export.csv"; a.click(); URL.revokeObjectURL(url);
}

inputIds.forEach(id => I[id].addEventListener("input", sync));
$("generateBtn").addEventListener("click", generateData);
$("analyzeBtn").addEventListener("click", analyze);
$("exportBtn").addEventListener("click", exportCsv);
$("copyFacaBtn").addEventListener("click", () => navigator.clipboard.writeText(lastReport || ""));
$("fileInput").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  try { rows = parseCsv(await file.text()); I.sampleSize.value = rows.length; analyze(); } catch(err) { alert(err.message); }
});
sync();
generateData();
