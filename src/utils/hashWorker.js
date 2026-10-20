// Worker thread that does the actual bcrypt maths (see utils/passwordHash.js).
// bcryptjs is pure JavaScript, so on the main thread one cost-12 hash holds the event loop for ~400 ms and a
// handful of logins at once freezes every other request. Here it only ever freezes this thread.
const { parentPort } = require('worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', async ({ id, op, a, b }) => {
  try {
    const result = op === 'hash' ? await bcrypt.hash(a, b) : await bcrypt.compare(a, b);
    parentPort.postMessage({ id, result });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
