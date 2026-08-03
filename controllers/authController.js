const User = require('../models/User');
const jwt = require('jsonwebtoken');
const config = require('../config/index');
const { OAuth2Client } = require('google-auth-library');
const { google } = require('googleapis');
const crypto = require('crypto');
const AppError = require('../utils/AppError');
const { encryptSecret } = require('../utils/crypto.util');
const { classifyGoogleError, hasGmailReadScope, GMAIL_READONLY_SCOPE } = require('../utils/google-error.util');
const { recordGmailError, recordGmailSyncSuccess, failureFromStats } = require('../utils/gmail-state.util');

const getGoogleClientConfig = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId) {
    throw AppError.badRequest('Google authentication is not configured');
  }

  return { clientId, clientSecret };
};

// ── OAuth `state` ────────────────────────────────────────────────────────────
//
// The redirect URI must be byte-identical in the authorize request and the token
// exchange or Google answers `redirect_uri_mismatch`. It used to be computed
// independently by the browser at two different moments (`window.location.origin +
// pathname`), so any drift between them — a trailing slash, a redirect, a
// different entry path — broke the exchange with an error the user never saw.
//
// Carrying it inside a signed `state` means the value that comes back is provably
// the value we authorised with. Signing also pins the state to one user, which is
// the standard OAuth CSRF defence this flow was missing entirely.

const signState = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', config.jwt.secret).update(body).digest('base64url');
  return `${body}.${mac}`;
};

/**
 * Verifies and decodes an OAuth state parameter.
 * @param {string} state
 * @returns {{redirectUri: string, userId: string}|null} null when absent, malformed, or tampered with
 */
const verifyState = (state) => {
  if (!state || typeof state !== 'string') return null;

  const [body, mac] = state.split('.');
  if (!body || !mac) return null;

  const expected = crypto.createHmac('sha256', config.jwt.secret).update(body).digest('base64url');
  const given = Buffer.from(mac);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

// Helper to generate JWT token
const generateToken = (id) => {
  return jwt.sign({ id }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
};

/**
 * @desc    Register a new user
 * @route   POST /api/auth/register
 * @access  Public
 */
exports.registerUser = async (req, res, next) => {
  try {
    const { firstName, lastName, email, password } = req.body;

    const userExists = await User.findOne({ email });
    if (userExists) {
      return res.status(400).json({ status: 'error', message: 'User already exists' });
    }

    const user = await User.create({
      firstName,
      lastName,
      email,
      password,
    });

    if (user) {
      res.status(201).json({
        status: 'success',
        data: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
          token: generateToken(user._id),
        }
      });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Authenticate user & get token
 * @route   POST /api/auth/login
 * @access  Public
 */
exports.loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Find user and explicitly select password since it's hidden by default
    const user = await User.findOne({ email }).select('+password');

    if (user && (await user.matchPassword(password))) {
      res.json({
        status: 'success',
        data: {
          id: user._id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          role: user.role,
          token: generateToken(user._id),
        }
      });
    } else {
      res.status(401).json({ status: 'error', message: 'Invalid email or password' });
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Authenticate with Google OAuth ID Token
 * @route   POST /api/auth/google
 * @access  Public
 */
exports.googleAuth = async (req, res, next) => {
  try {
    const { token } = req.body;
    const { clientId } = getGoogleClientConfig();

    if (!token) {
      return res.status(400).json({ status: 'error', message: 'Google ID token is required' });
    }

    const client = new OAuth2Client(clientId);

    // Verify the Google token payload
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    const { email, given_name, family_name, picture } = payload;

    if (!email) {
      return next(AppError.badRequest('Google account email is required'));
    }

    // Check if user already exists
    let user = await User.findOne({ email });

    if (!user) {
      // Create a new user. Generate a random secure dummy password to satisfy DB schema.
      const secureRandomPassword = crypto.randomBytes(32).toString('hex');
      user = await User.create({
        firstName: given_name || 'User',
        lastName: family_name || 'Account',
        email,
        password: secureRandomPassword,
        avatarUrl: picture,
      });
    } else if (!user.avatarUrl && picture) {
      // Optionally update their avatar if they didn't have one
      user.avatarUrl = picture;
      await user.save();
    }

    // Return the standard local JWT token
    res.json({
      status: 'success',
      data: {
        id: user._id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
        token: generateToken(user._id),
      }
    });
  } catch (error) {
    console.error('Google Auth Error:', error);
    next(error);
  }
};

/**
 * @desc    Build the Google consent URL for connecting a Gmail mailbox
 * @route   GET /api/auth/google/url?redirectUri=...
 * @access  Private
 */
exports.getGoogleAuthUrl = (req, res, next) => {
  try {
    const redirectUri = req.query.redirectUri || 'http://localhost:4200/expenses';
    const { clientId, clientSecret } = getGoogleClientConfig();

    if (!clientSecret) {
      return next(AppError.badRequest(
        'Gmail connection is not configured on the server (GOOGLE_CLIENT_SECRET is missing).'
      ));
    }

    const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      // Forces a fresh refresh token even when the user has consented before.
      // Without it Google returns none on re-authorisation and the connection
      // silently ends up with no usable credential.
      prompt: 'consent',
      include_granted_scopes: true,
      // Steer the consent screen at the account they are signed in as, so they
      // do not authorise a different mailbox than the one holding their alerts.
      login_hint: req.user?.email,
      scope: [GMAIL_READONLY_SCOPE, 'email', 'profile'],
      state: signState({
        redirectUri,
        userId: String(req.user.id),
        nonce: crypto.randomBytes(8).toString('hex'),
      }),
    });

    res.json({ status: 'success', data: { url, redirectUri } });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Exchange the OAuth code and store the mailbox credential
 * @route   POST /api/auth/google/connect
 * @access  Private
 *
 * Every failure path here returns a specific, actionable message. Previously a
 * rejected exchange escaped as a raw Google error, which the global handler
 * rewrote to "An unexpected internal server error occurred!" — leaving the user
 * to retry the same broken flow indefinitely with no idea what was wrong.
 */
exports.connectGmail = async (req, res, next) => {
  try {
    const { code, state } = req.body;
    const { clientId, clientSecret } = getGoogleClientConfig();

    if (!clientSecret) {
      return next(AppError.badRequest('Gmail connection is not configured on the server.'));
    }
    if (!code) {
      return next(AppError.badRequest('Missing Google authorization code.'));
    }

    // Prefer the signed state — it is the only redirect URI we can prove matches
    // the one Google authorised. `req.body.redirectUri` remains as a fallback so
    // a browser tab loaded before this deploy still completes.
    const decodedState = verifyState(state);
    if (state && !decodedState) {
      return next(AppError.badRequest(
        'The Google sign-in response could not be verified. Please start the connection again.'
      ));
    }
    if (decodedState && decodedState.userId !== String(req.user.id)) {
      return next(AppError.badRequest(
        'This Google sign-in was started by a different account. Please start the connection again.'
      ));
    }

    const redirectUri = decodedState?.redirectUri || req.body.redirectUri || 'http://localhost:4200/expenses';
    const oauth2Client = new OAuth2Client(clientId, clientSecret, redirectUri);

    // ── 1. Exchange the one-time code ──
    let tokens;
    try {
      ({ tokens } = await oauth2Client.getToken(code));
    } catch (exchangeErr) {
      const failure = classifyGoogleError(exchangeErr);
      console.error(`[Gmail Setup] Code exchange failed for ${req.user.email} (${failure.code}): ${failure.raw}`);

      // An already-used or expired code is harmless when the credential is
      // already stored — that is a replayed callback, not a broken connection.
      if (failure.code === 'invalid_grant') {
        const existing = await User.findById(req.user.id).select('+googleRefreshToken');
        if (existing?.googleRefreshToken && existing.gmailConnected) {
          return res.json({
            status: 'success',
            message: 'Gmail is already connected.',
            data: { code: 'already_connected', gmailConnected: true },
          });
        }
      }

      await recordGmailError(req.user.id, failure);
      return next(new AppError(failure.message, 400, failure.code.toUpperCase(), {
        redirectUri,
        hint: failure.code === 'redirect_uri_mismatch' ? redirectUri : undefined,
      }));
    }

    oauth2Client.setCredentials(tokens);

    // ── 2. Confirm Gmail access was actually granted ──
    //
    // Google's consent screen shows Gmail access as its own checkbox. Unticking it
    // still yields a valid token and a refresh token, so the connection "succeeds"
    // and then fails on every subsequent read. Catching it here is the difference
    // between one clear message and an endless reconnect loop.
    //
    // `tokens.scope` is absent on some re-authorisations; only reject when Google
    // told us the scopes and Gmail was not among them.
    if (tokens.scope && !hasGmailReadScope(tokens.scope)) {
      const failure = {
        code: 'insufficient_scope',
        message: 'Gmail permission was not granted. Please connect again and leave the "Read your email messages and settings" checkbox ticked.',
      };
      await recordGmailError(req.user.id, failure);
      return next(new AppError(failure.message, 400, 'INSUFFICIENT_SCOPE', {
        grantedScopes: String(tokens.scope).split(/\s+/),
      }));
    }

    // ── 3. Prove the credential works, and learn which mailbox it is ──
    //
    // Pub/Sub identifies a mailbox by its Gmail address, which need not equal the
    // OneSpace login email. A live call also verifies the Gmail API is enabled and
    // the token is usable *before* we advertise the account as connected.
    let gmailAddress = null;
    try {
      const profile = await google.gmail({ version: 'v1', auth: oauth2Client })
        .users.getProfile({ userId: 'me' });
      gmailAddress = profile.data.emailAddress || null;
    } catch (profileErr) {
      const failure = classifyGoogleError(profileErr);
      console.error(`[Gmail Setup] Verification call failed for ${req.user.email} (${failure.code}): ${failure.raw}`);
      await recordGmailError(req.user.id, failure);
      return next(new AppError(failure.message, 400, failure.code.toUpperCase()));
    }

    // ── 4. Persist ──
    const update = {
      gmailConnected: true,
      expenseAutomationEnabled: true,
      gmailConnectedAt: new Date(),
      gmailLastError: { code: null, message: null, at: null },
      // A reconnect is an explicit "start over". Carrying a cooldown across it
      // would silently skip the initial sync and look like the connect failed.
      gmailRetryAfter: null,
      // Likewise for the sync state. A watermark left over from a previous
      // connection would put the first incremental run after reconnecting past
      // everything that arrived in between.
      gmailSyncWatermark: null,
      gmailSyncLockedAt: null,
      gmailLastSweepMissed: 0,
      ...(gmailAddress ? { gmailAddress } : {}),
      ...(tokens.scope ? { gmailScopes: String(tokens.scope).split(/\s+/) } : {}),
    };

    if (tokens.refresh_token) {
      update.googleRefreshToken = encryptSecret(tokens.refresh_token);
    } else {
      // Google issues a refresh token only when it feels like it. Marking the
      // account connected without one produces a user whose every sync no-ops.
      const existing = await User.findById(req.user.id).select('+googleRefreshToken');
      if (!existing?.googleRefreshToken) {
        const failure = {
          code: 'no_refresh_token',
          message: 'Google did not return a long-lived token. Open your Google Account → Security → Third-party access, remove OneSpace, then connect again.',
        };
        console.warn(`[Gmail Setup] No refresh token for ${req.user.email} and none stored. Refusing to mark connected.`);
        await recordGmailError(req.user.id, failure);
        return next(new AppError(failure.message, 400, 'NO_REFRESH_TOKEN'));
      }
    }

    const updatedUser = await User.findByIdAndUpdate(req.user.id, update, { new: true })
      .select('+googleRefreshToken +gmailAccessToken');

    // ── 5. Answer now; sync in the background ──
    //
    // The initial sync walks every matching message one API call at a time. Doing
    // it before responding kept the request open long enough for the browser or
    // Render's gateway to time out — the credential was saved, but the user saw a
    // failure and reconnected, over and over.
    res.json({
      status: 'success',
      message: 'Gmail connected successfully',
      data: {
        code: 'connected',
        gmailConnected: true,
        gmailAddress,
        initialSyncStarted: true,
      },
    });

    setImmediate(() => { void runPostConnectTasks(updatedUser); });
  } catch (error) {
    console.error('Connect Gmail Error:', error);
    next(error);
  }
};

/**
 * Initial sync + push-notification subscription, run after the response is sent.
 * Failures are recorded on the user rather than thrown — the connection itself
 * already succeeded, and neither task is required for the manual sync to work.
 * @param {object} user
 */
async function runPostConnectTasks(user) {
  try {
    const engine = require('../automation/engine');
    const stats = await engine.processUserEmails(user, { mode: 'full', reason: 'connect' });
    console.log(`[Gmail Setup] Initial sync for ${user.email}:`, JSON.stringify(stats));

    if (stats.ok) {
      await recordGmailSyncSuccess(user._id);

      // A busy week can exceed one run's fetch cap. Hand the rest to the worker
      // so the account finishes filling in on its own.
      if (stats.remaining > 0) {
        const { enqueueSync } = require('../automation/gmail/sync-queue');
        await enqueueSync(user._id, { full: true, reason: 'backlog' });
      }
    } else {
      await recordGmailError(user._id, failureFromStats(stats));
    }
  } catch (syncErr) {
    console.error(`[Gmail Setup] Initial sync crashed for ${user.email}:`, syncErr.message);
  }

  try {
    const { activateWatch } = require('../automation/gmail/gmail-watch-manager');
    await activateWatch(user);
    console.log(`[Gmail Setup] Activated real-time push notifications for ${user.email}`);
  } catch (watchErr) {
    // Push is an optimisation; the manual Refresh button works without it.
    const failure = classifyGoogleError(watchErr);
    console.error(`[Gmail Setup] Push notifications unavailable for ${user.email} (${failure.code}): ${failure.raw}`);
  }
}
