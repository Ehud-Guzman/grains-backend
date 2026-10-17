const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { AppError } = require('../middleware/errorHandler.middleware');

// The Control Center's far-reaching actions (signing everyone out, locking a branch,
// maintenance mode) ask the superadmin for their password again. A stolen or left-open
// session can then browse the Control Center but cannot pull its big levers.
//
// 403, never 401: the frontend treats a 401 as "session expired" and tries to refresh or
// log out, which is the wrong response to a mistyped password.
const confirmPassword = async (userId, password) => {
  if (!password || typeof password !== 'string') {
    throw new AppError('Enter your password to confirm this action.', 403, 'PASSWORD_REQUIRED');
  }
  const user = await User.findById(userId).select('passwordHash').lean();
  const ok = user && await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    throw new AppError('That password is not correct.', 403, 'PASSWORD_INCORRECT');
  }
};

module.exports = { confirmPassword };
