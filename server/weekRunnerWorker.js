// Runs the heavy (~10-20s CPU) analysis off the main thread so the web server / websockets never freeze.
const { parentPort, workerData } = require('worker_threads');
const R = require('./weekRunnerRank');
try {
  const out = R.runAll(workerData.data, workerData.nifty, workerData.vix, workerData.hygiene, workerData.sectors || {});
  parentPort.postMessage({ ok: true, out });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.message });
}
