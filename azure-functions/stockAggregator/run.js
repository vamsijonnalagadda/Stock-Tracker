import stockFn from './index.js';
(async () => {
  try {
    await stockFn({ log: console.log });
    console.log('stockAggregator run complete');
  } catch (e) {
    console.error('stockAggregator run failed', e);
    process.exit(1);
  }
})();
