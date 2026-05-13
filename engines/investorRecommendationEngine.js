function toNum(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 2) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function clamp(value, min, max) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function computeStrategicDipTarget({ spot, ema50, ema200, putWall, maxPain }) {
  const structuralFloors = [ema200, putWall, maxPain].filter((v) => Number.isFinite(v));
  if (structuralFloors.length) {
    return round(Math.max(...structuralFloors), 2);
  }
  if (Number.isFinite(ema200)) return round(ema200, 2);
  if (Number.isFinite(putWall)) return round(putWall, 2);
  if (Number.isFinite(ema50)) return round(ema50, 2);
  return null;
}

function horizonVerdict(data) {
  const {
    spot,
    ema8,
    ema50,
    ema200,
    rsi,
    gammaFlip,
    maxPain,
    putWall,
    analystTarget,
    yoyGrowth,
    pe,
    industryPe,
    strategicDipTarget
  } = data;

  let short = { verdict: 'HOLD', allocation: '0%', targetZone: 'Neutral' };
  if ((Number.isFinite(rsi) && rsi >= 70) || (Number.isFinite(spot) && Number.isFinite(gammaFlip) && spot < gammaFlip)) {
    short = {
      verdict: 'SELL',
      allocation: 'Reduce Tactical Units',
      targetZone: Number.isFinite(gammaFlip) ? `$${round(gammaFlip, 2)}` : 'Gamma Pivot'
    };
  } else if ((Number.isFinite(rsi) && rsi <= 35)
      || (Number.isFinite(spot) && Number.isFinite(gammaFlip) && spot > gammaFlip && Number.isFinite(ema8) && Number.isFinite(ema50) && ema8 > ema50)) {
    short = {
      verdict: 'BUY',
      allocation: 'Aggressive Trading Allocation',
      targetZone: Number.isFinite(spot) ? `$${round(spot, 2)}` : 'Current Zone'
    };
  }

  let medium = { verdict: 'HOLD', allocation: 'Maintain Position', targetZone: 'Fair Value' };
  const distanceToMaxPain = Number.isFinite(spot) && Number.isFinite(maxPain) && spot !== 0
    ? ((spot - maxPain) / spot) * 100
    : null;
  if ((Number.isFinite(spot) && Number.isFinite(analystTarget) && spot > analystTarget)
      || (Number.isFinite(distanceToMaxPain) && distanceToMaxPain > 15)) {
    const dip = [ema50, maxPain, putWall].filter((v) => Number.isFinite(v));
    const dipTarget = dip.length ? Math.max(...dip) : null;
    medium = {
      verdict: 'ACCUMULATE ON DIP',
      allocation: 'Wait for Pullback / Staged Entry',
      targetZone: Number.isFinite(dipTarget) ? `$${round(dipTarget, 2)}` : 'Support Zone'
    };
  } else if (Number.isFinite(spot) && Number.isFinite(analystTarget) && spot <= analystTarget * 0.9 && (!Number.isFinite(putWall) || spot > putWall)) {
    medium = {
      verdict: 'BUY',
      allocation: 'Core Accumulation',
      targetZone: Number.isFinite(maxPain) ? `$${round(maxPain, 2)}` : 'Value Zone'
    };
  }

  let long = { verdict: 'HOLD', allocation: 'Core Hold', targetZone: 'Baseline' };
  const fundamentallyElite = Number.isFinite(yoyGrowth) && Number.isFinite(pe) && Number.isFinite(industryPe)
    ? (yoyGrowth > 20 && pe <= industryPe * 1.25)
    : false;
  if (fundamentallyElite && Number.isFinite(spot) && Number.isFinite(ema200) && spot <= ema200 * 1.08) {
    long = {
      verdict: 'BUY',
      allocation: 'Heavy Overweight',
      targetZone: Number.isFinite(ema200) ? `$${round(ema200, 2)}` : 'Generational Floor'
    };
  } else if (fundamentallyElite && Number.isFinite(spot) && Number.isFinite(ema200) && spot > ema200 * 1.15) {
    long = {
      verdict: 'ACCUMULATE ON DIP',
      allocation: 'Dollar-Cost Average',
      targetZone: Number.isFinite(strategicDipTarget) ? `$${strategicDipTarget}` : (Number.isFinite(ema200) ? `$${round(ema200, 2)}` : 'Value Zone')
    };
  } else if (Number.isFinite(pe) && Number.isFinite(industryPe) && Number.isFinite(yoyGrowth) && pe > industryPe * 2 && yoyGrowth < 5) {
    long = {
      verdict: 'SELL',
      allocation: 'Structural Underweight',
      targetZone: 'Overvalued Zone'
    };
  }

  const summaryReason = `Short-term momentum reads ${short.verdict}, medium-term structure reads ${medium.verdict}, and long-term fundamentals read ${long.verdict}. This split reflects current momentum/flow vs valuation and growth durability.`;
  return { short, medium, long, summaryReason };
}

function pickOverallFromHorizon(horizon, timeline) {
  if (horizon === 'short') return `SHORT-TERM: ${timeline.short.verdict}`;
  if (horizon === 'medium') return `MEDIUM-TERM: ${timeline.medium.verdict}`;
  if (horizon === 'long') return `LONG-TERM: ${timeline.long.verdict}`;

  const longVerdict = timeline.long.verdict;
  const shortVerdict = timeline.short.verdict;
  if (longVerdict === 'BUY' && shortVerdict === 'SELL') return 'TACTICAL SPLIT (TRIM SHORT-TERM, BUY LONG-TERM)';
  if (longVerdict === 'SELL') return 'DEFENSIVE (LONG-TERM RISK)';
  if (longVerdict === 'BUY') return 'LONG-TERM BUY BIAS';
  return 'BALANCED HOLD';
}

export function buildInvestorRecommendationScorecard(input) {
  const horizonRaw = String(input?.horizon || 'all').toLowerCase();
  const horizon = ['short', 'medium', 'long', 'all'].includes(horizonRaw) ? horizonRaw : 'all';

  const spot = toNum(input?.spotPrice);
  const analystTarget = toNum(input?.streetTargetPrice);
  const ema8 = toNum(input?.ema8);
  const ema50 = toNum(input?.fiftyDayEma);
  const ema200 = toNum(input?.two00DayEma);
  const rsi = toNum(input?.rsi14);
  const putWall = toNum(input?.putWall);
  const gammaFlip = toNum(input?.gammaFlip);
  const maxPain = toNum(input?.maxPain);
  const pe = toNum(input?.peRatio);
  const industryPe = toNum(input?.industryPeAvg);
  const yoyGrowth = toNum(input?.yoyRevGrowth);

  const strategicDipTarget = computeStrategicDipTarget({
    spot,
    ema50,
    ema200,
    putWall,
    maxPain
  });

  const timeline = horizonVerdict({
    spot,
    ema8,
    ema50,
    ema200,
    rsi,
    gammaFlip,
    maxPain,
    putWall,
    analystTarget,
    yoyGrowth,
    pe,
    industryPe,
    strategicDipTarget
  });

  const longTermFloor = Number.isFinite(strategicDipTarget) ? round(strategicDipTarget, 2) : null;

  let mediumTermAnchor = Number.isFinite(ema50)
    ? round(ema50, 2)
    : (Number.isFinite(maxPain) ? round(maxPain, 2) : longTermFloor);
  if (Number.isFinite(mediumTermAnchor) && Number.isFinite(longTermFloor)) {
    mediumTermAnchor = round(Math.max(mediumTermAnchor, longTermFloor), 2);
  }
  if (Number.isFinite(mediumTermAnchor) && Number.isFinite(spot)) {
    mediumTermAnchor = round(clamp(mediumTermAnchor, Number.isFinite(longTermFloor) ? longTermFloor : mediumTermAnchor, spot), 2);
  }

  const shortBaseTarget = (() => {
    if (Number.isFinite(ema8) && Number.isFinite(spot) && ema8 < spot) return ema8;
    if (Number.isFinite(spot)) return spot * 0.93;
    return null;
  })();
  let shortTermTarget = Number.isFinite(shortBaseTarget) ? round(shortBaseTarget, 2) : null;
  if (Number.isFinite(shortTermTarget) && Number.isFinite(spot)) {
    const shortFloor = Number.isFinite(mediumTermAnchor)
      ? mediumTermAnchor
      : (Number.isFinite(longTermFloor) ? longTermFloor : shortTermTarget);
    shortTermTarget = round(clamp(shortTermTarget, shortFloor, spot), 2);
  }

  const strategicDipZone = Number.isFinite(longTermFloor) ? `$${longTermFloor.toFixed(2)}` : null;
  if (timeline.long?.verdict === 'HOLD') {
    timeline.long = {
      ...timeline.long,
      targetZone: 'Baseline / Current'
    };
  } else if (strategicDipZone) {
    timeline.long = {
      ...timeline.long,
      targetZone: strategicDipZone
    };
  }

  if ((timeline.medium?.verdict === 'BUY' || timeline.medium?.verdict === 'ACCUMULATE ON DIP') && Number.isFinite(mediumTermAnchor)) {
    timeline.medium = {
      ...timeline.medium,
      targetZone: `$${mediumTermAnchor.toFixed(2)}`
    };
  }

  if (timeline.short?.verdict === 'SELL' && Number.isFinite(shortTermTarget)) {
    timeline.short = {
      ...timeline.short,
      targetZone: `$${shortTermTarget.toFixed(2)}`
    };
  }

  const overallVerdict = pickOverallFromHorizon(horizon, timeline);
  const reason = horizon === 'all'
    ? timeline.summaryReason
    : (horizon === 'short' ? `Short-term ${timeline.short.verdict}: ${timeline.short.allocation}. Target zone ${timeline.short.targetZone}.`
      : horizon === 'medium' ? `Medium-term ${timeline.medium.verdict}: ${timeline.medium.allocation}. Target zone ${timeline.medium.targetZone}.`
        : `Long-term ${timeline.long.verdict}: ${timeline.long.allocation}. Target zone ${timeline.long.targetZone}.`);

  const pctToTarget = (Number.isFinite(spot) && Number.isFinite(analystTarget) && spot !== 0)
    ? round(((analystTarget - spot) / spot) * 100, 1)
    : null;

  return {
    track: 'INVESTOR',
    horizon,
    overallVerdict,
    reason,
    metrics: {
      spotPrice: round(spot, 2),
      targetPrice: round(analystTarget, 2),
      strategicDipTarget,
      peRatio: round(pe, 2),
      industryPe: round(industryPe, 2),
      yoyRevenueGrowthPct: round(yoyGrowth, 1),
      rsi14: round(rsi, 1),
      shortTermTarget,
      mediumTermAnchor,
      ema50: round(ema50, 2),
      ema200: round(ema200, 2),
      putWall: round(putWall, 2),
      gammaFlip: round(gammaFlip, 2),
      maxPain: round(maxPain, 2),
      pctToTarget
    },
    timeline: {
      short: timeline.short,
      medium: timeline.medium,
      long: timeline.long
    },
    portfolioGuidance: {
      currentHolders: horizon === 'short' ? timeline.short.allocation : timeline.long.allocation,
      sideLineCapital: strategicDipZone ? `Wait for pullback near ${strategicDipZone}` : 'Use staged entries around technical support'
    }
  };
}
