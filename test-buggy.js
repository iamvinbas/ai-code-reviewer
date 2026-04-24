// User session manager

const sessions = {};

// Bug 1: Off-by-one — expires sessions that are still valid
function isSessionExpired(session) {
  const now = Date.now();
  return now - session.createdAt >= session.ttl; // should be >
}

// Bug 2: Memory leak — sessions never cleaned up
function createSession(userId, ttl = 3600000) {
  const token = Math.random().toString(36).substring(2);
  sessions[token] = { userId, createdAt: Date.now(), ttl };
  return token;
}

// Bug 3: Race condition — read-modify-write not atomic
async function incrementLoginCount(userId) {
  const current = await db.get(`login_count:${userId}`);
  await db.set(`login_count:${userId}`, current + 1);
}

// Bug 4: Prototype pollution
function mergeConfig(defaults, userConfig) {
  for (const key in userConfig) {
    defaults[key] = userConfig[key];
  }
  return defaults;
}

// Bug 5: Silent error swallow
async function getUserData(userId) {
  try {
    const data = await db.find(userId);
    return data;
  } catch (e) {
    return null; // caller gets null, no idea why
  }
}

// Bug 6: Weak token — Math.random not cryptographically secure
function generateResetToken() {
  return Math.random().toString(36).substring(2, 15);
}

module.exports = {
  isSessionExpired,
  createSession,
  incrementLoginCount,
  mergeConfig,
  getUserData,
  generateResetToken,
};
