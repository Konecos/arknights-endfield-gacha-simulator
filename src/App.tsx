import { useState, useCallback } from 'react';
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';
import { Play, RotateCcw, Info, TrendingUp, AlertCircle, Settings, ChevronDown, ChevronUp } from 'lucide-react';

// --- 类型定义 ---
type SimulationConfig = {
  baseRate6: number;      // 6星基础概率 (%)
  baseRate5: number;      // 5星基础概率 (%)
  pityStart6: number;     // 6星概率提升起始抽数
  pityInc6: number;       // 6星概率提升幅度 (%)
  hardPity6: number;      // 6星硬保底抽数
  hardPity5: number;      // 5星硬保底抽数
  targetGuarantee: number;// 特许必得保底 (如120)
  targetTotalPulls: number; // 模拟总抽数
};

type SimulationResult = {
  distribution: {
    pulls: number;
    count: number;
    percent: string;
    cumulativePercent: number;
  }[];
  totalSimulations: number;
  totalPullsConsumed: number;
  averagePulls: number;
  medianPulls: number;
  pity120Triggered: number;
  maxPulls: number;
};

// --- 默认配置 (依据特许寻访规则) ---
const DEFAULT_CONFIG: SimulationConfig = {
  baseRate6: 0.8,
  baseRate5: 8.0,
  pityStart6: 65,     // 65次未出后，下一次开始提升
  pityInc6: 5.0,      // 每次提升5%
  hardPity6: 80,      // 0.8概率下，理论上80抽硬保底逻辑（实际第79抽概率已达70%+，第80抽通常通过概率修正必定获得）
  hardPity5: 10,
  targetGuarantee: 120, // 特许寻访120必得UP
  targetTotalPulls: 500000, // 50万抽
};

// --- 模拟核心逻辑 ---
const simulateOneSession = (cfg: SimulationConfig): { pulls: number; triggeredGuarantee: boolean } => {
  let pulls = 0;
  let pityCounter6 = 0; // 距离上一次6星的抽数
  let pityCounter5 = 0; // 距离上一次5星的抽数
  let gotTarget = false;

  const baseRate6 = cfg.baseRate6 / 100;
  const baseRate5 = cfg.baseRate5 / 100;
  const pityInc6 = cfg.pityInc6 / 100;

  while (!gotTarget) {
    pulls++;
    pityCounter6++;
    pityCounter5++;

    // 1. 检查特许120抽必得保底
    // 注意：特许规则中，前120次必定获得。如果在模拟单次出货分布时，
    // 我们假设每次都是为了抽到UP，如果抽到120还没出，根据规则强制获得。
    if (cfg.targetGuarantee > 0 && pulls === cfg.targetGuarantee) {
      return { pulls: pulls, triggeredGuarantee: true };
    }

    // 2. 计算当前6星概率
    let currentRate6 = baseRate6;
    // 规则：若连续65次没有获取，接下来(第66次)开始提升
    if (pityCounter6 > cfg.pityStart6) {
      currentRate6 += (pityCounter6 - cfg.pityStart6) * pityInc6;
    }
    // 限制概率上限为100%
    if (currentRate6 > 1.0) currentRate6 = 1.0;

    // 硬保底（虽然数学上概率提升会覆盖，但设置硬上限更安全）
    if (pityCounter6 >= cfg.hardPity6) {
      currentRate6 = 1.0;
    }

    // 3. 随机判定
    const rng = Math.random();

    // --- 判定6星 ---
    if (rng < currentRate6) {
      pityCounter6 = 0; // 重置6星保底计数
      // 6星不重置5星保底计数(根据方舟机制，两者独立，但也有说法高星会挤掉低星判定，此处简化为独立)
      // 但如果判定出6星，这次抽卡就结束了，不进行5星判定

      // 判定是否为UP (50%概率)
      if (Math.random() < 0.5) {
        gotTarget = true;
      }
      // 如果歪了(非UP 6星)，继续抽，pityCounter6已归零
      continue;
    }

    // --- 判定5星 (仅用于重置5星保底，不影响6星出货逻辑，除非有"高星挤占"机制，此处暂按独立计算) ---
    // 实际上模拟只关心什么时候出6星UP，5星逻辑主要影响是否触发5星保底，对6星分布影响极小
    let currentRate5 = baseRate5;
    // 5星保底逻辑：如果前9次没出，第10次必出5星或以上（这里只处理5星，因为上面6星没中）
    if (pityCounter5 >= cfg.hardPity5) {
      currentRate5 = 1.0; // 这里的1.0是相对于剩下的概率空间的，简单处理为必中
    }

    // 在没有中6星的情况下，判定是否中5星
    // 注意：rng 已经在 [currentRate6, 1.0) 区间
    // 标准概率模型中，各星级是独立的区间划分。
    // [0, rate6): 6星
    // [rate6, rate6 + rate5): 5星
    if (rng < currentRate6 + currentRate5) {
      pityCounter5 = 0;
    }
  }

  return { pulls, triggeredGuarantee: false };
};

export default function App() {
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<SimulationConfig>(DEFAULT_CONFIG);
  const [showSettings, setShowSettings] = useState(true);
  const [result, setResult] = useState<SimulationResult | null>(null);

  const handleConfigChange = (key: keyof SimulationConfig, value: string) => {
    const numVal = Number(value);
    setConfig(prev => ({
      ...prev,
      [key]: isNaN(numVal) ? 0 : numVal
    }));
  };

  const runSimulation = useCallback(async () => {
    setLoading(true);
    // 使用 setTimeout 让 React 先渲染 loading 状态，避免主线程卡死导致 UI 无响应
    setTimeout(() => {
      let totalPulls = 0;
      let sessionCount = 0;
      const counts: Record<number, number> = {};
      let pullsArray: number[] = [];
      let triggeredGuaranteeCount = 0;

      // 运行模拟直到消耗完指定的总抽数
      while (totalPulls < config.targetTotalPulls) {
        const { pulls, triggeredGuarantee } = simulateOneSession(config);
        totalPulls += pulls;
        sessionCount++;

        counts[pulls] = (counts[pulls] || 0) + 1;
        pullsArray.push(pulls);
        if (triggeredGuarantee) triggeredGuaranteeCount++;
      }

      const maxPull = Math.max(...Object.keys(counts).map(Number));

      const distribution = [];
      const chartMax = Math.max(maxPull, config.targetGuarantee);
      let runningCount = 0;

      for (let i = 1; i <= chartMax; i++) {
        const count = counts[i] || 0;
        runningCount += count;

        if (count > 0 || i <= config.targetGuarantee || i % 10 === 0) { // 稀疏数据也保留关键点
             distribution.push({
              pulls: i,
              count: count,
              percent: (count / sessionCount * 100).toFixed(3), // 提高精度
              cumulativePercent: Number((runningCount / sessionCount * 100).toFixed(2))
            });
        }
      }

      // 补全 gaps 以便 AreaChart 显示平滑 (可选，recharts 可以处理 gaps，但补全更好)
      // 这里简化处理，直接使用上面的稀疏数组，recharts type="monotone" 会自动连接

      pullsArray.sort((a, b) => a - b);
      const median = pullsArray[Math.floor(pullsArray.length / 2)];

      setResult({
        distribution,
        totalSimulations: sessionCount,
        totalPullsConsumed: totalPulls,
        averagePulls: totalPulls / sessionCount,
        medianPulls: median,
        pity120Triggered: triggeredGuaranteeCount,
        maxPulls: maxPull
      });

      setLoading(false);
    }, 100);
  }, [config]);

  // 自定义 Tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="bg-white p-3 border border-gray-200 shadow-lg rounded-md text-sm z-50 opacity-95">
          <p className="font-bold text-gray-800">抽数: {label}</p>
          <div className="space-y-1 mt-1">
            <p className="text-blue-600">单次概率: {data.percent}%</p>
            <p className="text-emerald-600 font-semibold">累积概率: {data.cumulativePercent}%</p>
            <p className="text-gray-400 text-xs">出现次数: {data.count}</p>
          </div>
          {Number(label) === config.targetGuarantee && (
            <p className="text-red-500 font-bold mt-1 border-t pt-1">必得保底触发点</p>
          )}
        </div>
      );
    }
    return null;
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8 font-sans text-slate-800">
      <div className="max-w-6xl mx-auto space-y-6">

        {/* Header */}
        <header className="bg-white p-6 rounded-xl shadow-sm border border-slate-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
              特许寻访模拟器
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              基于模拟抽卡样本的概率分布可视化
            </p>
          </div>
          <button
            onClick={runSimulation}
            disabled={loading}
            className={`flex items-center gap-2 px-6 py-3 rounded-lg font-semibold transition-all shadow-md ${
              loading 
                ? 'bg-slate-300 text-slate-500 cursor-not-allowed' 
                : 'bg-blue-600 text-white hover:bg-blue-700 hover:shadow-lg active:scale-95'
            }`}
          >
            {loading ? (
              <>
                <RotateCcw className="animate-spin w-5 h-5" />
                计算中...
              </>
            ) : (
              <>
                <Play className="w-5 h-5" />
                开始模拟
              </>
            )}
          </button>
        </header>

        {/* Configuration Panel */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="w-full flex items-center justify-between p-4 bg-slate-50 hover:bg-slate-100 transition-colors"
          >
            <div className="flex items-center gap-2 font-semibold text-slate-700">
              <Settings className="w-5 h-5" />
              <span>参数设置</span>
            </div>
            {showSettings ? <ChevronUp className="w-5 h-5 text-slate-400" /> : <ChevronDown className="w-5 h-5 text-slate-400" />}
          </button>

          {showSettings && (
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 animate-in slide-in-from-top-2 fade-in duration-300">
              <div className="space-y-4 border-r border-slate-100 pr-4 last:border-0">
                <h3 className="text-sm font-bold text-indigo-600 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" /> 6星概率配置
                </h3>
                <InputGroup label="基础概率 (%)" value={config.baseRate6} onChange={(v) => handleConfigChange('baseRate6', v)} step={0.1} />
                <InputGroup label="概率提升起始 (抽)" value={config.pityStart6} onChange={(v) => handleConfigChange('pityStart6', v)} />
                <InputGroup label="每抽提升幅度 (%)" value={config.pityInc6} onChange={(v) => handleConfigChange('pityInc6', v)} step={0.1} />
              </div>

              <div className="space-y-4 border-r border-slate-100 pr-4 last:border-0">
                <h3 className="text-sm font-bold text-purple-600 flex items-center gap-2">
                  <Info className="w-4 h-4" /> 5星/其他配置
                </h3>
                <InputGroup label="5星基础概率 (%)" value={config.baseRate5} onChange={(v) => handleConfigChange('baseRate5', v)} step={0.1} />
                <InputGroup label="6星硬保底 (抽)" value={config.hardPity6} onChange={(v) => handleConfigChange('hardPity6', v)} tooltip="理论硬保底，通常概率提升已提前出货" />
              </div>

              <div className="space-y-4 border-r border-slate-100 pr-4 last:border-0">
                <h3 className="text-sm font-bold text-amber-600 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" /> 特殊规则
                </h3>
                <InputGroup label="特许必得保底 (抽)" value={config.targetGuarantee} onChange={(v) => handleConfigChange('targetGuarantee', v)} tooltip="每个特许池仅生效一次" />
              </div>

              <div className="space-y-4">
                <h3 className="text-sm font-bold text-slate-600 flex items-center gap-2">
                  <RotateCcw className="w-4 h-4" /> 模拟规模
                </h3>
                <InputGroup label="模拟总抽数上限" value={config.targetTotalPulls} onChange={(v) => handleConfigChange('targetTotalPulls', v)} step={10000} />
              </div>
            </div>
          )}
        </div>

        {/* Results Area */}
        {result ? (
          <div className="space-y-6 animate-in fade-in duration-500">
            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard label="获取UP总次数" value={result.totalSimulations.toLocaleString()} />
              <StatCard label="消耗总抽数" value={(result.totalPullsConsumed / 10000).toFixed(1) + '万'} />
              <StatCard label="平均出货抽数" value={result.averagePulls.toFixed(2)} highlight />
              <StatCard
                label={`${config.targetGuarantee}抽吃满保底率`}
                value={((result.pity120Triggered / result.totalSimulations) * 100).toFixed(2) + '%'}
                color="text-red-500"
              />
            </div>

            {/* Chart 1: Distribution Bar Chart */}
            <div className="bg-white p-6 rounded-xl shadow-md border border-slate-100 h-[450px]">
              <h3 className="text-lg font-bold text-slate-800 mb-4">出货抽数分布 (概率密度)</h3>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={result.distribution} margin={{ top: 5, right: 30, left: 20, bottom: 40 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis
                    dataKey="pulls"
                    label={{ value: '所需抽数', position: 'insideBottom', offset: -10 }}
                    tick={{fontSize: 12}}
                    type="number"
                    domain={[0, 'dataMax']}
                    ticks={Array.from({length: Math.ceil(result.maxPulls / 10) + 1}, (_, i) => i * 10).filter(n => n <= result.maxPulls)}
                  />
                  <YAxis
                    label={{ value: '出现次数', angle: -90, position: 'insideLeft' }}
                    tick={{fontSize: 12}}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{fill: 'transparent'}} />
                  {config.targetGuarantee > 0 && (
                    <ReferenceLine x={config.targetGuarantee} stroke="#ef4444" strokeDasharray="3 3" label={{ position: 'top', value: '必得线', fill: '#ef4444', fontSize: 12 }} />
                  )}
                  <ReferenceLine x={result.averagePulls} stroke="#3b82f6" strokeDasharray="3 3" label={{ position: 'top', value: `平均: ${result.averagePulls.toFixed(1)}`, fill: '#3b82f6', fontSize: 12 }} />
                  <Bar dataKey="count" name="出现次数" barSize={Math.max(2, 600/result.distribution.length)}>
                    {result.distribution.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={
                          (config.targetGuarantee > 0 && entry.pulls === config.targetGuarantee) ? '#ef4444' :
                          entry.pulls > config.pityStart6 ? '#818cf8' : '#cbd5e1'
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Chart 2: Cumulative Probability Area Chart */}
            <div className="bg-white p-6 rounded-xl shadow-md border border-slate-100 h-[450px]">
              <h3 className="text-lg font-bold text-slate-800 mb-4">累积出货概率 (CDF)</h3>
              <p className="text-xs text-slate-400 -mt-3 mb-4">表示在X抽以内(含X抽)获得UP干员的总概率</p>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={result.distribution} margin={{ top: 5, right: 30, left: 20, bottom: 40 }}>
                  <defs>
                    <linearGradient id="colorCumulative" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.8}/>
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.1}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                  <XAxis
                    dataKey="pulls"
                    label={{ value: '投入抽数', position: 'insideBottom', offset: -10 }}
                    tick={{fontSize: 12}}
                    type="number"
                    domain={[0, 'dataMax']}
                    ticks={Array.from({length: Math.ceil(result.maxPulls / 10) + 1}, (_, i) => i * 10).filter(n => n <= result.maxPulls)}
                  />
                  <YAxis
                    label={{ value: '累积概率 (%)', angle: -90, position: 'insideLeft' }}
                    domain={[0, 100]}
                    tick={{fontSize: 12}}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine y={50} stroke="#f59e0b" strokeDasharray="3 3" label={{ position: 'insideRight', value: '50%', fill: '#f59e0b', fontSize: 12 }} />
                  <ReferenceLine y={90} stroke="#f59e0b" strokeDasharray="3 3" label={{ position: 'insideRight', value: '90%', fill: '#f59e0b', fontSize: 12 }} />
                  <Area
                    type="monotone"
                    dataKey="cumulativePercent"
                    stroke="#10b981"
                    fillOpacity={1}
                    fill="url(#colorCumulative)"
                    name="累积概率"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Analysis Text */}
            <div className="bg-slate-50 p-6 rounded-xl border border-slate-200 text-sm text-slate-700 leading-relaxed">
              <h4 className="font-bold text-slate-900 mb-2">数据分析</h4>
              <p>
                在本次模拟中（共计获取UP角色 {result.totalSimulations.toLocaleString()} 次）：
              </p>
              <ul className="list-disc list-inside mt-2 space-y-1">
                <li>
                  <span className="font-bold">平均期望：</span>需要 <span className="font-bold text-blue-600">{result.averagePulls.toFixed(1)}</span> 抽即可获得UP干员。
                </li>
                <li>
                  <span className="font-bold">中位数：</span><span className="font-bold text-blue-600">{result.medianPulls}</span> 抽。这意味着有一半的人在这个抽数内已经出货。
                </li>
                {config.targetGuarantee > 0 && (
                  <li>
                    <span className="font-bold">低保触发：</span>约 <span className="font-bold text-red-600">{((result.pity120Triggered / result.totalSimulations) * 100).toFixed(2)}%</span> 的倒霉蛋需要吃满 {config.targetGuarantee} 抽保底。
                  </li>
                )}
                <li>
                  <span className="font-bold">高概率区间：</span>
                  要达到 50% 的稳妥概率，需准备 <span className="font-bold text-emerald-600">{result.distribution.find(d => d.cumulativePercent >= 50)?.pulls}</span> 抽；
                  要达到 90% 的稳妥概率，需准备 <span className="font-bold text-emerald-600">{result.distribution.find(d => d.cumulativePercent >= 90)?.pulls}</span> 抽。
                </li>
              </ul>
            </div>
          </div>
        ) : (
          <div className="h-64 flex flex-col items-center justify-center text-slate-400 border-2 border-dashed border-slate-200 rounded-xl">
            <Play className="w-12 h-12 mb-4 opacity-20" />
            <p>点击上方“开始模拟”以生成抽卡数据</p>
          </div>
        )}
      </div>
    </div>
  );
}

function InputGroup({ label, value, onChange, step = 1, tooltip }: { label: string, value: number, onChange: (v: string) => void, step?: number, tooltip?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-slate-500 flex justify-between">
        {label}
        {tooltip && <span className="text-slate-300 ml-1 cursor-help" title={tooltip}>(?)</span>}
      </label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        step={step}
        className="w-full px-3 py-2 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
      />
    </div>
  );
}

function StatCard({ label, value, highlight = false, color = "text-slate-800" }: { label: string, value: string, highlight?: boolean, color?: string }) {
  return (
    <div className={`bg-white p-4 rounded-lg border shadow-sm flex flex-col items-center text-center transition-all ${highlight ? 'border-blue-200 ring-2 ring-blue-50 shadow-md' : 'border-slate-100'}`}>
      <span className="text-xs text-slate-500 uppercase tracking-wider mb-1">{label}</span>
      <span className={`text-xl md:text-2xl font-bold ${color}`}>{value}</span>
    </div>
  );
}
