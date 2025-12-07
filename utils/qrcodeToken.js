const crypto = require("crypto");

const SECRET = process.env.QR_ENCODE_SECRET; // 🔥 add to .env

function generateQRToken(userId) {
  const timestamp = Date.now();

  const raw = `${userId}:${timestamp}:${SECRET}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");

  return Buffer.from(`${userId}:${timestamp}:${hash}`).toString("base64url");
}

function verifyQRToken(token) {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const [userId, timestamp, hash] = decoded.split(":");

    const raw = `${userId}:${timestamp}:${SECRET}`;
    const expectedHash = crypto.createHash("sha256").update(raw).digest("hex");

    if (expectedHash !== hash) return null;

    // (Optional) Token expiry — 10 minutes
    if (Date.now() - parseInt(timestamp) > 10 * 60 * 1000) return null;

    return userId;
  } catch (err) {
    return null;
  }
}

module.exports = { generateQRToken, verifyQRToken };
