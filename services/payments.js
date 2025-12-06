const Razorpay = require("razorpay");

const razorpayInstance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * Creates a Razorpay order in TEST mode
 */
async function paymentOrder(amount) {
  try {
    const order = await razorpayInstance.orders.create({
      amount: amount * 100, // Razorpay expects paise
      currency: "INR",
      receipt: "rcpt_" + Date.now(),
      payment_capture: 1,
    });

    return order;
  } catch (err) {
    console.error("❌ Razorpay Order Error:", err);
    throw new Error("Failed to create order");
  }
}

module.exports = { paymentOrder };
