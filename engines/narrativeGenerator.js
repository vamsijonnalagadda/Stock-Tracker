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

function formatPrice(value, digits = 2) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return 'N/A';
  return round(n, digits).toFixed(digits);
}

function includesAny(text, patterns) {
  const src = String(text || '').toUpperCase();
  return patterns.some((p) => src.includes(String(p).toUpperCase()));
}

export function generateNarrativeReason(data) {
  const {
    spot,
    callWall,
    putWall,
    maxPain,
    ivRank,
    strategyName,
    longStrike,
    shortStrike,
    netDebitOrCredit,
    chanceOfProfit,
    expirationMonth = 'Near-Term'
  } = data || {};

  const spotNum = toNum(spot);
  const callWallNum = toNum(callWall);
  const putWallNum = toNum(putWall);
  const maxPainNum = toNum(maxPain);
  const ivRankNum = toNum(ivRank);
  const longStrikeNum = toNum(longStrike);
  const shortStrikeNum = toNum(shortStrike);
  const netSigned = toNum(netDebitOrCredit);
  const cop = toNum(chanceOfProfit);

  const distToCallWall = Number.isFinite(spotNum) && Number.isFinite(callWallNum)
    ? (callWallNum - spotNum)
    : null;
  const distToPutWall = Number.isFinite(spotNum) && Number.isFinite(putWallNum)
    ? (spotNum - putWallNum)
    : null;

  const strategyText = String(strategyName || '');
  const isBullCallSpread = includesAny(strategyText, ['BULL CALL SPREAD', 'BULL-CALL-SPREAD']);
  const isBearPutSpread = includesAny(strategyText, ['BEAR PUT SPREAD', 'BEAR-PUT-SPREAD']);
  const isSpread = includesAny(strategyText, ['SPREAD']);
  const isIronCondor = includesAny(strategyText, ['IRON CONDOR']);

  let coreCatalyst = '';
  if (isBullCallSpread && Number.isFinite(distToCallWall) && Number.isFinite(spotNum) && distToCallWall < (spotNum * 0.02)) {
    coreCatalyst = `Spot ($${formatPrice(spotNum)}) is executing an aggressive momentum squeeze just $${formatPrice(distToCallWall)} beneath heavy institutional resistance at the $${formatPrice(callWallNum)} Call Wall.`;
  } else if (isBearPutSpread && Number.isFinite(distToPutWall) && Number.isFinite(spotNum) && distToPutWall < (spotNum * 0.02)) {
    coreCatalyst = `Spot ($${formatPrice(spotNum)}) is fracturing local support, pressing directly into the structural market-maker floor at the $${formatPrice(putWallNum)} Put Wall.`;
  } else if (isIronCondor) {
    coreCatalyst = `Spot ($${formatPrice(spotNum)}) has achieved structural equilibrium, framed by key option boundaries around Max Pain ($${formatPrice(maxPainNum)}).`;
  } else {
    coreCatalyst = `Spot ($${formatPrice(spotNum)}) is displaying technical breakout characteristics, disconnected from historical options gravity anchors ($${formatPrice(maxPainNum)}).`;
  }

  let structuralDefense = '';
  if (Number.isFinite(ivRankNum) && ivRankNum >= 50) {
    structuralDefense = `Under this inflated volatility regime (IV Rank: ${formatPrice(ivRankNum, 1)}%), unhedged single-contract exposure is constrained to reduce premium contraction risk (Vega crush) and time decay drag (Theta exposure).`;
  } else {
    structuralDefense = `In this lower-volatility regime (IV Rank: ${formatPrice(ivRankNum, 1)}%), directional assignment still requires structural protection to mitigate adverse gaps while preserving delta participation.`;
  }

  let capitalEfficiency = '';
  const width = Number.isFinite(longStrikeNum) && Number.isFinite(shortStrikeNum)
    ? Math.abs(shortStrikeNum - longStrikeNum)
    : null;

  if (isSpread) {
    const costBasis = Number.isFinite(netSigned) ? Math.abs(netSigned) : null;
    const isDebit = Number.isFinite(netSigned) ? netSigned <= 0 : true;
    if (isDebit) {
      const maxGainPct = Number.isFinite(width) && Number.isFinite(costBasis) && costBasis > 0
        ? Math.max(0, ((width - costBasis) / costBasis) * 100)
        : null;
      capitalEfficiency = `Strategy: Deploy the ${expirationMonth} vertical ${formatPrice(longStrikeNum)} / ${formatPrice(shortStrikeNum)} debit structure. Entry cost is limited to $${formatPrice(costBasis)}, with defined upside geometry${Number.isFinite(maxGainPct) ? ` up to +${round(maxGainPct, 0)}% at full target` : ''} and an estimated ${Number.isFinite(cop) ? round(cop, 0) : 'N/A'}% chance of profit.`;
    } else {
      capitalEfficiency = `Strategy: Deploy the ${expirationMonth} vertical ${formatPrice(longStrikeNum)} / ${formatPrice(shortStrikeNum)} credit structure, collecting +$${formatPrice(costBasis)} while maintaining a defined-risk payout profile with an estimated ${Number.isFinite(cop) ? round(cop, 0) : 'N/A'}% chance of profit.`;
    }
  } else if (isIronCondor) {
    capitalEfficiency = `Strategy: Deploy the symmetric ${expirationMonth} ${formatPrice(putWallNum)} / ${formatPrice(callWallNum)} Iron Condor, harvesting +$${formatPrice(Math.abs(netSigned))} premium with an estimated ${Number.isFinite(cop) ? round(cop, 0) : 'N/A'}% margin-of-safety profile.`;
  } else {
    capitalEfficiency = `Strategy: Maintain defined-risk directional positioning aligned to the active structure with disciplined premium-to-target calibration.`;
  }

  return `${coreCatalyst}\n\n- Structural Defense: ${structuralDefense}\n- Capital Efficiency: ${capitalEfficiency}`;
}
