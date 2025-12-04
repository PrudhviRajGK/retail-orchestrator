require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require("openai");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Initialize Supabase with SERVICE ROLE KEY for RLS bypass in backend
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Initialize OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Fallback JSON data (keep for promotions and rules that don't change often)
const promotions = require("./promotions.json");
const loyaltyRules = require("./loyalty_rules.json");
const fulfillmentRules = require("./fulfillment_rules.json");

/*
 |--------------------------------------------------------------------------
 | DATABASE HELPER FUNCTIONS
 |--------------------------------------------------------------------------
*/

async function fetchCustomer(id) {
  const { data, error } = await supabase
    .from("customers")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("Fetch customer error:", error);
    return null;
  }

  return data;
}

async function updateSession(customerId, channel, intent, context = {}) {
  const { data, error } = await supabase
    .from("session_history")
    .insert({
      session_id: `SESS-${Date.now()}`,
      customer_id: customerId,
      channel,
      last_message: context.last_user_message || "",
      last_intent: intent || "",
      context,
      created_at: new Date().toISOString()
    });

  if (error) console.error("Session update error:", error);
  return data;
}

async function getRecentSessions(customerId, limit = 5) {
  const { data, error } = await supabase
    .from("session_history")
    .select("*")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Get sessions error:", error);
    return [];
  }

  return data;
}

async function searchProducts(category = null, occasion = null) {
  let query = supabase.from("products").select("*");

  if (category) {
    query = query.eq("category", category);
  }

  if (occasion) {
    query = query.contains("attributes", { occasion: [occasion] });
  }

  const { data, error } = await query;
  
  if (error) {
    console.error("Product search error:", error);
    return [];
  }

  return data;
}

async function checkInventory(skuList, customerStoreLocation) {
  const { data, error } = await supabase
    .from("inventory")
    .select("*")
    .in("sku", skuList);

  if (error) {
    console.error("Inventory query error:", error);
    return [];
  }

  // Group by SKU and calculate availability
  const inventoryMap = {};
  
  data.forEach(inv => {
    if (!inventoryMap[inv.sku]) {
      inventoryMap[inv.sku] = {
        sku: inv.sku,
        storeLocation: customerStoreLocation,
        onlineStock: 0,
        storeStock: 0,
        fulfillmentOptions: []
      };
    }

    if (inv.location === "online_warehouse") {
      inventoryMap[inv.sku].onlineStock = inv.stock;
    } else if (inv.location === customerStoreLocation) {
      inventoryMap[inv.sku].storeStock = inv.stock;
    }
  });

  // Determine fulfillment options
  Object.values(inventoryMap).forEach(item => {
    if (item.onlineStock > 0) {
      item.fulfillmentOptions.push("ship_to_home");
    }
    if (item.storeStock > 0) {
      item.fulfillmentOptions.push("click_and_collect", "reserve_in_store");
    }
    if (item.fulfillmentOptions.length === 0) {
      item.fulfillmentOptions.push("ship_to_home");
    }
  });

  return Object.values(inventoryMap);
}

async function createOrder(customer, skuList, fulfillmentMode, amount) {
  const orderId = "ORD-" + Date.now();

  const { data, error } = await supabase
    .from("orders")
    .insert({
      order_id: orderId,
      customer_id: customer.id,
      sku_list: skuList,
      total_amount: amount,
      status: "pending",
      fulfillment_mode: fulfillmentMode
    })
    .select()
    .single();

  if (error) {
    console.error("Order insert error:", error);
    return null;
  }

  return orderId;
}

async function logPayment(orderId, customerId, amount, status, message, method = "upi") {
  const txn = "TXN-" + Date.now();

  const { data, error } = await supabase
    .from("payment_transactions")
    .insert({
      txn_id: txn,
      order_id: orderId,
      customer_id: customerId,
      status,
      method,
      amount,
      message,
      created_at: new Date().toISOString()
    });

  if (error) {
    console.error("Payment logging error:", error);
    return null;
  }

  return txn;
}

async function updateCustomerSpend(customerId, increment) {
  const { data, error } = await supabase.rpc("increment_customer_spend", {
    user_id: customerId,
    add_value: increment
  });

  if (error) {
    console.error("Update customer spend error:", error);
  }
  
  return data;
}

// NEW: Update customer's last seen channel and session context
async function updateCustomerChannel(customerId, channel, sessionContext) {
  const { data, error } = await supabase
    .from("customers")
    .update({
      last_seen_channel: channel,
      session_context: sessionContext
    })
    .eq("id", customerId);

  if (error) {
    console.error("Update customer channel error:", error);
  }

  return data;
}

/*
 |--------------------------------------------------------------------------
 | ORCHESTRATOR LOGIC
 |--------------------------------------------------------------------------
*/

async function classifyIntent(userQuery, customer, recentSessions) {
  const systemPrompt = `
You are the Sales Orchestrator for an omnichannel fashion retailer.

Your job: From the user's message and context, decide what they are trying to do.

Possible intents:
- "recommend": they are asking what to buy, styles, outfits, suggestions.
- "check_inventory": they are asking if something is in stock or available at a store.
- "checkout": they are ready to buy / pay / place order / reserve.
- "post_purchase": they ask about order status, returns, exchange, tracking.
- "smalltalk": greetings or chit-chat, no need to call worker agents.

Return ONLY valid JSON in this shape:
{
  "intent": "...",
  "target_skus": [],
  "occasion": null,
  "payment_method": null,
  "fulfillment_mode": null
}
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `User message: "${userQuery}"
Customer: ${JSON.stringify(customer)}
Recent Sessions: ${JSON.stringify(recentSessions)}`
      }
    ],
    response_format: { type: "json_object" }
  });

  const jsonText = response.choices[0].message.content;
  return JSON.parse(jsonText);
}

async function runRetailOrchestrator({ user_query, end_user_id, channel }) {
  // 1) Fetch customer from database
  const customer = await fetchCustomer(end_user_id);
  
  if (!customer) {
    return {
      reply: "Sorry, I couldn't find your customer profile. Please check your customer ID.",
      structured: { error: "Customer not found" }
    };
  }

  // 2) Get recent session history for context
  const recentSessions = await getRecentSessions(end_user_id, 3);

  // 3) Detect channel switch
  const lastChannel = customer.last_seen_channel;
  const channelSwitched = lastChannel && lastChannel !== channel;
  
  // Get previous session context
  const previousContext = customer.session_context || {};
  
  // Initialize session context for current interaction
  let sessionContext = {
    cart: recentSessions[0]?.context?.cart || [],
    lastRecommended: previousContext.lastRecommended || null,
    lastBrowsedCategory: previousContext.lastBrowsedCategory || null,
    channel_switched: channelSwitched,
    previous_channel: lastChannel || null,
    current_channel: channel,
    persona_traits: previousContext.persona_traits || {}
  };

  // 4) Classify intent using LLM
  const plan = await classifyIntent(user_query, customer, recentSessions);
  console.log("Sales Agent Plan:", plan);

  let workerResult = {};
  let cart = sessionContext.cart;

  // 5) Route to worker agents based on intent
  if (plan.intent === "recommend") {
    const recs = await recommendationAgent(customer, user_query);
    workerResult.recommendations = recs;
    
    // Store last recommended item for continuity
    if (recs && recs.length > 0) {
      sessionContext.lastRecommended = {
        sku: recs[0].sku,
        name: recs[0].name,
        category: recs[0].category
      };
      sessionContext.lastBrowsedCategory = recs[0].category;
    }
  }

  if (plan.intent === "check_inventory") {
    const skuList = plan.target_skus.length
      ? plan.target_skus
      : cart.map(i => i.sku);
    
    if (skuList.length > 0) {
      workerResult.inventory = await checkInventory(skuList, customer.store_location);
    }
  }

  if (plan.intent === "checkout") {
    const cartTotal = cart.reduce((sum, item) => sum + item.price * item.qty, 0);

    const loyalty = loyaltyAgent(customer, cartTotal, null);
    workerResult.loyalty = loyalty;

    const payment = await paymentAgent({
      customerId: customer.id,
      amount: loyalty.finalAmount,
      method: plan.payment_method || "upi"
    });
    workerResult.payment = payment;

    if (payment.status === "success") {
      // Create order in database
      const orderId = await createOrder(
        customer,
        cart.map(i => i.sku),
        plan.fulfillment_mode || "reserve_in_store",
        loyalty.finalAmount
      );

      // Log payment transaction
      await logPayment(
        orderId,
        customer.id,
        loyalty.finalAmount,
        payment.status,
        payment.message,
        plan.payment_method || "upi"
      );

      // Update customer spending
      await updateCustomerSpend(customer.id, loyalty.finalAmount);

      const fulfillment = fulfillmentAgent({
        orderId,
        mode: plan.fulfillment_mode || "reserve_in_store",
        storeLocation: customer.store_location,
        slot: "6pm-8pm"
      });
      
      workerResult.fulfillment = fulfillment;
      cart = []; // Clear cart after successful checkout
      sessionContext.cart = cart;
      sessionContext.lastRecommended = null; // Reset after purchase
    }
  }

  if (plan.intent === "post_purchase") {
    const { data: recentOrders } = await supabase
      .from("orders")
      .select("*")
      .eq("customer_id", customer.id)
      .order("created_at", { ascending: false })
      .limit(1);

    workerResult.post_purchase = {
      message: recentOrders && recentOrders.length > 0
        ? `Your last order (${recentOrders[0].order_id}) is ${recentOrders[0].status}. It should arrive in 2–3 days.`
        : "I couldn't find any recent orders for your account."
    };
  }

  // 6) Save session to database
  await updateSession(customer.id, channel, plan.intent, {
    last_user_message: user_query,
    cart,
    plan,
    channel_switched: channelSwitched
  });

  // 7) Build channel awareness context for AI
  let channelAwarenessPrompt = "";
  
  if (channelSwitched && sessionContext.lastRecommended) {
    channelAwarenessPrompt = `
IMPORTANT OMNICHANNEL CONTEXT:
- Customer just switched from ${lastChannel} to ${channel}
- They were previously viewing: ${sessionContext.lastRecommended.name} (${sessionContext.lastRecommended.sku})
- Category: ${sessionContext.lastBrowsedCategory}

Acknowledge this channel switch naturally and reference their previous browsing if relevant.
Example: "Hey ${customer.name}, welcome ${channel === 'kiosk' ? 'at the kiosk' : channel === 'whatsapp' ? 'on WhatsApp' : 'back'}! I remember you were checking out ${sessionContext.lastRecommended.name} earlier."
`;
  } else if (channelSwitched) {
    channelAwarenessPrompt = `
OMNICHANNEL CONTEXT:
- Customer switched from ${lastChannel} to ${channel}
- Acknowledge this transition naturally if appropriate.
`;
  }

  // 8) Generate natural language response with omnichannel awareness
  const finalResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `
You are a friendly retail sales associate with omnichannel awareness.

OMNICHANNEL GUIDELINES:
- If the customer changed channels (app → kiosk → whatsapp → web), acknowledge it politely and naturally
- Reference their previous browsing or cart items to show continuity
- Keep acknowledgments brief and contextual - don't force it if not relevant
- Use natural language like "Hey [Name], welcome at the kiosk!" or "Good to see you on WhatsApp!"
- Never repeat old items unless they're still relevant to the current conversation

RESPONSE GUIDELINES:
- Write natural, concise replies
- Explain any discounts, inventory options, and next steps clearly
- Show you remember the customer's journey across channels
- Be helpful and personalized

${channelAwarenessPrompt}
`
      },
      {
        role: "user",
        content: `User message: "${user_query}"
Customer: ${JSON.stringify(customer)}
Agent plan: ${JSON.stringify(plan)}
Worker results: ${JSON.stringify(workerResult)}
Session context: ${JSON.stringify(sessionContext)}`
      }
    ]
  });

  let replyText = finalResponse.choices[0].message.content;

  // 9) Update customer's channel and session context (learning loop)
  await updateCustomerChannel(customer.id, channel, sessionContext);

  return {
    reply: replyText,
    structured: {
      plan,
      workerResult,
      customer,
      sessionContext,
      channelSwitched
    }
  };
}

/*
 |--------------------------------------------------------------------------
 | WORKER AGENTS
 |--------------------------------------------------------------------------
*/

async function recommendationAgent(customer, userQuery) {
  const lowerQ = userQuery.toLowerCase();
  let category = null;

  if (lowerQ.includes("shirt")) category = "shirts";
  else if (lowerQ.includes("shoes") || lowerQ.includes("sneakers")) category = "footwear";
  else if (lowerQ.includes("dress")) category = "dresses";

  const products = await searchProducts(category);
  return products.slice(0, 5);
}

function loyaltyAgent(customer, cartTotal, couponCode) {
  const tierRules = loyaltyRules.tiers[customer.loyalty_tier];
  let discount = (cartTotal * tierRules.max_discount_percent) / 100;

  const promo = promotions.find(p => p.id === couponCode);
  if (promo?.flat_discount) discount += promo.flat_discount;

  const finalAmount = cartTotal - discount;
  const pointsEarned =
    cartTotal * loyaltyRules.earn_rate.per_rpee * tierRules.points_multiplier;

  return { discount, finalAmount, pointsEarned };
}

async function paymentAgent({ customerId, amount, method }) {
  const fail = Math.random() < 0.15; // 15% failure rate for demo
  
  if (fail) {
    return {
      status: "declined",
      reason: "Gateway timeout",
      retry_supported: true
    };
  }
  
  return {
    status: "success",
    transactionId: "TXN-" + Date.now(),
    message: "Payment processed successfully"
  };
}

function fulfillmentAgent({ orderId, mode, storeLocation, slot }) {
  const fail = Math.random() < 0.1; // 10% failure rate
  
  if (fail) {
    return {
      status: "failed",
      reason: "Slot unavailable",
      alternate_slots: fulfillmentRules.delivery.slot_windows
    };
  }

  if (mode === "reserve_in_store" || mode === "click_and_collect") {
    return {
      status: "scheduled",
      orderId,
      pickupCode: "PICK-" + Math.floor(100000 + Math.random() * 900000),
      message: `Order reserved at ${storeLocation} for ${slot}`
    };
  }

  return {
    status: "scheduled",
    orderId,
    deliveryEstimateDays: fulfillmentRules.delivery.default_eta_days,
    message: "Delivery scheduled successfully"
  };
}

/*
 |--------------------------------------------------------------------------
 | REST API ENDPOINTS
 |--------------------------------------------------------------------------
*/

app.get("/api/customers/:id", async (req, res) => {
  try {
    const customer = await fetchCustomer(req.params.id);
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const products = await searchProducts(
      req.query.category,
      req.query.occasion
    );
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/products/:sku", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .eq("sku", req.params.sku)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/inventory/:sku", async (req, res) => {
  try {
    let query = supabase
      .from("inventory")
      .select("*")
      .eq("sku", req.params.sku);

    if (req.query.location) {
      query = query.eq("location", req.query.location);
    }

    const { data, error } = await query;

    if (error || !data || data.length === 0) {
      return res.status(404).json({ error: "No inventory found for SKU" });
    }

    const response = data.map(item => ({
      sku: item.sku,
      location: item.location,
      stock: item.stock,
      fulfillmentOptions:
        item.location === "online_warehouse"
          ? ["ship_to_home"]
          : item.stock > 0
          ? ["click_and_collect", "reserve_in_store"]
          : ["ship_to_home"]
    }));

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/retail-orchestrator", async (req, res) => {
  try {
    const { user_query, end_user_id, channel } = req.body;

    if (!user_query || !end_user_id) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const result = await runRetailOrchestrator({
      user_query,
      end_user_id,
      channel: channel || "web"
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      reply: "Sorry, something went wrong while processing your request. Please try again.",
      error: err.message
    });
  }
});

/*
 |--------------------------------------------------------------------------
 | SERVER START
 |--------------------------------------------------------------------------
*/

const PORT = process.env.PORT || 4000;

app.listen(PORT, async () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
  
  // Test Supabase connection
  try {
    const { data, error } = await supabase.from('customers').select('count');
    if (error) throw error;
    console.log('✅ Supabase connected successfully');
  } catch (error) {
    console.error('❌ Supabase connection failed:', error.message);
  }
});