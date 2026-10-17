/**
 * report-duplicate-phones.js  (READ-ONLY)
 *
 * Before 2026-10 the same phone number could register twice, because it was stored exactly as
 * typed (0712…, +254712…, 254712…). New accounts are now stored as 0712… and every lookup matches
 * all three forms, but accounts created earlier may still be duplicated. This lists them so you
 * can decide, per pair, which one to keep — it never changes anything.
 *
 * Usage:
 *   cd backend
 *   node scripts/report-duplicate-phones.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const User = require('../src/models/User');
const Order = require('../src/models/Order');
const { toLocalPhone } = require('../src/utils/mpesaHelpers');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const users = await User.find({}).select('name phone role createdAt lastLoginAt').lean();

  const groups = new Map();
  for (const u of users) {
    let key;
    try { key = toLocalPhone(u.phone); } catch { continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(u);
  }

  const dupes = [...groups.entries()].filter(([, list]) => list.length > 1);
  if (dupes.length === 0) {
    console.log('No duplicate phone numbers found.');
  } else {
    console.log(`${dupes.length} phone number(s) have more than one account:\n`);
    for (const [phone, list] of dupes) {
      console.log(phone);
      for (const u of list) {
        const orders = await Order.countDocuments({ userId: u._id });
        console.log(`  ${u._id}  ${u.role.padEnd(10)} "${u.name}"  stored as ${u.phone}  orders: ${orders}  last login: ${u.lastLoginAt ? u.lastLoginAt.toISOString().slice(0, 10) : 'never'}`);
      }
    }
    console.log('\nNothing was changed. Lock or merge the unused account by hand from the admin panel.');
  }
  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
