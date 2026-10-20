const mongoose = require('mongoose');

// One row per background job (services/jobControl.service.js):
//   leaseUntil/holder - which server instance may run the job right now (so two instances do not both send
//                       the same emails or both cancel the same orders);
//   lastKey           - for daily jobs, the Nairobi date they last completed for, so a restart or a second
//                       instance never repeats today's run and a missed run is made up when the server wakes.
const jobStateSchema = new mongoose.Schema({
  _id: { type: String },
  holder: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  lastKey: { type: String, default: null },
  lastRunAt: { type: Date, default: null }
}, { versionKey: false });

module.exports = mongoose.model('JobState', jobStateSchema);
