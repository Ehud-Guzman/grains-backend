/**
 * seed-delivery-zones.js
 *
 * Loads distance-based delivery zone presets into a branch's Settings document.
 * Safe to re-run — will only overwrite delivery fields, leaving all other settings untouched.
 *
 * Usage:
 *   cd backend
 *   node scripts/seed-delivery-zones.js --branch busia-branch --preset busia
 *   node scripts/seed-delivery-zones.js --branch nakuru-branch --preset nakuru
 *   node scripts/seed-delivery-zones.js --branch nairobi-branch --preset nairobi
 *
 * Options:
 *   --branch <slug>       Branch slug to target (required)
 *   --preset <name>       Zone preset to load: busia | nakuru | nairobi (required)
 *   --lat <number>        Also set the branch shop latitude
 *   --lng <number>        Also set the branch shop longitude
 *   --dry-run             Preview changes without writing to the database
 *   --list                Show all available presets and exit
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Branch   = require('../src/models/Branch');
const Settings = require('../src/models/Settings');

// ── DELIVERY ZONE PRESETS ─────────────────────────────────────────────────────

const PRESETS = {

  busia: {
    label: 'Busia (Pilot)',
    maxDeliveryKm: 55,
    deliveryFee: 200, // fallback flat fee if GPS unavailable
    zones: [
      { name: 'Busia CBD & Main Market',   minKm: 0,  maxKm: 1,    fee: 100  },
      { name: 'Busia Town Centre',         minKm: 1,  maxKm: 2.5,  fee: 150  },
      { name: 'Hajj, Mayuga & Estates',    minKm: 2.5,maxKm: 4,    fee: 220  },
      { name: 'Alupe & Hospital Area',     minKm: 4,  maxKm: 6,    fee: 300  },
      { name: 'Matayos & Amukura',         minKm: 6,  maxKm: 12,   fee: 400  },
      { name: 'Amagoro & Teso North',      minKm: 12, maxKm: 22,   fee: 550  },
      { name: 'Bumala & Butula',           minKm: 22, maxKm: 32,   fee: 720  },
      { name: 'Nambale & Samia',           minKm: 32, maxKm: 42,   fee: 900  },
      { name: 'Funyula & Bunyala',         minKm: 42, maxKm: 50,   fee: 1100 },
      { name: 'Port Victoria & Malaba',    minKm: 50, maxKm: 9999, fee: 1400 },
    ]
  },

  nakuru: {
    label: 'Nakuru',
    maxDeliveryKm: 40,
    deliveryFee: 300,
    zones: [
      { name: 'Nakuru CBD',                minKm: 0,  maxKm: 3,    fee: 150  },
      { name: 'Nakuru Town Outskirts',     minKm: 3,  maxKm: 8,    fee: 250  },
      { name: 'Lanet, Njoro & Peri-Urban', minKm: 8,  maxKm: 20,   fee: 400  },
      { name: 'Naivasha & Far Nakuru',     minKm: 20, maxKm: 40,   fee: 600  },
      { name: 'Nakuru County Outliers',    minKm: 40, maxKm: 9999, fee: 800  },
    ]
  },

  nairobi: {
    label: 'Nairobi',
    maxDeliveryKm: 35,
    deliveryFee: 400,
    zones: [
      { name: 'Nairobi CBD & Westlands',   minKm: 0,  maxKm: 5,    fee: 200  },
      { name: 'Ngong Rd, Thika Rd, Mombasa Rd', minKm: 5, maxKm: 15, fee: 350 },
      { name: 'Rongai, Kikuyu & Suburbs',  minKm: 15, maxKm: 25,   fee: 550  },
      { name: 'Kiambu, Ruiru & Far Zones', minKm: 25, maxKm: 35,   fee: 800  },
      { name: 'Nairobi Metro Outliers',    minKm: 35, maxKm: 9999, fee: 1000 },
    ]
  },

};

// ── ARGUMENT PARSING ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has  = (flag) => args.includes(flag);

if (has('--list')) {
  console.log('\nAvailable presets:\n');
  for (const [slug, p] of Object.entries(PRESETS)) {
    console.log(`  --branch ${slug.padEnd(12)} → ${p.label} (${p.zones.length} bands, max ${p.maxDeliveryKm} km)`);
    p.zones.forEach(z =>
      console.log(`    ${String(z.minKm).padStart(4)} – ${String(z.maxKm === 9999 ? '∞' : z.maxKm).padEnd(6)} km   ${z.name.padEnd(35)} KES ${z.fee}`)
    );
    console.log();
  }
  process.exit(0);
}

const branchSlug  = get('--branch');
const presetKey   = get('--preset');

if (!branchSlug) {
  console.error('❌  --branch <slug> is required. Run with --list to see available presets.');
  process.exit(1);
}
if (!presetKey) {
  console.error(`❌  --preset <name> is required. Available: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

const preset = PRESETS[presetKey.toLowerCase()];
if (!preset) {
  console.error(`❌  No preset named "${presetKey}". Available: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

const inputLat  = get('--lat')  ? parseFloat(get('--lat'))  : null;
const inputLng  = get('--lng')  ? parseFloat(get('--lng'))  : null;
const isDryRun  = has('--dry-run');

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required in .env');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅  Connected to MongoDB\n');

  // Find the branch
  const branch = await Branch.findOne({ slug: branchSlug.toLowerCase() });
  if (!branch) {
    console.error(`❌  No branch found with slug "${branchSlug}". Make sure the branch exists first.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`📍  Branch: ${branch.name} (id: ${branch._id})`);
  console.log(`🗺️   Preset: ${preset.label} — ${preset.zones.length} bands, max ${preset.maxDeliveryKm} km\n`);

  // Preview the zones
  console.log('  Zone name                               From      To        Fee');
  console.log('  ' + '─'.repeat(70));
  preset.zones.forEach(z => {
    const from = `${z.minKm} km`.padEnd(8);
    const to   = z.maxKm === 9999 ? '∞'.padEnd(8) : `${z.maxKm} km`.padEnd(8);
    console.log(`  ${z.name.padEnd(40)} ${from}  ${to}  KES ${z.fee}`);
  });
  console.log();

  if (inputLat !== null && inputLng !== null) {
    console.log(`  📌  Will also set shop coordinates: lat=${inputLat}, lng=${inputLng}\n`);
  }

  if (isDryRun) {
    console.log('🔍  DRY RUN — no changes written. Remove --dry-run to apply.\n');
    await mongoose.disconnect();
    return;
  }

  // Build the update payload — only delivery fields, never touch other settings
  const settingsId = `settings_${branch._id}`;
  const update = {
    deliveryPricingMode: 'distance',
    deliveryZones:       preset.zones,
    maxDeliveryKm:       preset.maxDeliveryKm,
    deliveryFee:         preset.deliveryFee,
    updatedAt:           new Date(),
  };

  // Only set coordinates if explicitly passed — don't overwrite existing ones
  if (inputLat !== null && inputLng !== null) {
    update.branchLat = inputLat;
    update.branchLng = inputLng;
  }

  await Settings.findByIdAndUpdate(
    settingsId,
    { $set: update },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`✅  Delivery zones saved to settings (id: ${settingsId})`);
  if (inputLat !== null && inputLng !== null) {
    console.log(`✅  Shop coordinates set: ${inputLat}, ${inputLng}`);
  } else {
    console.log('ℹ️   Shop coordinates not set — add them in the admin settings panel or re-run with --lat and --lng');
  }

  console.log(`\n🎉  Done! "${branch.name}" is now using distance-based delivery pricing.`);
  console.log('    Open the admin settings panel to adjust individual fees if needed.\n');

  await mongoose.disconnect();
}

run().catch(async err => {
  console.error('❌  Script failed:', err.message);
  if (mongoose.connection.readyState !== 0) await mongoose.connection.close();
  process.exit(1);
});
