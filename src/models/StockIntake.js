const mongoose = require('mongoose');

// Stock intake / truck arrival log
// Separate from StockLog — this records raw/unsorted goods coming in by truck
// before they are sorted and packed into sellable products.
// Status lifecycle: pending → processed (immutable once processed)
const stockIntakeSchema = new mongoose.Schema({
  intakeRef:  { type: String, required: true },         // e.g. "INT-2024-0001"
  branchId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },

  // ── ARRIVAL INFO ─────────────────────────────────────────────────────────────
  supplier:   { type: String, required: true, trim: true },
  vehicleRef: { type: String, trim: true, default: '' }, // truck plate / reference
  arrivedAt:  { type: Date, required: true },
  notes:      { type: String, trim: true, default: '' }, // general notes on arrival

  // ── GOODS LIST ────────────────────────────────────────────────────────────────
  items: {
    type: [{
      description: { type: String, required: true, trim: true },
      quantity:    { type: Number, required: true, min: 0 },
      unit:        { type: String, required: true, trim: true, default: 'bags' },
      notes:       { type: String, trim: true, default: '' },
      _id: false
    }],
    validate: {
      validator: (arr) => arr && arr.length > 0,
      message: 'At least one item is required'
    }
  },

  // ── STATUS ────────────────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['pending', 'processed'],
    default: 'pending'
  },

  // ── PROCESSING RECORD (filled when status → processed) ───────────────────────
  processedAt:    { type: Date, default: null },
  processedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  processedNotes: { type: String, trim: true, default: '' },

  // ── RECONCILIATION LINK ───────────────────────────────────────────────────────
  // Populated by stock.service.js#addDelivery when a delivery is recorded against
  // this intake (optional sourceIntakeId param) — lets an admin see what this raw
  // arrival actually became in sellable stock, and whether anything was ever applied.
  linkedDeliveries: {
    type: [{
      productId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
      varietyName:   { type: String, required: true },
      packagingSize: { type: String, required: true },
      quantity:      { type: Number, required: true },
      performedBy:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      appliedAt:     { type: Date, default: Date.now },
      _id: false
    }],
    default: []
  },

  // ── AUDIT ─────────────────────────────────────────────────────────────────────
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, {
  timestamps: true,
  versionKey: false
});

// Compound uniqueness: intakeRef per branch
stockIntakeSchema.index({ branchId: 1, intakeRef: 1 }, { unique: true });
stockIntakeSchema.index({ branchId: 1, status: 1 });
stockIntakeSchema.index({ branchId: 1, arrivedAt: -1 });

module.exports = mongoose.model('StockIntake', stockIntakeSchema);
