const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true,
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true,
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    match: [/^\S+@\S+\.\S+$/, 'Please use a valid email address'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false, // Don't return password in queries by default
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },
  avatarUrl: String,
  gmailConnected: {
    type: Boolean,
    default: false,
  },
  googleRefreshToken: {
    type: String,
    select: false,
  },
  /**
   * The Gmail address that was actually authorised, which may differ from the
   * OneSpace login email. Pub/Sub notifications identify a mailbox by this
   * address, so matching on `email` alone silently drops their notifications.
   */
  gmailAddress: {
    type: String,
    lowercase: true,
    default: null,
    index: true,
  },
  expenseAutomationEnabled: {
    type: Boolean,
    default: false,
  },
  expenseAutomationBanks: {
    type: [String],
    default: [],
  },
  gmailWatchExpiry: {
    type: Date,
    default: null,
  },
  gmailHistoryId: {
    type: String,
    default: null,
  },
  /**
   * Scopes Google actually granted, as reported by the token response.
   *
   * Stored because Google's consent screen lets the user untick Gmail access
   * while still completing the flow — without this we cannot tell a genuinely
   * connected account from one that will 403 on every request.
   */
  gmailScopes: {
    type: [String],
    default: [],
  },
  gmailConnectedAt: {
    type: Date,
    default: null,
  },
  gmailLastSyncAt: {
    type: Date,
    default: null,
  },
  /**
   * Why the last Gmail operation failed, so the UI can say something better than
   * "not connected" — which is indistinguishable from "never connected" and is
   * exactly what left users re-authorising in a loop.
   */
  gmailLastError: {
    code: { type: String, default: null },
    message: { type: String, default: null },
    at: { type: Date, default: null },
  },
}, { timestamps: true });

// Pre-save hook to hash passwords before saving to the database
userSchema.pre('save', async function() {
  // Only hash if the password was modified or is new
  if (!this.isModified('password')) return;
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Method to verify passwords during login
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
