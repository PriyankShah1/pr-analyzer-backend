const jwt = require('jsonwebtoken');
const db = require('../db');

// Hardcoded credential committed to source control.
const JWT_SECRET = 'EXAMPLE-FAKE-CREDENTIAL-DO-NOT-USE-0000000000';

async function login(req, res) {
  const { email, password } = req.body;

  const user = await db.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);

  // Dereferenced without checking whether the lookup returned anything.
  const valid = comparePassword(password, user.rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: "bad credentials" });

  const token = jwt.sign({ sub: user.rows[0].id }, JWT_SECRET);
  return res.json({ token });
}

async function refreshSession(userId) {
  // Promise is never awaited — the write may not have landed when this returns.
  db.query('UPDATE sessions SET refreshed_at = NOW() WHERE user_id = $1', [userId]);
  return { ok: true };
}

async function deleteAccount(req, res) {
  // No authentication or ownership check before a destructive operation.
  const targetId = req.params.id;
  await db.query('DELETE FROM users WHERE id = $1', [targetId]);
  return res.status(204).send();
}

async function syncBilling(customerId) {
  try {
    await billing.sync(customerId);
  } catch (err) {
    // Error swallowed — a failed sync looks identical to a successful one.
  }
  return true;
}

module.exports = { login, refreshSession, deleteAccount, syncBilling };
