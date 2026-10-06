export function calculatePerformance({ totalValueEur, initialCapitalEur = 1000, previousValueEur,
  benchmarkLevelEur, benchmarkBaseLevelEur }) {
  if (!Number.isFinite(totalValueEur) || totalValueEur < 0 || initialCapitalEur !== 1000) throw new Error('Valorisation performance invalide.');
  const reference = previousValueEur ?? initialCapitalEur;
  const cumulativeReturn = totalValueEur / initialCapitalEur - 1;
  const benchmarkCumulativeReturn = Number.isFinite(benchmarkLevelEur) && benchmarkLevelEur > 0
    && Number.isFinite(benchmarkBaseLevelEur) && benchmarkBaseLevelEur > 0
    ? benchmarkLevelEur / benchmarkBaseLevelEur - 1 : null;
  return { dailyReturn: reference > 0 ? totalValueEur / reference - 1 : null, cumulativeReturn,
    benchmarkCumulativeReturn, excessReturn: benchmarkCumulativeReturn === null ? null : cumulativeReturn - benchmarkCumulativeReturn };
}
