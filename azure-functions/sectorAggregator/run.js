import sectorFn from './index.js';
(async () => {
  try {
    await sectorFn({ log: console.log });
    console.log('sectorAggregator run complete');
  } catch (e) {
    console.error('sectorAggregator run failed', e);
    process.exit(1);
  }
})();
