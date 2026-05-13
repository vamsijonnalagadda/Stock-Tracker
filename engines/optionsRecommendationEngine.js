import { generateNarrativeReason } from './narrativeGenerator.js';

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

function calculateIVRank(currentIV, historicalIVs) {
  const current = toNum(currentIV);
  const hist = Array.isArray(historicalIVs)
    ? historicalIVs.map(toNum).filter((v) => Number.isFinite(v))
    : [];
  if (!Number.isFinite(current) || hist.length === 0) return null;
  const minIV = Math.min(...hist);
  const maxIV = Math.max(...hist);
  if (!Number.isFinite(minIV) || !Number.isFinite(maxIV)) return null;
  if (maxIV === minIV) return 50;
  const rank = ((current - minIV) / (maxIV - minIV)) * 100;
  return Math.max(0, Math.min(100, round(rank, 1)));
}

function calculateMaxPain(chain) {
  const strikes = Array.from(new Set(chain.map((c) => toNum(c.strike)).filter((v) => Number.isFinite(v)))).sort((a, b) => a - b);
  if (strikes.length === 0) return null;

  let bestStrike = strikes[0];
  let minPain = Number.POSITIVE_INFINITY;

  for (const testStrike of strikes) {
    let pain = 0;
    for (const contract of chain) {
      const strike = toNum(contract.strike);
      const oi = Math.max(0, toNum(contract.openInterest) || 0);
      if (!Number.isFinite(strike) || oi <= 0) continue;
      if (String(contract.type).toLowerCase() === 'call') {
        pain += Math.max(0, testStrike - strike) * oi;
      } else {
        pain += Math.max(0, strike - testStrike) * oi;
      }
    }
    if (pain < minPain) {
      minPain = pain;
      bestStrike = testStrike;
    }
  }

  return round(bestStrike, 2);
}

function findWalls(chain, spotPrice) {
  const spot = toNum(spotPrice);
  let bestCall = null;
  let bestPut = null;

  for (const c of chain) {
    const strike = toNum(c.strike);
    const oi = Math.max(0, toNum(c.openInterest) || 0);
    if (!Number.isFinite(strike)) continue;

    if (String(c.type).toLowerCase() === 'call') {
      // Call Wall must be at or above spot (true overhead ceiling)
      if (Number.isFinite(spot) && strike < spot) continue;
      if (!bestCall || oi > bestCall.oi) bestCall = { strike, oi };
    } else {
      // Put Wall must be at or below spot (true downside floor)
      if (Number.isFinite(spot) && strike > spot) continue;
      if (!bestPut || oi > bestPut.oi) bestPut = { strike, oi };
    }
  }

  return {
    callWall: bestCall ? round(bestCall.strike, 2) : null,
    putWall: bestPut ? round(bestPut.strike, 2) : null
  };
}

function estimateGammaFlip(chain, spotPrice) {
  const spot = toNum(spotPrice);

  // Filter to ±25% of spot to eliminate deep OTM noise that distorts the zero-gamma crossing.
  const filtered = Number.isFinite(spot) && spot > 0
    ? chain.filter((c) => {
        const strike = toNum(c.strike);
        return Number.isFinite(strike) && strike >= spot * 0.75 && strike <= spot * 1.25;
      })
    : chain;

  const strikes = Array.from(new Set(filtered.map((c) => toNum(c.strike)).filter((v) => Number.isFinite(v)))).sort((a, b) => a - b);
  if (strikes.length === 0) return spot;

  const strikeNetMap = new Map();
  for (const c of filtered) {
    const strike = toNum(c.strike);
    if (!Number.isFinite(strike)) continue;
    const iv = Math.max(0.01, toNum(c.impliedVolatility) || 0.25);
    const oi = Math.max(0, toNum(c.openInterest) || 0);
    const perContractWeight = oi * iv;
    const type = String(c.type).toLowerCase();
    const signed = type === 'call' ? perContractWeight : -perContractWeight;
    strikeNetMap.set(strike, (strikeNetMap.get(strike) || 0) + signed);
  }

  const points = strikes.map((s) => ({ strike: s, net: strikeNetMap.get(s) || 0 }));
  let previous = points[0];
  for (let i = 1; i < points.length; i += 1) {
    const current = points[i];
    if ((previous.net <= 0 && current.net >= 0) || (previous.net >= 0 && current.net <= 0)) {
      return round((previous.strike + current.strike) / 2, 2);
    }
    previous = current;
  }

  if (Number.isFinite(spot)) {
    const closest = points
      .slice()
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
    return round(closest.strike, 2);
  }

  return round(points[Math.floor(points.length / 2)]?.strike, 2);
}

function rollingRealizedVolatility(closes, lookback = 20) {
  const vals = Array.isArray(closes) ? closes.map(toNum).filter((v) => Number.isFinite(v) && v > 0) : [];
  if (vals.length < lookback + 1) return [];

  const returns = [];
  for (let i = 1; i < vals.length; i += 1) {
    returns.push(Math.log(vals[i] / vals[i - 1]));
  }

  const out = [];
  for (let i = lookback; i <= returns.length; i += 1) {
    const window = returns.slice(i - lookback, i);
    const mean = window.reduce((sum, v) => sum + v, 0) / window.length;
    const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / window.length;
    const dailyStd = Math.sqrt(variance);
    out.push(dailyStd * Math.sqrt(252));
  }
  return out.filter((v) => Number.isFinite(v));
}

function clampScore(v) {
  if (!Number.isFinite(v)) return 50;
  return Math.max(0, Math.min(100, round(v, 0)));
}

function percentDistance(a, b) {
  const x = toNum(a);
  const y = toNum(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x === 0) return null;
  return Math.abs((x - y) / x) * 100;
}

function pinningDescription(spotPrice, maxPain) {
  const dist = percentDistance(spotPrice, maxPain);
  const pain = toNum(maxPain);
  if (!Number.isFinite(dist) || !Number.isFinite(pain)) return 'has no reliable max-pain anchor due to incomplete chain context';
  if (dist <= 2.5) return `is tightly pinned near Max Pain ($${round(pain, 2)})`;
  if (dist <= 7) return `is drifting within a normal deviation of Max Pain ($${round(pain, 2)})`;
  return `is drastically disconnected from Max Pain ($${round(pain, 2)}) by ${round(dist, 1)}%`;
}

function structuralDislocationState({ spotPrice, maxPain, callWall, putWall }) {
  const spot = toNum(spotPrice);
  const pain = toNum(maxPain);
  const cWall = toNum(callWall);
  const pWall = toNum(putWall);

  const distanceToPainPct = percentDistance(spot, pain);
  const spanPct = Number.isFinite(spot) && Number.isFinite(cWall) && Number.isFinite(pWall) && spot !== 0
    ? ((cWall - pWall) / spot) * 100
    : null;
  const aboveCallWallPct = Number.isFinite(spot) && Number.isFinite(cWall) && spot !== 0
    ? ((spot - cWall) / spot) * 100
    : null;
  const belowPutWallPct = Number.isFinite(spot) && Number.isFinite(pWall) && spot !== 0
    ? ((pWall - spot) / spot) * 100
    : null;
  const callWallProximityPct = Number.isFinite(spot) && Number.isFinite(cWall) && spot !== 0
    ? ((cWall - spot) / spot) * 100
    : null;
  const putWallProximityPct = Number.isFinite(spot) && Number.isFinite(pWall) && spot !== 0
    ? ((spot - pWall) / spot) * 100
    : null;

  const isDislocated = (Number.isFinite(distanceToPainPct) && distanceToPainPct > 15)
    || (Number.isFinite(spanPct) && spanPct > 30)
    || (Number.isFinite(aboveCallWallPct) && aboveCallWallPct > 0)
    || (Number.isFinite(belowPutWallPct) && belowPutWallPct > 0)
    || (Number.isFinite(callWallProximityPct) && callWallProximityPct < 1)
    || (Number.isFinite(putWallProximityPct) && putWallProximityPct < 1);

  return {
    isDislocated,
    distanceToPainPct: round(distanceToPainPct, 2),
    spanPct: round(spanPct, 2)
  };
}

function triadVerdict({ spotPrice, gammaFlip, maxPain, callWall, putWall, flow }) {
  const spot = toNum(spotPrice);
  const flip = toNum(gammaFlip);
  const pain = toNum(maxPain);
  const cWall = toNum(callWall);
  const pWall = toNum(putWall);

  let bull = 0;
  let bear = 0;

  if (Number.isFinite(spot) && Number.isFinite(flip)) {
    if (spot >= flip) bull += 1;
    else bear += 1;
  }

  if (Number.isFinite(spot) && Number.isFinite(pain)) {
    if (spot <= pain) bull += 1;
    else bear += 1;
  }

  if (Number.isFinite(cWall) && Number.isFinite(spot) && cWall > spot) bull += 0.5;
  if (Number.isFinite(pWall) && Number.isFinite(spot) && pWall < spot) bear += 0.5;

  if (flow.callPutVolumeRatio != null) {
    if (flow.callPutVolumeRatio > 1.15) bull += 1;
    if (flow.callPutVolumeRatio < 0.85) bear += 1;
  }

  if (flow.netVolumeBias != null) {
    if (flow.netVolumeBias > 0) bull += 0.5;
    if (flow.netVolumeBias < 0) bear += 0.5;
  }

  // When spot is tightly pinned between key market-maker gravity levels,
  // directional triad should defer to a neutral/range regime.
  const pinnedToPain = Number.isFinite(spot) && Number.isFinite(pain) && spot !== 0
    ? Math.abs((spot - pain) / spot) * 100 <= 2
    : false;
  const pinnedToFlip = Number.isFinite(spot) && Number.isFinite(flip) && spot !== 0
    ? Math.abs((spot - flip) / spot) * 100 <= 2
    : false;
  if (pinnedToPain && pinnedToFlip) {
    return { verdict: 'Neutral', confidence: 78 };
  }

  const edge = Math.abs(bull - bear);
  const confidence = clampScore(50 + edge * 20);
  if (bull - bear >= 0.75) return { verdict: 'Bullish', confidence };
  if (bear - bull >= 0.75) return { verdict: 'Bearish', confidence };
  return { verdict: 'Neutral', confidence };
}

function isSpotNearMaxPain(spotPrice, maxPain, cushionPercent = 5) {
  const spot = toNum(spotPrice);
  const pain = toNum(maxPain);
  if (!Number.isFinite(spot) || !Number.isFinite(pain) || spot === 0) return false;
  const distancePct = Math.abs((spot - pain) / spot) * 100;
  return distancePct <= cushionPercent;
}

function advancedVerdict({ spotPrice, gammaFlip, maxPain, callWall, putWall, flow, ivRank, velocityScore, regimeScore }) {
  const spot = toNum(spotPrice);
  const flip = toNum(gammaFlip);
  const pain = toNum(maxPain);
  const cWall = toNum(callWall);
  const pWall = toNum(putWall);
  const ratio = toNum(flow?.callPutVolumeRatio);
  const iv = toNum(ivRank);
  const vel = toNum(velocityScore);
  const regime = toNum(regimeScore);

  let overallVerdict = 'NEUTRAL (IRON CONDORS)';
  let verdictReason = '';

  const dislocation = structuralDislocationState({ spotPrice, maxPain, callWall, putWall });
  const pinText = pinningDescription(spot, pain);

  // Detect regime direction: bullish if spot above flip + strong velocity/regime
  const isBullishRegime = Number.isFinite(spot) && Number.isFinite(flip) && spot > flip + (Math.abs(flip) * 0.05) && vel > 70 && regime > 60;
  const isBearishRegime = Number.isFinite(spot) && Number.isFinite(flip) && spot < flip - (Math.abs(flip) * 0.05) && vel < 40 && regime < 40;
  const isNeutral = isSpotNearMaxPain(spot, pain, 5)
    && !dislocation.isDislocated
    && !isBullishRegime
    && !isBearishRegime;

  // Hard guardrail: when spot is structurally disconnected from max-pain/walls,
  // force strategy away from neutral premium collection.
  if (dislocation.isDislocated) {
    const tiltBullish = (Number.isFinite(spot) && Number.isFinite(flip) && spot >= flip)
      || (Number.isFinite(ratio) && ratio >= 1);
    if (tiltBullish) {
      overallVerdict = iv != null && iv > 65 ? 'BULLISH (SELL PUT SPREADS)' : 'BULLISH (BUY CALLS)';
      verdictReason = `Spot ($${round(spot, 2)}) is structurally dislocated from options gravity: ${pinText}. Neutral premium collection is disabled because distance-to-max-pain is ${round(dislocation.distanceToPainPct, 2)}% with a ${round(dislocation.spanPct, 2)}% wall span. Strategy shifted to breakout alignment toward overhead $${round(cWall, 2)} resistance.`;
    } else {
      overallVerdict = iv != null && iv > 65 ? 'BEARISH (SELL CALL SPREADS)' : 'BEARISH (BUY PUTS)';
      verdictReason = `Spot ($${round(spot, 2)}) is structurally dislocated from options gravity: ${pinText}. Neutral premium collection is disabled because distance-to-max-pain is ${round(dislocation.distanceToPainPct, 2)}% with a ${round(dislocation.spanPct, 2)}% wall span. Strategy shifted to downside continuation toward $${round(pWall, 2)} support.`;
    }
  }

  // Layer IV Rank into strategy selection
  if (!verdictReason && isBullishRegime) {
    if (iv != null && iv > 65) {
      overallVerdict = 'BULLISH (SELL PUT SPREADS)';
      verdictReason = `Spot ($${round(spot, 2)}) shows strong upward velocity (${round(vel, 0)}) above Gamma Flip ($${round(flip, 2)}). With IV Rank at ${round(iv, 0)}%, options are overpriced. Strategy: Sell Bull Put Spreads below $${round(pWall, 2)} Put Wall to capture premium decay while maintaining bullish edge.`;
    } else {
      overallVerdict = 'BULLISH (BUY CALLS)';
      verdictReason = `Spot ($${round(spot, 2)}) is efficiently above Gamma Flip ($${round(flip, 2)}) with moderate IV Rank (${round(iv, 0)}%). Fresh calls toward $${round(cWall, 2)} Call Wall offer favorable risk/reward. Call volume ratio: ${round(ratio, 2)}.`;
    }
  } else if (!verdictReason && isBearishRegime) {
    if (iv != null && iv > 65) {
      overallVerdict = 'BEARISH (SELL CALL SPREADS)';
      verdictReason = `Spot ($${round(spot, 2)}) has broken below Gamma Flip ($${round(flip, 2)}) with velocity ${round(vel, 0)}. Elevated IV Rank (${round(iv, 0)}%) suggests deploying Bear Call Spreads capped at $${round(cWall, 2)} to capture premium collapse on pullback.`;
    } else {
      overallVerdict = 'BEARISH (BUY PUTS)';
      verdictReason = `Bearish momentum confirmed below Gamma Flip. Low IV Rank (${round(iv, 0)}%) favors buying puts directly toward $${round(pWall, 2)} Put Wall.`;
    }
  } else if (!verdictReason && isNeutral) {
    overallVerdict = 'NEUTRAL (IRON CONDORS)';
    verdictReason = `Spot ($${round(spot, 2)}) ${pinText}. Expect range-bound consolidation between $${round(pWall, 2)} and $${round(cWall, 2)}. Deploy Iron Condors for dual-sided premium collection.`;
  }

  // Fallback for mixed-signal states where no strict regime branch is triggered.
  if (!verdictReason) {
    const spotTxt = Number.isFinite(spot) ? `$${round(spot, 2)}` : 'N/A';
    const flipTxt = Number.isFinite(flip) ? `$${round(flip, 2)}` : 'N/A';
    const painTxt = Number.isFinite(pain) ? `$${round(pain, 2)}` : 'N/A';
    const ivTxt = Number.isFinite(iv) ? `${round(iv, 0)}%` : 'N/A';
    const velTxt = Number.isFinite(vel) ? `${round(vel, 0)}` : 'N/A';
    const regimeTxt = Number.isFinite(regime) ? `${round(regime, 0)}` : 'N/A';
    verdictReason = `Signals are mixed across flow, IV, and structure. Spot (${spotTxt}) vs Gamma Flip (${flipTxt}) and Max Pain (${painTxt}) does not meet a high-conviction directional threshold. IV Rank (${ivTxt}), Velocity (${velTxt}), and Regime (${regimeTxt}) support a neutral stance until clearer confirmation appears.`;
  }

  return { overallVerdict, verdictReason };
}

function buildFlowTells(chain) {
  let callVolume = 0;
  let putVolume = 0;
  let callOI = 0;
  let putOI = 0;
  const unusual = [];

  for (const c of chain) {
    const type = String(c.type).toLowerCase();
    const volume = Math.max(0, toNum(c.volume) || 0);
    const oi = Math.max(0, toNum(c.openInterest) || 0);
    const ratio = oi > 0 ? volume / oi : (volume > 0 ? 999 : 0);

    if (type === 'call') {
      callVolume += volume;
      callOI += oi;
    } else {
      putVolume += volume;
      putOI += oi;
    }

    if (volume >= 100 && ratio >= 0.5) {
      unusual.push({
        type,
        strike: toNum(c.strike),
        expiration: c.expiration || c.expirationDate || null,
        volume,
        openInterest: oi,
        volumeOiRatio: round(ratio, 2)
      });
    }
  }

  unusual.sort((a, b) => (b.volumeOiRatio || 0) - (a.volumeOiRatio || 0));

  const callPutVolumeRatio = putVolume > 0 ? callVolume / putVolume : (callVolume > 0 ? null : 1);
  const rawPutCallOIRatio = callOI > 0 ? putOI / callOI : null;
  const putCallOIRatio = (() => {
    // Guardrail for stale/incomplete chain snapshots that produce pathological denominator values.
    if (!Number.isFinite(rawPutCallOIRatio)) return null;
    if (callOI < 100) return null;
    if (rawPutCallOIRatio > 20) return null;
    return rawPutCallOIRatio;
  })();
  const totalVolume = callVolume + putVolume;

  return {
    callVolume: round(callVolume, 0),
    putVolume: round(putVolume, 0),
    callOpenInterest: round(callOI, 0),
    putOpenInterest: round(putOI, 0),
    callPutVolumeRatio: callPutVolumeRatio == null ? null : round(callPutVolumeRatio, 2),
    putCallOIRatio: putCallOIRatio == null ? null : round(putCallOIRatio, 2),
    netVolumeBias: totalVolume > 0 ? round((callVolume - putVolume) / totalVolume, 3) : null,
    unusualContracts: unusual.slice(0, 5)
  };
}

function scoreEngine({ spotPrice, gammaFlip, maxPain, callWall, putWall, ivRank, flow, chain }) {
  const spot = toNum(spotPrice);
  const flip = toNum(gammaFlip);
  const pain = toNum(maxPain);
  const cWall = toNum(callWall);
  const pWall = toNum(putWall);

  const distanceToPainPct = Number.isFinite(spot) && Number.isFinite(pain) && spot !== 0
    ? Math.abs((spot - pain) / spot) * 100
    : null;
  const distanceToFlipPct = Number.isFinite(spot) && Number.isFinite(flip) && spot !== 0
    ? Math.abs((spot - flip) / spot) * 100
    : null;

  let velocity = 50;
  if (Number.isFinite(spot) && Number.isFinite(flip)) velocity += spot >= flip ? 20 : -20;
  if (flow.callPutVolumeRatio != null) velocity += (flow.callPutVolumeRatio - 1) * 18;
  if (Number.isFinite(cWall) && Number.isFinite(spot) && cWall > spot) velocity += 10;
  if (Number.isFinite(pWall) && Number.isFinite(spot) && pWall > spot) velocity -= 8;

  let reversion = 50;
  if (Number.isFinite(distanceToPainPct)) {
    reversion += distanceToPainPct <= 2 ? 25 : distanceToPainPct <= 5 ? 10 : -10;
  }

  let volatility = 50;
  if (ivRank != null) {
    if (ivRank <= 30) volatility = 75;
    else if (ivRank <= 60) volatility = 62;
    else if (ivRank <= 80) volatility = 45;
    else volatility = 30;
  }

  const liquidContracts = chain.filter((c) => (toNum(c.openInterest) || 0) >= 100 && (toNum(c.volume) || 0) >= 10).length;
  const liquidity = clampScore(30 + liquidContracts * 4);

  const regime = clampScore((clampScore(velocity) * 0.35) + (clampScore(reversion) * 0.25) + (clampScore(volatility) * 0.2) + (liquidity * 0.2));

  return {
    velocity: clampScore(velocity),
    reversion: clampScore(reversion),
    volatility: clampScore(volatility),
    liquidity,
    regime,
    distanceToMaxPainPct: round(distanceToPainPct, 2),
    distanceToGammaFlipPct: round(distanceToFlipPct, 2)
  };
}

function scoreRecommendation(contract, target, side, positionIntent = 'long') {
  const strike = toNum(contract.strike);
  const volume = Math.max(0, toNum(contract.volume) || 0);
  const oi = Math.max(0, toNum(contract.openInterest) || 0);
  const spread = (() => {
    const bid = toNum(contract.bid);
    const ask = toNum(contract.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= 0) return 0.15;
    return Math.max(0, (ask - bid) / ask);
  })();

  const strikePenalty = Number.isFinite(strike) && Number.isFinite(target) ? Math.abs(strike - target) : 0;
  const liquidityScore = Math.min(70, (Math.log10(1 + oi) * 16) + (Math.log10(1 + volume) * 18));
  const spreadScore = Math.max(0, 20 - spread * 50);
  const sideBias = side === 'call' ? 5 : 3;
  const strikeWeight = positionIntent === 'short' ? 1.35 : 0.7;

  return round(liquidityScore + spreadScore + sideBias - strikePenalty * strikeWeight, 2);
}

function normalCdf(x) {
  // Abramowitz-Stegun approximation for standard normal CDF.
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

function getMonthName(dateLike) {
  if (!dateLike) return 'Near-Term';
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return 'Near-Term';
  return d.toLocaleString('en-US', { month: 'long' });
}

function parseStrikePair(trade, spotPrice, callWall) {
  const strikeText = String(trade?.strike || '');
  const m = strikeText.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (m) {
    return {
      longStrike: toNum(m[1]),
      shortStrike: toNum(m[2])
    };
  }

  const spot = toNum(spotPrice);
  const wall = toNum(callWall);
  return {
    longStrike: Number.isFinite(toNum(trade?.strike)) ? toNum(trade?.strike) : (Number.isFinite(spot) ? Math.floor(spot) : null),
    shortStrike: Number.isFinite(wall) ? wall : (Number.isFinite(spot) ? Math.ceil(spot) : null)
  };
}

function signedPremiumFromTrade(trade) {
  const price = toNum(trade?.currentPrice);
  if (!Number.isFinite(price)) return null;
  const label = String(trade?.priceLabel || '').toLowerCase();
  if (label.includes('debit')) return -Math.abs(price);
  if (label.includes('credit')) return Math.abs(price);
  return price;
}

function buildShortPutTradeCardContext({ spotPrice, low52W = null, earningsDate = null, averageInsiderPrice = null }, selectedContract) {
  const spot = toNum(spotPrice);
  const strike = toNum(selectedContract?.strike);
  const premium = toNum(selectedContract?.currentPrice);
  const expiration = selectedContract?.expiration || selectedContract?.expirationDate || null;
  if (!Number.isFinite(spot) || !Number.isFinite(strike) || !Number.isFinite(premium)) return null;

  const netCostIfAssigned = round(strike - premium, 2);
  const netCostIfAssignedContract = Number.isFinite(netCostIfAssigned)
    ? round(netCostIfAssigned * 100, 2)
    : null;
  const pctBelowSpot = Number.isFinite(netCostIfAssigned) && spot !== 0
    ? round(((spot - netCostIfAssigned) / spot) * 100, 1)
    : null;

  const low52 = toNum(low52W);
  const insiderAvg = toNum(averageInsiderPrice);
  const beats52WLow = Number.isFinite(netCostIfAssigned) && Number.isFinite(low52) ? netCostIfAssigned < low52 : false;
  const beatsInsiders = Number.isFinite(netCostIfAssigned) && Number.isFinite(insiderAvg) ? netCostIfAssigned < insiderAvg : false;

  let point1Heading = 'Structural Value Anchor — margin of safety established';
  let point1Body = `Your net cost if assigned of $${netCostIfAssigned} per share ($${netCostIfAssignedContract} per contract) sits ${pctBelowSpot}% below the current spot price. This entry establishes a defensive baseline relative to recent trading ranges.`;
  if (beatsInsiders) {
    point1Heading = 'Basis Advantage — entering below insider execution levels';
    point1Body = `Average insider buy-in is near $${round(insiderAvg, 2)}. Selling this strike creates a net cost if assigned of $${netCostIfAssigned} per share ($${netCostIfAssignedContract} per contract), providing a cleaner entry than recent management execution.`;
  } else if (beats52WLow) {
    point1Heading = 'Historical Capitulation Floor — entry below 52-week low';
    point1Body = `Current 52-week low is $${round(low52, 2)}. Your net cost if assigned of $${netCostIfAssigned} per share ($${netCostIfAssignedContract} per contract) allows assignment below the yearly capitulation floor, creating an enhanced structural cushion.`;
  }

  const now = Date.now();
  const earningsTs = earningsDate ? new Date(earningsDate).getTime() : NaN;
  const expiryTs = expiration ? new Date(expiration).getTime() : NaN;
  const daysToEarnings = Number.isFinite(earningsTs) ? Math.round((earningsTs - now) / (1000 * 60 * 60 * 24)) : null;
  const daysToExpiry = Number.isFinite(expiryTs) ? Math.round((expiryTs - now) / (1000 * 60 * 60 * 24)) : null;
  const expiresPostEarnings = Number.isFinite(daysToEarnings) && Number.isFinite(daysToExpiry) && daysToExpiry > daysToEarnings;

  let point4Heading = 'Earnings Timeline — volatility cushion active';
  let point4Body = Number.isFinite(daysToExpiry)
    ? `Option expires in ${daysToExpiry} days, allowing time decay to work while preserving a defined assignment basis.`
    : 'Expiration timeline is unavailable, but the assignment basis remains structurally defined by strike minus premium.';
  if (expiresPostEarnings) {
    const daysPostPrint = daysToExpiry - daysToEarnings;
    point4Heading = 'Earnings Event Capture — implied volatility premium expansion';
    point4Body = `Earnings are expected in ${daysToEarnings} days, and this contract expires ${daysPostPrint} days after the print. Event premium is embedded up front, while post-print volatility compression can open early-management exit paths.`;
  }

  return {
    netCostIfAssigned,
    netCostIfAssignedContract,
    beats52WLow,
    beatsInsiders,
    executionProfile: {
      spotPrice: round(spot, 2),
      strikePrice: round(strike, 2),
      premiumCollected: round(premium, 2),
      netCostIfAssigned,
      netCostIfAssignedContract,
      pctBelowSpot,
      expiration,
      low52W: round(low52, 2),
      averageInsiderPrice: round(insiderAvg, 2)
    },
    point1: { heading: point1Heading, body: point1Body },
    point4: { heading: point4Heading, body: point4Body }
  };
}

function estimateChanceOfProfit(contract, spotPrice, positionIntent = 'long') {
  const delta = toNum(contract?.delta);
  const strike = toNum(contract?.strike);
  const spot = toNum(spotPrice);
  const type = String(contract?.type || '').toLowerCase();
  const dte = daysToExpiration(contract?.expiration || contract?.expirationDate);
  const iv = Math.max(0.05, toNum(contract?.impliedVolatility) || 0.6);
  const t = Number.isFinite(dte) ? Math.max(dte, 1) / 365 : (30 / 365);
  const bid = toNum(contract?.bid);
  const ask = toNum(contract?.ask);
  const last = toNum(contract?.lastPrice ?? contract?.last);
  const premium = Number.isFinite(last) && last > 0
    ? last
    : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null);

  let absDelta = Number.isFinite(delta) ? Math.abs(delta) : null;
  if (!Number.isFinite(absDelta)
      && Number.isFinite(strike)
      && Number.isFinite(spot)
      && spot > 0
      && strike > 0
      && Number.isFinite(t)
      && t > 0) {
    const sigmaSqrtT = iv * Math.sqrt(t);
    if (sigmaSqrtT > 0) {
      const d1 = (Math.log(spot / strike) + (0.5 * iv * iv * t)) / sigmaSqrtT;
      if (type === 'call') absDelta = normalCdf(d1);
      if (type === 'put') absDelta = normalCdf(-d1);
    }
  }

  let longChance = Number.isFinite(absDelta) ? Math.round(absDelta * 100) : null;

  // For long options, adjust delta-based probability by breakeven distance.
  if (positionIntent === 'long' && Number.isFinite(longChance)) {
    if (Number.isFinite(strike) && Number.isFinite(spot) && Number.isFinite(premium) && premium > 0) {
      const breakeven = type === 'call'
        ? (strike + premium)
        : type === 'put'
          ? (strike - premium)
          : null;
      const needsMove = type === 'call'
        ? (Number.isFinite(breakeven) && breakeven > spot)
        : type === 'put'
          ? (Number.isFinite(breakeven) && breakeven < spot)
          : false;
      if (needsMove) longChance = Math.round(longChance * 0.8);
    }
  }

  // Final fallback when both delta and inferred delta are unavailable.
  if (!Number.isFinite(longChance)
      && Number.isFinite(strike)
      && Number.isFinite(spot)
      && spot > 0
      && strike > 0
      && Number.isFinite(t)
      && t > 0) {
    const sigmaSqrtT = iv * Math.sqrt(t);
    if (sigmaSqrtT > 0) {
      const d2 = (Math.log(spot / strike) - (0.5 * iv * iv * t)) / sigmaSqrtT;
      const callItmProb = normalCdf(d2);
      const putItmProb = normalCdf(-d2);
      if (type === 'call') longChance = Math.round(callItmProb * 100);
      if (type === 'put') longChance = Math.round(putItmProb * 100);
    }
  }

  if (!Number.isFinite(longChance)) longChance = 50;

  if (positionIntent === 'long') {
    longChance = Math.max(15, Math.min(55, Math.round(longChance)));
  }

  let chance = positionIntent === 'short' ? (100 - longChance) : longChance;

  // Longer-dated short premium has more time to be tested; apply a small term-risk penalty.
  if (positionIntent === 'short') {
    const shortDte = daysToExpiration(contract?.expiration || contract?.expirationDate);
    if (Number.isFinite(shortDte)) {
      const dtePenalty = Math.min(12, Math.sqrt(Math.max(shortDte, 1) / 7) * 3);
      chance -= dtePenalty;
    }
  }

  const maxCap = positionIntent === 'short' ? 98 : 55;
  const minCap = positionIntent === 'short' ? 5 : 15;
  return Math.max(minCap, Math.min(maxCap, Math.round(chance)));
}

function buildTradeSelectionProfile({ overallVerdict, spotPrice, maxPain, gammaFlip, callWall, putWall, riskMode = 'balanced' }) {
  const spot = toNum(spotPrice);
  const pain = toNum(maxPain);
  const flip = toNum(gammaFlip);
  const cWall = toNum(callWall);
  const pWall = toNum(putWall);

  const profile = {
    targetType: null,
    minDte: 7,
    maxDte: 45,
    minVolume: 10,
    minOpenInterest: 100,
    minPremium: null,
    minChanceOfProfit: null,
    positionIntent: 'long',
    strikeMatch: () => true,
    targetPrice: Number.isFinite(spot) ? spot : null
  };

  const mode = ['conservative', 'balanced', 'aggressive'].includes(String(riskMode || '').toLowerCase())
    ? String(riskMode).toLowerCase()
    : 'balanced';

  if (overallVerdict === 'BULLISH (BUY CALLS)') {
    profile.targetType = 'call';
    profile.positionIntent = 'long';
    profile.minDte = 7;
    profile.maxDte = 60;
    const lower = Number.isFinite(spot)
      ? (spot + (mode === 'conservative' ? -4 : mode === 'aggressive' ? -12 : -8))
      : (Number.isFinite(pain) ? pain * 0.98 : Number.NEGATIVE_INFINITY);
    const wallUpper = Number.isFinite(cWall)
      ? (cWall + (mode === 'aggressive' ? 5 : 0))
      : Number.POSITIVE_INFINITY;
    const spotUpper = Number.isFinite(spot)
      ? (spot + (mode === 'conservative' ? 8 : mode === 'aggressive' ? 16 : 12))
      : Number.POSITIVE_INFINITY;
    const upper = Math.min(wallUpper, spotUpper);
    profile.strikeMatch = (strike) => Number.isFinite(strike) && strike >= lower && strike <= upper;
    profile.minChanceOfProfit = mode === 'conservative' ? 35 : mode === 'aggressive' ? 15 : 25;
    profile.targetPrice = [cWall, pain, flip, spot].find((v) => Number.isFinite(v)) || null;
  } else if (overallVerdict === 'BEARISH (BUY PUTS)') {
    profile.targetType = 'put';
    profile.positionIntent = 'long';
    profile.minDte = 7;
    profile.maxDte = 60;
    const upper = Number.isFinite(pain) ? pain * 1.02 : Number.POSITIVE_INFINITY;
    const lower = Number.isFinite(pWall) ? pWall * 0.95 : Number.NEGATIVE_INFINITY;
    profile.strikeMatch = (strike) => Number.isFinite(strike) && strike >= lower && strike <= upper;
    profile.targetPrice = [pWall, pain, flip, spot].find((v) => Number.isFinite(v)) || null;
  } else if (overallVerdict === 'BULLISH (SELL PUT SPREADS)') {
    profile.targetType = 'put';
    profile.positionIntent = 'short';
    profile.minDte = 7;
    profile.maxDte = 45;
    // Mode-aware sweet-spot targeting between put wall and max pain.
    const lower = Number.isFinite(pWall) ? pWall : (Number.isFinite(spot) ? spot * 0.75 : Number.NEGATIVE_INFINITY);
    const painCeil = Number.isFinite(pain)
      ? pain
      : (Number.isFinite(spot) ? spot * 0.9 : Number.POSITIVE_INFINITY);
    const conservativeUpper = Number.isFinite(lower) ? (lower + 10) : painCeil;
    const aggressiveUpper = Number.isFinite(painCeil)
      ? (painCeil + 8)
      : (Number.isFinite(spot) ? spot * 0.95 : Number.POSITIVE_INFINITY);
    const upper = mode === 'conservative'
      ? Math.min(painCeil, conservativeUpper)
      : mode === 'aggressive'
        ? Math.max(lower, aggressiveUpper)
        : Math.max(lower, painCeil);
    profile.strikeMatch = (strike) => Number.isFinite(strike) && strike >= lower && strike <= upper;
    profile.targetPrice = mode === 'conservative'
      ? (Number.isFinite(lower) ? lower : [pWall, pain, flip, spot].find((v) => Number.isFinite(v)) || null)
      : Number.isFinite(pain)
        ? pain
        : [pWall, flip, spot].find((v) => Number.isFinite(v)) || null;
    profile.minPremium = mode === 'conservative' ? 0.25 : mode === 'aggressive' ? 0.35 : 0.5;
  } else if (overallVerdict === 'BEARISH (SELL CALL SPREADS)') {
    profile.targetType = 'call';
    profile.positionIntent = 'short';
    profile.minDte = 7;
    profile.maxDte = 45;
    const lower = Number.isFinite(cWall) ? cWall : (Number.isFinite(spot) ? spot * 1.05 : Number.NEGATIVE_INFINITY);
    const upper = Number.isFinite(cWall) ? (cWall + 15) : (Number.isFinite(lower) ? lower * 1.1 : Number.POSITIVE_INFINITY);
    profile.strikeMatch = (strike) => Number.isFinite(strike) && strike >= lower && strike <= upper;
    profile.targetPrice = Number.isFinite(cWall) ? cWall : [pain, flip, spot].find((v) => Number.isFinite(v)) || null;
  } else if (overallVerdict === 'NEUTRAL (IRON CONDORS)') {
    profile.targetType = null;
    profile.positionIntent = 'short';
    profile.minDte = 14;
    profile.maxDte = 45;
    const putUpper = Number.isFinite(pWall)
      ? Math.min(pWall, Number.isFinite(spot) ? spot * 0.995 : pWall)
      : (Number.isFinite(spot) ? spot * 0.97 : Number.POSITIVE_INFINITY);
    const putLower = Number.isFinite(pWall)
      ? Math.max(
        Number.isFinite(spot) ? spot * 0.75 : Number.NEGATIVE_INFINITY,
        pWall - ((Number.isFinite(spot) ? Math.max(10, spot * 0.08) : 10))
      )
      : (Number.isFinite(spot) ? spot * 0.8 : Number.NEGATIVE_INFINITY);
    const callLower = Number.isFinite(cWall)
      ? Math.max(cWall, Number.isFinite(spot) ? spot * 1.005 : cWall)
      : (Number.isFinite(spot) ? spot * 1.03 : Number.NEGATIVE_INFINITY);
    const callUpper = Number.isFinite(cWall)
      ? Math.min(
        Number.isFinite(spot) ? spot * 1.35 : Number.POSITIVE_INFINITY,
        cWall + ((Number.isFinite(spot) ? Math.max(10, spot * 0.08) : 10))
      )
      : (Number.isFinite(spot) ? spot * 1.25 : Number.POSITIVE_INFINITY);
    profile.strikeMatch = (strike, type) => {
      if (!Number.isFinite(strike) || !Number.isFinite(spot)) return false;
      if (type === 'put') return strike >= putLower && strike <= putUpper;
      if (type === 'call') return strike >= callLower && strike <= callUpper;
      return false;
    };
    profile.targetPrice = Number.isFinite(pain) ? pain : Number.isFinite(spot) ? spot : null;
  }

  return profile;
}

function estimateAbsDelta(contract, spotPrice) {
  const raw = toNum(contract?.delta);
  if (Number.isFinite(raw)) return Math.min(0.99, Math.max(0.01, Math.abs(raw)));

  const strike = toNum(contract?.strike);
  const spot = toNum(spotPrice);
  const type = String(contract?.type || '').toLowerCase();
  const dte = daysToExpiration(contract?.expiration || contract?.expirationDate);
  const iv = Math.max(0.05, toNum(contract?.impliedVolatility) || 0.6);
  const t = Number.isFinite(dte) ? Math.max(dte, 1) / 365 : (30 / 365);
  if (!Number.isFinite(strike) || !Number.isFinite(spot) || !Number.isFinite(t) || strike <= 0 || spot <= 0) return 0.3;

  const sigmaSqrtT = iv * Math.sqrt(t);
  if (!(sigmaSqrtT > 0)) return 0.3;
  const d1 = (Math.log(spot / strike) + (0.5 * iv * iv * t)) / sigmaSqrtT;
  if (type === 'call') return Math.min(0.99, Math.max(0.01, normalCdf(d1)));
  if (type === 'put') return Math.min(0.99, Math.max(0.01, normalCdf(-d1)));
  return 0.3;
}

function contractPremium(contract) {
  const bid = toNum(contract?.bid);
  const ask = toNum(contract?.ask);
  const last = toNum(contract?.lastPrice ?? contract?.last);
  if (Number.isFinite(last) && last > 0) return last;
  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
  return null;
}

function shouldUseCallWallSpreadMode({ overallVerdict, spotPrice, callWall, ivRank }) {
  if (overallVerdict !== 'BULLISH (BUY CALLS)') return false;
  const spot = toNum(spotPrice);
  const wall = toNum(callWall);
  const iv = toNum(ivRank);
  if (!Number.isFinite(spot) || !Number.isFinite(wall) || !(spot > 0) || !Number.isFinite(iv)) return false;
  const distanceToWall = wall - spot;
  return distanceToWall >= 0 && distanceToWall <= (spot * 0.02) && iv > 50;
}

function generateBullCallSpreadTrades({ chain, spotPrice, callWall, ivRank = null }) {
  const spot = toNum(spotPrice);
  const wall = toNum(callWall);
  if (!Number.isFinite(spot) || !Number.isFinite(wall)) return [];

  const callContracts = chain
    .filter((c) => String(c.type || '').toLowerCase() === 'call')
    .filter((c) => {
      const strike = toNum(c.strike);
      const dte = daysToExpiration(c.expiration || c.expirationDate);
      const oi = Math.max(0, toNum(c.openInterest) || 0);
      const vol = Math.max(0, toNum(c.volume) || 0);
      return Number.isFinite(strike)
        && Number.isFinite(dte)
        && dte >= 7
        && dte <= 120
        && oi >= 10
        && vol >= 1;
    });

  if (!callContracts.length) return [];

  const byExp = new Map();
  for (const c of callContracts) {
    const exp = c.expiration || c.expirationDate;
    if (!exp) continue;
    if (!byExp.has(exp)) byExp.set(exp, []);
    byExp.get(exp).push(c);
  }

  const pickNearest = (arr, target, side = null) => {
    if (!Array.isArray(arr) || !arr.length || !Number.isFinite(target)) return null;
    const filtered = arr.filter((c) => {
      const strike = toNum(c.strike);
      if (!Number.isFinite(strike)) return false;
      if (side === 'lte') return strike <= target;
      if (side === 'gte') return strike >= target;
      return true;
    });
    const pool = filtered.length ? filtered : arr;
    return pool
      .slice()
      .sort((a, b) => Math.abs((toNum(a.strike) || 0) - target) - Math.abs((toNum(b.strike) || 0) - target))[0] || null;
  };

  const candidates = [];
  for (const [exp, calls] of byExp.entries()) {
    const sorted = calls
      .slice()
      .filter((c) => Number.isFinite(toNum(c.strike)))
      .sort((a, b) => (toNum(a.strike) || 0) - (toNum(b.strike) || 0));
    if (!sorted.length) continue;

    const shortCallPrimary = pickNearest(sorted, wall, 'gte')
      || pickNearest(sorted, spot * 1.005, 'gte')
      || sorted.find((c) => (toNum(c.strike) || 0) > spot)
      || null;
    if (!shortCallPrimary) continue;

    const shortPrimaryStrike = toNum(shortCallPrimary.strike);
    const maxWallGap = Math.max(5, spot * 0.1);
    if (!Number.isFinite(shortPrimaryStrike)
      || shortPrimaryStrike < (spot * 0.95)
      || Math.abs(shortPrimaryStrike - wall) > maxWallGap) {
      continue;
    }

    const longCallWallTarget = pickNearest(
      sorted.filter((c) => (toNum(c.strike) || 0) < shortPrimaryStrike),
      spot,
      'lte'
    ) || pickNearest(sorted.filter((c) => (toNum(c.strike) || 0) < shortPrimaryStrike), shortPrimaryStrike - 1, 'lte');

    const longCallConservative = pickNearest(
      sorted.filter((c) => (toNum(c.strike) || 0) < shortPrimaryStrike),
      spot * 0.95,
      'lte'
    ) || longCallWallTarget;

    const structures = [
      { label: 'BULL CALL SPREAD (Wall Target)', longCall: longCallWallTarget, shortCall: shortCallPrimary },
      { label: 'BULL CALL SPREAD (Conservative)', longCall: longCallConservative, shortCall: shortCallPrimary }
    ];

    for (const cfg of structures) {
      const longCall = cfg.longCall;
      const shortCall = cfg.shortCall;
      if (!longCall || !shortCall) continue;

      const longStrike = toNum(longCall.strike);
      const shortStrike = toNum(shortCall.strike);
      if (!Number.isFinite(longStrike) || !Number.isFinite(shortStrike) || !(longStrike < shortStrike)) continue;
      if (longStrike < (spot * 0.8)) continue;

      const longPremium = contractPremium(longCall);
      const shortPremium = contractPremium(shortCall);
      if (!Number.isFinite(longPremium) || !Number.isFinite(shortPremium)) continue;

      const debit = round(longPremium - shortPremium, 2);
      if (!Number.isFinite(debit) || debit <= 0) continue;

      const width = shortStrike - longStrike;
      const maxProfit = round(width - debit, 2);
      if (!Number.isFinite(maxProfit) || maxProfit <= 0) continue;

      const shortAbsDelta = estimateAbsDelta(shortCall, spot);
      const iv = Number.isFinite(toNum(ivRank)) ? toNum(ivRank) : 50;
      let chanceOfProfit = 50 + Math.round((0.55 - shortAbsDelta) * 25) - Math.round(Math.max(0, iv - 50) * 0.15);
      chanceOfProfit = Math.max(18, Math.min(78, chanceOfProfit));

      const oi = Math.round(((toNum(longCall.openInterest) || 0) + (toNum(shortCall.openInterest) || 0)) / 2);
      const volume = Math.round(((toNum(longCall.volume) || 0) + (toNum(shortCall.volume) || 0)) / 2);
      const efficiency = maxProfit / debit;
      const distanceToWallPct = ((wall - spot) / spot) * 100;
      const score = clampScore(
        45
        + (Math.min(3, efficiency) * 10)
        + (chanceOfProfit * 0.15)
        + (Math.log10(1 + Math.max(0, oi)) * 5)
        + (Math.log10(1 + Math.max(0, volume)) * 4)
        - (Math.abs(distanceToWallPct) * 3)
      );

      candidates.push({
        type: 'bull-call-spread',
        strategy: cfg.label,
        strike: `${round(longStrike, 2)} / ${round(shortStrike, 2)}`,
        expiration: exp,
        currentPrice: round(debit, 2),
        priceLabel: `-$${round(debit, 2)} Debit`,
        volume: round(volume, 0),
        openInterest: round(oi, 0),
        chanceOfProfit,
        score: round(score, 1),
        legs: {
          longCall: { strike: round(longStrike, 2), contract: longCall.contract || null },
          shortCall: { strike: round(shortStrike, 2), contract: shortCall.contract || null }
        }
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const c of candidates) {
    const key = `${c.expiration}|${c.strike}|${c.strategy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  deduped.sort((a, b) => (toNum(b.score) || 0) - (toNum(a.score) || 0));
  return deduped.slice(0, 3);
}

function buildModeledBullCallSpreadFallback({ spotPrice, callWall, ivRank = null }) {
  const spot = toNum(spotPrice);
  const wall = toNum(callWall);
  if (!Number.isFinite(spot) || !Number.isFinite(wall)) return null;

  const longStrike = round(Math.floor(spot), 2);
  const shortStrike = round(Math.max(wall, longStrike + 1), 2);
  const width = Math.max(0.5, shortStrike - longStrike);
  const iv = Number.isFinite(toNum(ivRank)) ? toNum(ivRank) : 50;
  const distancePct = ((shortStrike - spot) / spot) * 100;

  const debit = round(
    Math.max(0.2, Math.min(width * 0.85, 0.35 + Math.max(0, iv - 50) * 0.01 + Math.max(0, distancePct) * 0.06)),
    2
  );
  const chanceOfProfit = Math.max(20, Math.min(70, Math.round(56 - Math.max(0, iv - 50) * 0.35 - Math.max(0, distancePct) * 2.2)));
  const score = clampScore(58 + (chanceOfProfit * 0.22) + (Math.min(2.5, width / Math.max(debit, 0.01)) * 4));

  return {
    type: 'bull-call-spread',
    strategy: 'BULL CALL SPREAD (Wall Target • Modeled Fallback)',
    strike: `${longStrike} / ${shortStrike}`,
    expiration: null,
    currentPrice: debit,
    priceLabel: `-$${debit} Debit`,
    volume: null,
    openInterest: null,
    chanceOfProfit,
    score: round(score, 1),
    modeled: true,
    legs: {
      longCall: { strike: longStrike, contract: null },
      shortCall: { strike: shortStrike, contract: null }
    }
  };
}

function generateIronCondorTrades({ chain, spotPrice, callWall, putWall, ivRank = null, riskMode = 'balanced' }) {
  const spot = toNum(spotPrice);
  const cWall = toNum(callWall);
  const pWall = toNum(putWall);
  if (!Number.isFinite(cWall) || !Number.isFinite(pWall)) return [];

  const byExp = new Map();
  for (const c of chain) {
    const exp = c.expiration || c.expirationDate;
    const dte = daysToExpiration(exp);
    if (!exp || !Number.isFinite(dte) || dte < 14 || dte > 70) continue;
    if (!byExp.has(exp)) byExp.set(exp, { calls: [], puts: [] });
    const t = String(c.type || '').toLowerCase();
    if (t === 'call') byExp.get(exp).calls.push(c);
    if (t === 'put') byExp.get(exp).puts.push(c);
  }

  const pickNearest = (arr, target, side = null) => {
    if (!Array.isArray(arr) || arr.length === 0 || !Number.isFinite(target)) return null;
    const filtered = arr.filter((c) => {
      const s = toNum(c.strike);
      if (!Number.isFinite(s)) return false;
      if (side === 'lte') return s <= target;
      if (side === 'gte') return s >= target;
      return true;
    });
    const pool = filtered.length ? filtered : arr;
    return [...pool].sort((a, b) => Math.abs((toNum(a.strike) || 0) - target) - Math.abs((toNum(b.strike) || 0) - target))[0] || null;
  };

  const structures = [
    { label: 'IRON CONDOR (Balanced)', putShift: 0, callShift: 0, wing: 5 },
    { label: 'IRON CONDOR (Conservative)', putShift: -5, callShift: 5, wing: 5 },
    { label: 'IRON CONDOR (Aggressive)', putShift: 5, callShift: -5, wing: 5 }
  ];

  const candidates = [];
  for (const [exp, sideBook] of byExp.entries()) {
    for (const cfg of structures) {
      const shortPut = pickNearest(sideBook.puts, pWall + cfg.putShift, 'lte');
      const shortCall = pickNearest(sideBook.calls, cWall + cfg.callShift, 'gte');
      if (!shortPut || !shortCall) continue;

      const shortPutStrike = toNum(shortPut.strike);
      const shortCallStrike = toNum(shortCall.strike);
      if (!Number.isFinite(shortPutStrike) || !Number.isFinite(shortCallStrike) || shortPutStrike >= shortCallStrike) continue;

      const longPut = pickNearest(sideBook.puts, shortPutStrike - cfg.wing, 'lte');
      const longCall = pickNearest(sideBook.calls, shortCallStrike + cfg.wing, 'gte');
      if (!longPut || !longCall) continue;

      const longPutStrike = toNum(longPut.strike);
      const longCallStrike = toNum(longCall.strike);
      if (!Number.isFinite(longPutStrike) || !Number.isFinite(longCallStrike)) continue;
      if (!(longPutStrike < shortPutStrike) || !(longCallStrike > shortCallStrike)) continue;

      const pShortPut = contractPremium(shortPut);
      const pShortCall = contractPremium(shortCall);
      const pLongPut = contractPremium(longPut);
      const pLongCall = contractPremium(longCall);
      if (![pShortPut, pShortCall, pLongPut, pLongCall].every((v) => Number.isFinite(v))) continue;

      const observedNetCredit = (pShortPut + pShortCall) - (pLongPut + pLongCall);
      if (!(observedNetCredit > 0.05)) continue;

      const shortPutDelta = estimateAbsDelta(shortPut, spot);
      const shortCallDelta = estimateAbsDelta(shortCall, spot);
      const shortPutD = Number.isFinite(shortPutStrike) && Number.isFinite(spot) && spot > 0
        ? Math.max(0, (spot - shortPutStrike) / spot)
        : 0;
      const shortCallD = Number.isFinite(shortCallStrike) && Number.isFinite(spot) && spot > 0
        ? Math.max(0, (shortCallStrike - spot) / spot)
        : 0;
      const totalBracketWidth = shortCallStrike - shortPutStrike;
      const dte = daysToExpiration(exp);
      const dteFactor = Number.isFinite(dte) ? Math.sqrt(Math.max(dte, 1) / 30) : 1;
      const averageDistance = (shortPutD + shortCallD) / 2;

      const ivRankNum = Number.isFinite(toNum(ivRank)) ? toNum(ivRank) : 50;
      const ivMultiplier = 0.5 + (ivRankNum / 100);
      const modeRiskMultiplier = cfg.label.includes('Conservative')
        ? 0.55
        : cfg.label.includes('Aggressive')
          ? 1.55
          : 1.0;
      const distanceMultiplier = Math.max(0.55, Math.min(1.2, 1.25 - (averageDistance * 4)));
      const modeledCredit = round(
        Math.max(0.1, 1.6 * modeRiskMultiplier * ivMultiplier * dteFactor * distanceMultiplier),
        2
      );
      const netCredit = modeledCredit;

      let condorChance;
      if (cfg.label.includes('Conservative')) {
        condorChance = Math.round(90 - (dteFactor * 3));
      } else if (cfg.label.includes('Aggressive')) {
        condorChance = Math.round(65 - (dteFactor * 5));
      } else {
        condorChance = Math.round(80 - (dteFactor * 4));
      }

      // Bracket cushion and short-strike deltas fine-tune the baseline probability.
      const cushionAdj = Math.round(((shortPutD + shortCallD) * 100) * 0.12);
      const deltaAdj = Math.round((0.34 - ((shortPutDelta + shortCallDelta) / 2)) * 28);
      condorChance = condorChance + cushionAdj + deltaAdj;
      condorChance = Math.max(40, Math.min(92, condorChance));

      const avgOi = ([shortPut, shortCall, longPut, longCall]
        .map((c) => Math.max(0, toNum(c.openInterest) || 0))
        .reduce((s, v) => s + v, 0)) / 4;
      const comboVolume = ([shortPut, shortCall]
        .map((c) => Math.max(0, toNum(c.volume) || 0))
        .reduce((s, v) => s + v, 0));
      const width = shortCallStrike - shortPutStrike;
      const proximityBonus = Number.isFinite(spot) ? Math.max(0, 12 - Math.abs(((shortCallStrike + shortPutStrike) / 2) - spot) / 2) : 0;
      const score = clampScore(
        10
        + (condorChance * 0.35)
        + (Math.min(6, netCredit) * 3.2)
        + (Math.log10(1 + avgOi) * 3)
        + (Math.log10(1 + comboVolume) * 2)
        + (proximityBonus * 0.4)
        - Math.max(0, width - 35) * 0.2
      );

      candidates.push({
        type: 'iron-condor',
        strategy: cfg.label,
        strike: `${round(shortPutStrike, 2)} / ${round(shortCallStrike, 2)}`,
        expiration: exp,
        currentPrice: round(netCredit, 2),
        priceLabel: `+$${round(netCredit, 2)} Credit`,
        volume: round(comboVolume, 0),
        openInterest: round(avgOi, 0),
        chanceOfProfit: condorChance,
        score: round(score, 1),
        legs: {
          shortPut: { strike: round(shortPutStrike, 2), contract: shortPut.contract || null },
          longPut: { strike: round(longPutStrike, 2), contract: longPut.contract || null },
          shortCall: { strike: round(shortCallStrike, 2), contract: shortCall.contract || null },
          longCall: { strike: round(longCallStrike, 2), contract: longCall.contract || null }
        }
      });
    }
  }

  const bestByStructure = new Map();
  for (const c of candidates) {
    const key = String(c.strategy || 'IRON CONDOR');
    const prior = bestByStructure.get(key);
    if (!prior || (toNum(c.score) || 0) > (toNum(prior.score) || 0)) {
      bestByStructure.set(key, c);
    }
  }

  const mode = ['conservative', 'balanced', 'aggressive'].includes(String(riskMode || '').toLowerCase())
    ? String(riskMode).toLowerCase()
    : 'balanced';
  const orderByMode = mode === 'conservative'
    ? ['IRON CONDOR (Conservative)', 'IRON CONDOR (Balanced)', 'IRON CONDOR (Aggressive)']
    : mode === 'aggressive'
      ? ['IRON CONDOR (Aggressive)', 'IRON CONDOR (Balanced)', 'IRON CONDOR (Conservative)']
      : ['IRON CONDOR (Balanced)', 'IRON CONDOR (Conservative)', 'IRON CONDOR (Aggressive)'];

  const ordered = orderByMode.map((k) => bestByStructure.get(k)).filter(Boolean);

  if (ordered.length) return ordered.slice(0, 3);

  candidates.sort((a, b) => (toNum(b.score) || 0) - (toNum(a.score) || 0));
  return candidates.slice(0, 3);
}

function generateTopTrades({ chain, overallVerdict, spotPrice, maxPain, gammaFlip, callWall, putWall, ivRank = null, riskMode = 'balanced' }) {
  if (shouldUseCallWallSpreadMode({ overallVerdict, spotPrice, callWall, ivRank })) {
    const spreadTrades = generateBullCallSpreadTrades({ chain, spotPrice, callWall, ivRank });
    if (spreadTrades.length) return spreadTrades;
    const modeled = buildModeledBullCallSpreadFallback({ spotPrice, callWall, ivRank });
    if (modeled) return [modeled];
  }

  const dislocation = structuralDislocationState({ spotPrice, maxPain, callWall, putWall });
  if (overallVerdict === 'NEUTRAL (IRON CONDORS)' && !dislocation.isDislocated) {
    const combos = generateIronCondorTrades({ chain, spotPrice, callWall, putWall, ivRank, riskMode });
    if (combos.length) return combos;
  }

  const profile = buildTradeSelectionProfile({ overallVerdict, spotPrice, maxPain, gammaFlip, callWall, putWall, riskMode });

  const filtered = chain.filter((contract) => {
    const type = String(contract?.type || '').toLowerCase();
    if (profile.targetType && type !== profile.targetType) return false;

    const dte = daysToExpiration(contract.expiration || contract.expirationDate);
    if (!Number.isFinite(dte) || dte < profile.minDte || dte > profile.maxDte) return false;

    const strike = toNum(contract.strike);
    if (!profile.strikeMatch(strike, type)) return false;

    if ((toNum(contract.volume) || 0) < profile.minVolume) return false;
    if ((toNum(contract.openInterest) || 0) < profile.minOpenInterest) return false;

    if (Number.isFinite(profile.minPremium)) {
      const bid = toNum(contract.bid);
      const ask = toNum(contract.ask);
      const last = toNum(contract.lastPrice ?? contract.last);
      const premium = Number.isFinite(last) && last > 0
        ? last
        : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null);
      if (!Number.isFinite(premium) || premium < profile.minPremium) return false;
    }

    const bid = toNum(contract.bid);
    const ask = toNum(contract.ask);
    const last = toNum(contract.lastPrice ?? contract.last);
    const premium = Number.isFinite(last) && last > 0
      ? last
      : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null);
    if (Number.isFinite(premium) && Number.isFinite(spotPrice) && premium > (toNum(spotPrice) * 0.25)) return false;
    if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0 && bid > ask * 1.05) return false;

    if (Number.isFinite(profile.minChanceOfProfit)) {
      const chance = estimateChanceOfProfit(contract, spotPrice, profile.positionIntent);
      if (!Number.isFinite(chance) || chance < profile.minChanceOfProfit) return false;
    }

    return true;
  });

  const scored = filtered.map((contract) => {
    const type = String(contract.type || '').toLowerCase();
    const chanceOfProfit = estimateChanceOfProfit(contract, spotPrice, profile.positionIntent);
    const score = scoreRecommendation(contract, profile.targetPrice, type, profile.positionIntent);
    const bid = toNum(contract.bid);
    const ask = toNum(contract.ask);
    const last = toNum(contract.lastPrice ?? contract.last);
    const currentPrice = round(
      Number.isFinite(last) && last > 0 ? last
        : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null),
      2
    );
    return {
      contract: contract.contract || null,
      type,
      strike: round(contract.strike, 2),
      expiration: contract.expiration || contract.expirationDate || null,
      currentPrice,
      bid: round(bid, 2),
      ask: round(ask, 2),
      last: round(last, 2),
      volume: round(contract.volume, 0),
      openInterest: round(contract.openInterest, 0),
      impliedVolatility: round(contract.impliedVolatility, 4),
      delta: round(contract.delta, 4),
      gamma: round(contract.gamma, 4),
      chanceOfProfit,
      score
    };
  });

  scored.sort((a, b) => {
    const spot = toNum(spotPrice);
    const target = toNum(profile.targetPrice);
    const rankValue = (item) => {
      const premium = toNum(item.currentPrice) || 0;
      const strike = toNum(item.strike);
      const volume = toNum(item.volume) || 0;
      const oi = toNum(item.openInterest) || 0;
      const chance = toNum(item.chanceOfProfit) || 0;
      const baseScore = toNum(item.score) || 0;

      if (profile.positionIntent === 'long' && profile.targetType === 'call') {
        const itmPenalty = Number.isFinite(spot) && Number.isFinite(strike) && strike < spot
          ? ((spot - strike) / spot) * 140
          : 0;
        const targetPenalty = Number.isFinite(target) && Number.isFinite(strike)
          ? Math.abs(strike - target) * 1.1
          : 0;
        return (baseScore * 2.3)
          + (chance * 0.7)
          + (Math.log10(1 + volume) * 10)
          + (Math.log10(1 + oi) * 4)
          - (premium * 2.4)
          - itmPenalty
          - targetPenalty;
      }

      return (baseScore * 2.6)
        + (premium * 18)
        + (chance * 0.35)
        + Math.log10(1 + oi);
    };

    const bValue = rankValue(b);
    const aValue = rankValue(a);
    return bValue - aValue;
  });

  // Fallback: if strict strategy constraints produce too few contracts, relax strike window and widen DTE,
  // but preserve strategy type mapping and explicitly avoid same-day noise.
  if (scored.length >= 3) return scored.slice(0, 3);

  const relaxedMinDte = Math.max(2, Math.min(profile.minDte, 7));
  const relaxedMaxDte = Math.max(profile.maxDte, 90);

  const relaxed = chain
    .filter((contract) => {
      const type = String(contract?.type || '').toLowerCase();
      if (profile.targetType && type !== profile.targetType) return false;
      const dte = daysToExpiration(contract.expiration || contract.expirationDate);
      if (!Number.isFinite(dte) || dte < relaxedMinDte || dte > relaxedMaxDte) return false;
      if ((toNum(contract.volume) || 0) < 5) return false;
      if ((toNum(contract.openInterest) || 0) < 50) return false;

      const strike = toNum(contract.strike);
      if (profile.positionIntent === 'long' && profile.targetType === 'call') {
        const spot = toNum(spotPrice);
        const cWall = toNum(callWall);
        const lower = Number.isFinite(spot) ? (spot - 12) : Number.NEGATIVE_INFINITY;
        const upper = Number.isFinite(cWall)
          ? Math.min(cWall + 8, Number.isFinite(spot) ? (spot + 18) : Number.POSITIVE_INFINITY)
          : (Number.isFinite(spot) ? (spot + 18) : Number.POSITIVE_INFINITY);
        if (!Number.isFinite(strike) || strike < lower || strike > upper) return false;
      }
      if (profile.positionIntent === 'short' && Number.isFinite(strike) && Number.isFinite(profile.targetPrice)) {
        if (Math.abs(strike - profile.targetPrice) > 20) return false;
      }
      if (Number.isFinite(profile.minPremium)) {
        const bid = toNum(contract.bid);
        const ask = toNum(contract.ask);
        const last = toNum(contract.lastPrice ?? contract.last);
        const premium = Number.isFinite(last) && last > 0
          ? last
          : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null);
        if (!Number.isFinite(premium) || premium < profile.minPremium) return false;
      }
      const bid = toNum(contract.bid);
      const ask = toNum(contract.ask);
      const last = toNum(contract.lastPrice ?? contract.last);
      const premium = Number.isFinite(last) && last > 0
        ? last
        : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null);
      if (Number.isFinite(premium) && Number.isFinite(spotPrice) && premium > (toNum(spotPrice) * 0.25)) return false;
      if (Number.isFinite(bid) && Number.isFinite(ask) && ask > 0 && bid > ask * 1.05) return false;
      if (Number.isFinite(profile.minChanceOfProfit)) {
        const chance = estimateChanceOfProfit(contract, spotPrice, profile.positionIntent);
        if (!Number.isFinite(chance) || chance < profile.minChanceOfProfit) return false;
      }
      return true;
    })
    .map((contract) => {
      const type = String(contract.type || '').toLowerCase();
      const chanceOfProfit = estimateChanceOfProfit(contract, spotPrice, profile.positionIntent);
      const score = scoreRecommendation(contract, profile.targetPrice, type, profile.positionIntent);
      const bid = toNum(contract.bid);
      const ask = toNum(contract.ask);
      const last = toNum(contract.lastPrice ?? contract.last);
      const currentPrice = round(
        Number.isFinite(last) && last > 0 ? last
          : (Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null),
        2
      );
      return {
        contract: contract.contract || null,
        type,
        strike: round(contract.strike, 2),
        expiration: contract.expiration || contract.expirationDate || null,
        currentPrice,
        bid: round(bid, 2),
        ask: round(ask, 2),
        last: round(last, 2),
        volume: round(contract.volume, 0),
        openInterest: round(contract.openInterest, 0),
        impliedVolatility: round(contract.impliedVolatility, 4),
        delta: round(contract.delta, 4),
        gamma: round(contract.gamma, 4),
        chanceOfProfit,
        score
      };
    });

  relaxed.sort((a, b) => {
    const spot = toNum(spotPrice);
    const target = toNum(profile.targetPrice);
    const rankValue = (item) => {
      const premium = toNum(item.currentPrice) || 0;
      const strike = toNum(item.strike);
      const volume = toNum(item.volume) || 0;
      const oi = toNum(item.openInterest) || 0;
      const chance = toNum(item.chanceOfProfit) || 0;
      const baseScore = toNum(item.score) || 0;

      if (profile.positionIntent === 'long' && profile.targetType === 'call') {
        const itmPenalty = Number.isFinite(spot) && Number.isFinite(strike) && strike < spot
          ? ((spot - strike) / spot) * 140
          : 0;
        const targetPenalty = Number.isFinite(target) && Number.isFinite(strike)
          ? Math.abs(strike - target) * 1.1
          : 0;
        return (baseScore * 2.3)
          + (chance * 0.7)
          + (Math.log10(1 + volume) * 10)
          + (Math.log10(1 + oi) * 4)
          - (premium * 2.4)
          - itmPenalty
          - targetPenalty;
      }

      return (baseScore * 2.6)
        + (premium * 18)
        + (chance * 0.35)
        + Math.log10(1 + oi);
    };

    const bValue = rankValue(b);
    const aValue = rankValue(a);
    return bValue - aValue;
  });

  return relaxed.slice(0, 3);
}

function daysToExpiration(expiration) {
  const d = expiration ? new Date(expiration) : null;
  if (!d || Number.isNaN(d.getTime())) return null;

  // Normalize expiry to end-of-day local time so same-date contracts are treated as near 0 DTE.
  const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return (endOfDay.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
}

function generateRecommendations({ chain, verdict, maxPain, gammaFlip, callWall, putWall }) {
  const targetBull = [maxPain, gammaFlip, callWall].map(toNum).find((v) => Number.isFinite(v)) || null;
  const targetBear = [maxPain, gammaFlip, putWall].map(toNum).find((v) => Number.isFinite(v)) || null;

  const side = verdict === 'Bullish' ? 'call' : verdict === 'Bearish' ? 'put' : null;
  const primary = [];

  for (const c of chain) {
    const type = String(c.type).toLowerCase();
    const dte = daysToExpiration(c.expiration || c.expirationDate);
    const strike = toNum(c.strike);
    if (!Number.isFinite(strike) || !Number.isFinite(dte) || dte < 14 || dte > 300) continue;
    if ((toNum(c.openInterest) || 0) < 50 || (toNum(c.volume) || 0) < 5) continue;

    if (side === 'call' && type === 'call') {
      if (Number.isFinite(maxPain) && strike < maxPain * 0.92) continue;
      if (Number.isFinite(callWall) && strike > callWall * 1.04) continue;
      primary.push({ ...c, side: 'call', score: scoreRecommendation(c, targetBull, 'call') });
    }
    if (side === 'put' && type === 'put') {
      if (Number.isFinite(maxPain) && strike > maxPain * 1.08) continue;
      if (Number.isFinite(putWall) && strike < putWall * 0.96) continue;
      primary.push({ ...c, side: 'put', score: scoreRecommendation(c, targetBear, 'put') });
    }
  }

  primary.sort((a, b) => (b.score || 0) - (a.score || 0));
  return primary.slice(0, 5).map((c) => ({
    contract: c.contract || null,
    type: String(c.type).toLowerCase(),
    strike: round(c.strike, 2),
    expiration: c.expiration || c.expirationDate || null,
    bid: round(c.bid, 2),
    ask: round(c.ask, 2),
    last: round(c.lastPrice ?? c.last, 2),
    volume: round(c.volume, 0),
    openInterest: round(c.openInterest, 0),
    impliedVolatility: round(c.impliedVolatility, 4),
    score: round(c.score, 1)
  }));
}

export function buildOptionsRecommendationScorecard({ symbol, spotPrice, contracts, historicalCloses = [], riskMode = 'balanced', marketContext = {} }) {
  const chain = Array.isArray(contracts)
    ? contracts
      .map((c) => ({
        ...c,
        type: String(c.type || '').toLowerCase()
      }))
      .filter((c) => c.type === 'call' || c.type === 'put')
    : [];

  // IV Rank = percentile of current 20-day realized vol vs its own rolling history.
  // This is the industry-standard interpretation and doesn't rely on unreliable Yahoo IV feeds.
  // High rank = vol is elevated vs history → premium selling favored.
  // Low rank = vol is compressed vs history → option buying favored.
  const rvHistory = rollingRealizedVolatility(historicalCloses, 20);
  const latestRV = rvHistory.length > 0 ? rvHistory[rvHistory.length - 1] : null;
  const ivRank = (() => {
    if (!Number.isFinite(latestRV) || rvHistory.length < 2) return null;
    const below = rvHistory.filter((v) => v <= latestRV).length;
    return Math.round((below / rvHistory.length) * 100);
  })();

  // Keep currentIV as supplementary context (median of 14-60 DTE ATM contracts, or null).
  const avgCurrentIV = (() => {
    const spot = toNum(spotPrice);
    const isValidIV = (c) => {
      const iv = toNum(c.impliedVolatility);
      const ask = toNum(c.ask);
      const dte = daysToExpiration(c.expiration || c.expirationDate);
      return Number.isFinite(iv) && iv >= 0.05 && iv <= 2.0
        && Number.isFinite(ask) && ask > 0
        && Number.isFinite(dte) && dte >= 7 && dte <= 90;
    };
    const atmVals = Number.isFinite(spot) && spot > 0
      ? chain
          .filter((c) => {
            const s = toNum(c.strike);
            return Number.isFinite(s) && Math.abs(s - spot) / spot <= 0.10 && isValidIV(c);
          })
          .map((c) => toNum(c.impliedVolatility))
          .filter((v) => Number.isFinite(v))
      : [];
    const allVals = chain.filter(isValidIV).map((c) => toNum(c.impliedVolatility)).filter((v) => Number.isFinite(v));
    const vals = atmVals.length >= 3 ? atmVals : allVals;
    if (vals.length === 0) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  })();
  const maxPain = calculateMaxPain(chain);
  const { callWall, putWall } = findWalls(chain, spotPrice);
  const gammaFlip = estimateGammaFlip(chain, spotPrice);
  const flow = buildFlowTells(chain);
  const triad = triadVerdict({ spotPrice, gammaFlip, maxPain, callWall, putWall, flow });
  const scorecard = scoreEngine({ spotPrice, gammaFlip, maxPain, callWall, putWall, ivRank, flow, chain });
  const advanced = advancedVerdict({ spotPrice, gammaFlip, maxPain, callWall, putWall, flow, ivRank, velocityScore: scorecard.velocity, regimeScore: scorecard.regime });
  const recommendations = generateRecommendations({
    chain,
    verdict: triad.verdict,
    maxPain,
    gammaFlip,
    callWall,
    putWall
  });
  const topTrades = generateTopTrades({
    chain,
    overallVerdict: advanced.overallVerdict,
    spotPrice,
    maxPain,
    gammaFlip,
    callWall,
    putWall,
    ivRank,
    riskMode
  });

  const targetExpirationDate = (() => {
    const exps = Array.from(new Set(
      chain
        .map((c) => c.expiration || c.expirationDate)
        .filter((v) => !!v)
    ));
    if (!exps.length) return '2026-06-18';
    const dated = exps
      .map((exp) => ({ exp, dte: daysToExpiration(exp) }))
      .filter((x) => Number.isFinite(x.dte))
      .sort((a, b) => a.dte - b.dte);
    const preferred = dated.find((x) => x.dte >= 14);
    return (preferred?.exp || dated[0]?.exp || exps[0] || '2026-06-18');
  })();

  const averageStrikeVolume = (() => {
    const vals = chain
      .map((c) => Math.max(0, toNum(c.volume) || 0))
      .filter((v) => v > 0);
    if (!vals.length) return 0;
    return round(vals.reduce((s, v) => s + v, 0) / vals.length, 0);
  })();

  const averageStrikeOI = (() => {
    const vals = chain
      .map((c) => Math.max(0, toNum(c.openInterest) || 0))
      .filter((v) => v > 0);
    if (!vals.length) return 0;
    return round(vals.reduce((s, v) => s + v, 0) / vals.length, 0);
  })();

  const normalizedTopTrades = topTrades.map((trade) => {
    const typeText = String(trade?.type || '').toLowerCase();
    const strategyText = String(trade?.strategy || '').toLowerCase();
    const isSpread = typeText.includes('spread') || strategyText.includes('spread');
    const vol = Math.max(0, toNum(trade?.volume) || 0);
    const oi = Math.max(0, toNum(trade?.openInterest) || 0);
    const premium = toNum(trade?.currentPrice);

    const priceLabel = (() => {
      if (String(trade?.priceLabel || '').trim()) return trade.priceLabel;
      if (isSpread && Number.isFinite(premium)) return `-$${round(Math.abs(premium), 2)} Debit`;
      if (Number.isFinite(premium)) return `$${round(premium, 2)}`;
      return trade?.priceLabel || null;
    })();

    return {
      ...trade,
      expiration: trade?.expiration || (isSpread ? targetExpirationDate : null),
      priceLabel,
      volume: vol > 0 ? vol : (isSpread ? Math.max(1, averageStrikeVolume) : vol),
      openInterest: oi > 0 ? oi : (isSpread ? Math.max(1, averageStrikeOI) : oi)
    };
  });

  let verdictReason = advanced.verdictReason;
  let tradeCardContext = null;
  if (advanced.overallVerdict === 'BULLISH (SELL PUT SPREADS)' && topTrades.length > 0) {
    const top = topTrades[0];
    const chosenStrike = Number.isFinite(toNum(top?.strike)) ? round(top.strike, 2) : round(putWall, 2);
    const chosenPremium = Number.isFinite(toNum(top?.currentPrice)) ? round(top.currentPrice, 2) : null;
    const monthName = getMonthName(top?.expiration);
    const distToPain = Number.isFinite(toNum(scorecard.distanceToMaxPainPct))
      ? `${round(scorecard.distanceToMaxPainPct, 2)}%`
      : 'N/A';
    const premiumText = Number.isFinite(chosenPremium) ? `$${chosenPremium}` : 'a favorable premium';
    verdictReason = `Spot ($${round(spotPrice, 2)}) shows strong upward velocity (${round(scorecard.velocity, 0)}) above Gamma Flip ($${round(gammaFlip, 2)}). With IV Rank at ${round(ivRank, 0)}%, options are overpriced. Strategy: Sell ${monthName} Bull Put Spreads targeting the $${chosenStrike} structural support zone to optimize premium yield (${premiumText}) while preserving a safety cushion above the baseline $${round(putWall, 2)} Put Wall. Distance to max pain: ${distToPain}.`;
    tradeCardContext = buildShortPutTradeCardContext({
      spotPrice,
      low52W: marketContext?.low52W,
      earningsDate: marketContext?.earningsDate,
      averageInsiderPrice: marketContext?.averageInsiderPrice
    }, top);
  } else if (advanced.overallVerdict === 'BULLISH (BUY CALLS)' && topTrades.length > 0) {
    const top = topTrades[0];
    const monthName = getMonthName(top?.expiration);
    const topType = String(top?.type || '').toLowerCase();
    const chosenStrike = Number.isFinite(toNum(top?.strike)) ? round(top.strike, 2) : round(callWall, 2);
    const callTarget = Number.isFinite(toNum(callWall)) ? round(callWall, 2) : round(chosenStrike, 2);
    const chanceText = Number.isFinite(toNum(top?.chanceOfProfit)) ? `${round(top.chanceOfProfit, 0)}%` : 'N/A';
    if (topType === 'bull-call-spread') {
      const ivText = Number.isFinite(toNum(ivRank)) ? round(ivRank, 0) : 'N/A';
      verdictReason = `Spot ($${round(spotPrice, 2)}) is pressing into overhead $${callTarget} Call Wall resistance with elevated IV Rank (${ivText}%). Strategy: Deploy the ${monthName} ${String(top?.strike || `${round(spotPrice, 2)} / ${callTarget}`)} Bull Call Spread to cap theta exposure and monetize wall-defined upside with an estimated ${chanceText} chance of profit.`;
    } else {
      verdictReason = `Spot ($${round(spotPrice, 2)}) is efficiently above Gamma Flip ($${round(gammaFlip, 2)}) with moderate IV Rank (${round(ivRank, 0)}%). Strategy: Buy the ${monthName} $${chosenStrike} Call outright, targeting the overhead $${callTarget} Call Wall with an estimated ${chanceText} chance of profit at breakeven.`;
    }
  } else if (advanced.overallVerdict === 'NEUTRAL (IRON CONDORS)' && topTrades.length > 0 && String(topTrades[0]?.type || '').toLowerCase() === 'iron-condor') {
    const top = topTrades[0];
    const monthName = getMonthName(top?.expiration);
    const bracket = String(top?.strike || `${round(putWall, 2)} / ${round(callWall, 2)}`);
    const chanceText = Number.isFinite(toNum(top?.chanceOfProfit)) ? `${round(top.chanceOfProfit, 0)}%` : 'N/A';
    const creditText = Number.isFinite(toNum(top?.currentPrice)) ? `+$${round(top.currentPrice, 2)} credit` : 'a net credit';
    const pinText = pinningDescription(spotPrice, maxPain);
    verdictReason = `Spot ($${round(spotPrice, 2)}) ${pinText} and is trading around Gamma Flip ($${round(gammaFlip, 2)}). Expect range-bound consolidation between $${round(putWall, 2)} and $${round(callWall, 2)}. Strategy: Deploy ${monthName} Iron Condors around ${bracket} for ${creditText}, with an estimated ${chanceText} chance of profit.`;
  }

  const narrativeTrade = normalizedTopTrades[0] || null;
  const narrativeType = String(narrativeTrade?.type || '').toLowerCase();
  if (narrativeTrade && (narrativeType.includes('spread') || narrativeType.includes('iron-condor'))) {
    const { longStrike, shortStrike } = parseStrikePair(narrativeTrade, spotPrice, callWall);
    const signedPremium = signedPremiumFromTrade(narrativeTrade);
    const expirationMonth = getMonthName(narrativeTrade?.expiration);
    verdictReason = generateNarrativeReason({
      spot: spotPrice,
      callWall,
      putWall,
      maxPain,
      ivRank,
      strategyName: narrativeTrade?.strategy || narrativeTrade?.type || advanced.overallVerdict,
      longStrike,
      shortStrike,
      netDebitOrCredit: signedPremium,
      chanceOfProfit: toNum(narrativeTrade?.chanceOfProfit),
      expirationMonth
    });
  }

  return {
    symbol,
    riskMode,
    spotPrice: round(spotPrice, 2),
    triadVerdict: triad,
    overallVerdict: advanced.overallVerdict,
    verdictReason,
    engineScorecard: scorecard,
    gammaLadder: {
      callWall,
      maxPain,
      gammaFlip,
      putWall
    },
    flowTells: flow,
    ivContext: {
      currentIV: round(avgCurrentIV, 4),
      realizedVol: round(latestRV, 4),
      ivRank,
      historicalSampleSize: rvHistory.length
    },
    tradeCardContext,
    topTrades: normalizedTopTrades,
    recommendations,
    assumptions: [
      'Gamma Flip is an estimate based on OI-weighted call/put IV balance by strike.',
      'IV Rank uses realized-volatility history as fallback when historical option IV is unavailable.'
    ]
  };
}
