export function getSentiment(current, sectorAvg, histAvg, type = 'valuation') {
  const isHigherBetter = (type === 'efficiency');
  const betterThanSector = isHigherBetter ? (current > sectorAvg) : (current < sectorAvg);
  const betterThanHist = isHigherBetter ? (current > histAvg) : (current < histAvg);

  if (betterThanSector && betterThanHist) return 'UP';
  if (!betterThanSector && !betterThanHist) return 'DOWN';
  return 'AVERAGE';
}

export function sentimentEmoji(flag) {
  if (flag === 'UP') return '👍';
  if (flag === 'DOWN') return '👎';
  return '➡️';
}

export function deviationPercent(current, reference) {
  if (current == null || reference == null) return null;
  try {
    return ((current - reference) / reference) * 100;
  } catch (e) {
    return null;
  }
}

export function chooseMasterMetric(forwardPE, peg) {
  // If PEG is strong (<1) and forwardPE is expensive, prefer PEG as master
  if (peg != null && peg < 1 && forwardPE != null && forwardPE > 20) return 'PEG';
  return 'P/E';
}
