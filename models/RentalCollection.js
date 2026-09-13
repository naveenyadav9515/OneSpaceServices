const mongoose = require('mongoose');

const TENANTS = ['Mahesh', 'Sai', 'Geetha', 'Prasad', 'Rekha'];

/**
 * RentalCollection — Tracks rent payments collected from individual tenants.
 * Completely isolated from the regular expense tracker.
 */
const rentalCollectionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tenant: {
      type: String,
      required: true,
      enum: TENANTS,
      trim: true,
    },
    amount: {
      type: Number,
      required: [true, 'Please provide an amount'],
      min: [0.01, 'Amount must be greater than 0'],
    },
    notes: {
      type: String,
      trim: true,
      default: '',
      maxlength: [500, 'Notes cannot exceed 500 characters'],
    },
    date: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

rentalCollectionSchema.index({ user: 1, date: -1 });
rentalCollectionSchema.index({ user: 1, tenant: 1, date: -1 });

const RentalCollection = mongoose.model('RentalCollection', rentalCollectionSchema);
RentalCollection.TENANTS = TENANTS;

module.exports = RentalCollection;
