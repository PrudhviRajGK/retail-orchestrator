require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require("openai");

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Supabase Clients
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("❌ Missing Supabase environment variables");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  }
});

// OpenAI Client
let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
  console.warn("⚠️ OpenAI API key not found. AI features will be limited.");
}

// JSON Data Files (with fallbacks)
let promotions = [];
let loyaltyRules = {};
let fulfillmentRules = {};

try {
  promotions = require("./promotions.json");
} catch (err) {
  console.warn("⚠️ promotions.json not found, using empty array");
}

try {
  loyaltyRules = require("./loyalty_rules.json");
} catch (err) {
  console.warn("⚠️ loyalty_rules.json not found, using default");
  loyaltyRules = {
    tiers: {
      bronze: { max_discount_percent: 5, points_multiplier: 1 },
      silver: { max_discount_percent: 10, points_multiplier: 1.2 },
      gold: { max_discount_percent: 15, points_multiplier: 1.5 },
      platinum: { max_discount_percent: 20, points_multiplier: 2 }
    },
    earn_rate: { per_rpee: 0.1 }
  };
}

try {
  fulfillmentRules = require("./fulfillment_rules.json");
} catch (err) {
  console.warn("⚠️ fulfillment_rules.json not found, using default");
  fulfillmentRules = {
    delivery: {
      default_eta_days: 3,
      slot_windows: ["10am-12pm", "2pm-4pm", "6pm-8pm"]
    }
  };
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

/**
 * JWT Verification Middleware
 * Extracts and validates JWT from Authorization header
 */
async function verifyUser(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      return res.status(401).json({ 
        error: "Missing authorization token",
        reply: "Please log in to continue."
      });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    
    if (!token) {
      return res.status(401).json({ 
        error: "Invalid token format",
        reply: "Authentication failed. Please log in again."
      });
    }

    // Verify token with Supabase Auth
    const { data, error } = await supabase.auth.getUser(token);
    
    if (error || !data?.user) {
      console.error("JWT verification failed:", error?.message || "No user data");
      return res.status(401).json({ 
        error: "Invalid or expired token",
        reply: "Your session has expired. Please log in again."
      });
    }

    // Attach user to request
    req.authUser = data.user;
    next();
    
  } catch (err) {
    console.error("Middleware error:", err);
    return res.status(500).json({ 
      error: "Authentication server error",
      reply: "Something went wrong. Please try again."
    });
  }
}

// ============================================================================
// DATABASE HELPER FUNCTIONS
// ============================================================================

/**
 * Fetch customer by auth_user_id
 */
async function fetchCustomer(authUserId) {
  try {
    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .eq("auth_user_id", authUserId)
      .single();

    if (error) {
      console.error("Fetch customer error:", error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.error("Fetch customer exception:", err);
    return null;
  }
}

/**
 * Fetch customer by customer ID
 */
async function fetchCustomerById(customerId) {
  try {
    const { data, error } = await supabase
      .from("customers")
      .select("*")
      .eq("id", customerId)
      .single();

    if (error) {
      console.error("Fetch customer by ID error:", error.message);
      return null;
    }

    return data;
  } catch (err) {
    console.error("Fetch customer by ID exception:", err);
    return null;
  }
}

/**
 * Update session context for customer
 */
async function updateCustomerChannel(customerId, channel, sessionContext = {}) {
  try {
    const { error } = await supabase
      .from("customers")
      .update({
        last_seen_channel: channel,
        session_context: sessionContext,
        updated_at: new Date().toISOString()
      })
      .eq("id", customerId);

    if (error) {
      console.error("Update customer channel error:", error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error("Update customer channel exception:", err);
    return false;
  }
}

/**
 * Save session history
 */
async function updateSession(customerId, channel, intent, context = {}) {
  try {
    const sessionId = `SESS-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    const { error } = await supabase
      .from("conversation_memory")
      .insert({
        session_id: sessionId,
        customer_id: customerId,
        channel: channel || "web",
        last_message: context.last_user_message || "",
        last_intent: intent || "",
        context: context,
        created_at: new Date().toISOString()
      });

    if (error) {
      console.error("Session update error:", error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error("Session update exception:", err);
    return false;
  }
}

/**
 * Get recent sessions for context
 */
async function getRecentSessions(customerId, limit = 5) {
  try {
    const { data, error } = await supabase
      .from("conversation_memory")
      .select("*")
      .eq("customer_id", customerId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("Get sessions error:", error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error("Get sessions exception:", err);
    return [];
  }
}

/**
 * Search products by category or occasion
 */
async function searchProducts(category = null, occasion = null) {
  try {
    let query = supabase.from("products").select("*");

    if (category) {
      query = query.eq("category", category);
    }

    if (occasion) {
      query = query.contains("attributes", { occasion: [occasion] });
    }

    const { data, error } = await query;
    
    if (error) {
      console.error("Product search error:", error.message);
      return [];
    }

    return data || [];
  } catch (err) {
    console.error("Product search exception:", err);
    return [];
  }
}

/**
 * Check inventory for SKUs
 */
async function checkInventory(skuList, customerStoreLocation = "Mumbai") {
  try {
    const { data, error } = await supabase
      .from("inventory")
      .select("*")
      .in("sku", skuList);

    if (error) {
      console.error("Inventory query error:", error.message);
      return [];
    }

    // Group by SKU
    const inventoryMap = {};
    
    (data || []).forEach(inv => {
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
        inventoryMap[inv.sku].onlineStock = inv.stock || 0;
      } else if (inv.location === customerStoreLocation) {
        inventoryMap[inv.sku].storeStock = inv.stock || 0;
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
  } catch (err) {
    console.error("Inventory check exception:", err);
    return [];
  }
}

/**
 * Create order
 */
async function createOrder(customer, skuList, fulfillmentMode, amount) {
  try {
    const orderId = "ORD-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6);

    const { data, error } = await supabase
      .from("orders")
      .insert({
        order_id: orderId,
        customer_id: customer.id,
        sku_list: skuList,
        total_amount: amount,
        status: "pending",
        fulfillment_mode: fulfillmentMode,
        store_location: customer.store_location,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error("Order insert error:", error.message);
      return null;
    }

    return orderId;
  } catch (err) {
    console.error("Create order exception:", err);
    return null;
  }
}

/**
 * Log payment transaction
 */
async function logPayment(orderId, customerId, amount, status, message, method = "upi") {
  try {
    const txnId = "TXN-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6);

    const { error } = await supabase
      .from("payment_transactions")
      .insert({
        txn_id: txnId,
        order_id: orderId,
        customer_id: customerId,
        status,
        method,
        amount,
        message,
        created_at: new Date().toISOString()
      });

    if (error) {
      console.error("Payment logging error:", error.message);
      return null;
    }

    return txnId;
  } catch (err) {
    console.error("Log payment exception:", err);
    return null;
  }
}

/**
 * Update customer spend
 */
async function updateCustomerSpend(customerId, increment) {
  try {
    // First get current spend
    const { data: customer } = await supabase
      .from("customers")
      .select("total_spend")
      .eq("id", customerId)
      .single();

    const currentSpend = customer?.total_spend || 0;
    const newSpend = currentSpend + increment;

    const { error } = await supabase
      .from("customers")
      .update({
        total_spend: newSpend,
        updated_at: new Date().toISOString()
      })
      .eq("id", customerId);

    if (error) {
      console.error("Update customer spend error:", error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error("Update customer spend exception:", err);
    return false;
  }
}

// ============================================================================
// ORCHESTRATOR LOGIC
// ============================================================================

/**
 * Classify user intent using LLM or fallback
 */
async function classifyIntent(userQuery, customer, recentSessions) {
  // Default intent structure
  const defaultIntent = {
    intent: "recommend",
    target_skus: [],
    occasion: null,
    payment_method: null,
    fulfillment_mode: null
  };

  // If no OpenAI, use keyword-based classification
  if (!openai) {
    const lowerQuery = userQuery.toLowerCase();
    
    if (lowerQuery.includes("stock") || lowerQuery.includes("available") || lowerQuery.includes("inventory")) {
      return { ...defaultIntent, intent: "check_inventory" };
    }
    
    if (lowerQuery.includes("buy") || lowerQuery.includes("purchase") || lowerQuery.includes("checkout") || lowerQuery.includes("pay")) {
      return { ...defaultIntent, intent: "checkout" };
    }
    
    if (lowerQuery.includes("order") || lowerQuery.includes("status") || lowerQuery.includes("track") || lowerQuery.includes("return")) {
      return { ...defaultIntent, intent: "post_purchase" };
    }
    
    if (lowerQuery.includes("hi") || lowerQuery.includes("hello") || lowerQuery.includes("hey")) {
      return { ...defaultIntent, intent: "smalltalk" };
    }
    
    return defaultIntent;
  }

  // Use OpenAI for intent classification
  try {
    const systemPrompt = `You are the Sales Orchestrator for an omnichannel fashion retailer.
Classify the user's intent from their message.

Possible intents:
- "recommend": asking for suggestions, styles, outfits, what to buy
- "check_inventory": asking about stock, availability, in-store pickup
- "checkout": ready to buy, pay, place order, reserve
- "post_purchase": order status, returns, exchanges, tracking
- "smalltalk": greetings, thank you, chit-chat

Return valid JSON in this exact format:
{
  "intent": "recommend",
  "target_skus": [],
  "occasion": null,
  "payment_method": null,
  "fulfillment_mode": null
}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `User message: "${userQuery}"
Customer tier: ${customer?.loyalty_tier || "unknown"}
Last channel: ${customer?.last_seen_channel || "unknown"}`
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 200
    });

    const jsonText = response.choices[0].message.content;
    const parsed = JSON.parse(jsonText);
    
    // Validate intent
    const validIntents = ["recommend", "check_inventory", "checkout", "post_purchase", "smalltalk"];
    if (!validIntents.includes(parsed.intent)) {
      parsed.intent = "recommend";
    }
    
    return parsed;
  } catch (err) {
    console.error("Intent classification failed:", err.message);
    return defaultIntent;
  }
}

/**
 * Main orchestrator function
 */
async function runRetailOrchestrator(user_query, customer_id, channel = "web") {
  try {
    // 1. Fetch customer
    const customer = await fetchCustomerById(customer_id);
    
    if (!customer) {
      return {
        reply: "I couldn't find your customer profile. Please contact support.",
        structured: { error: "Customer not found", plan: { intent: "error" } }
      };
    }

    // 2. Get session context
    const recentSessions = await getRecentSessions(customer_id, 3);
    const previousContext = customer.session_context || {};
    const lastChannel = customer.last_seen_channel;
    const channelSwitched = lastChannel && lastChannel !== channel;
    
    // Initialize session context
    let sessionContext = {
      cart: previousContext.cart || [],
      lastRecommended: previousContext.lastRecommended || null,
      lastBrowsedCategory: previousContext.lastBrowsedCategory || null,
      channel_switched: channelSwitched,
      previous_channel: lastChannel || null,
      current_channel: channel,
      persona_traits: previousContext.persona_traits || {}
    };

    // 3. Classify intent
    const plan = await classifyIntent(user_query, customer, recentSessions);
    
    let workerResult = {};
    let cart = sessionContext.cart || [];

    // 4. Route to worker agents based on intent
    switch (plan.intent) {
      case "recommend":
        const recs = await recommendationAgent(customer, user_query);
        workerResult.recommendations = recs;
        
        if (recs && recs.length > 0) {
          sessionContext.lastRecommended = {
            sku: recs[0].sku,
            name: recs[0].name,
            category: recs[0].category,
            price: recs[0].price
          };
          sessionContext.lastBrowsedCategory = recs[0].category;
        }
        break;

      case "check_inventory":
        const skuList = plan.target_skus.length > 0 
          ? plan.target_skus 
          : cart.map(i => i.sku);
        
        if (skuList.length > 0) {
          workerResult.inventory = await checkInventory(skuList, customer.store_location);
        } else {
          workerResult.inventory = [];
        }
        break;

      case "checkout":
        if (cart.length === 0) {
          workerResult.checkout = { error: "Cart is empty" };
        } else {
          const cartTotal = cart.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
          
          const loyalty = loyaltyAgent(customer, cartTotal, null);
          workerResult.loyalty = loyalty;

          const payment = await paymentAgent({
            customerId: customer.id,
            amount: loyalty.finalAmount,
            method: plan.payment_method || "upi"
          });
          
          workerResult.payment = payment;

          if (payment.status === "success") {
            const skuList = cart.map(i => i.sku);
            const orderId = await createOrder(
              customer,
              skuList,
              plan.fulfillment_mode || "reserve_in_store",
              loyalty.finalAmount
            );

            if (orderId) {
              await logPayment(
                orderId,
                customer.id,
                loyalty.finalAmount,
                payment.status,
                payment.message,
                plan.payment_method || "upi"
              );

              await updateCustomerSpend(customer.id, loyalty.finalAmount);

              const fulfillment = fulfillmentAgent({
                orderId,
                mode: plan.fulfillment_mode || "reserve_in_store",
                storeLocation: customer.store_location,
                slot: "6pm-8pm"
              });
              
              workerResult.fulfillment = fulfillment;
              cart = []; // Clear cart
              sessionContext.cart = cart;
              sessionContext.lastRecommended = null;
            }
          }
        }
        break;

      case "post_purchase":
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
        break;

      case "smalltalk":
        workerResult.smalltalk = {
          greeting: true,
          message: `Hello ${customer.name || "there"}! How can I help you today?`
        };
        break;
    }

    // 5. Save session
    await updateSession(customer.id, channel, plan.intent, {
      last_user_message: user_query,
      cart,
      plan,
      channel_switched: channelSwitched
    });

    // 6. Generate natural language response
    let replyText;
    
    if (!openai) {
      // Fallback response without AI
      switch (plan.intent) {
        case "recommend":
          if (workerResult.recommendations?.length > 0) {
            const item = workerResult.recommendations[0];
            replyText = `I found ${workerResult.recommendations.length} items. Here's one: ${item.name} for ₹${item.price}`;
          } else {
            replyText = "I couldn't find specific recommendations. Could you describe what you're looking for?";
          }
          break;
        case "checkout":
          if (cart.length === 0) {
            replyText = "Your cart is empty. Add some items first!";
          } else if (workerResult.payment?.status === "success") {
            replyText = `Payment successful! Order placed. ${workerResult.fulfillment?.message || "Thank you for your purchase!"}`;
          } else {
            replyText = "Ready to checkout! Your cart total is ₹" + 
              cart.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
          }
          break;
        default:
          replyText = `I understand you're asking about ${plan.intent}. How can I assist you further?`;
      }
    } else {
      // Generate AI response
      const channelAwareness = channelSwitched 
        ? `Note: Customer switched from ${lastChannel} to ${channel}. Acknowledge naturally if relevant.`
        : "";

      const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a friendly retail assistant. Be helpful, concise, and personal.
${channelAwareness}
Customer name: ${customer.name || "Customer"}
Loyalty tier: ${customer.loyalty_tier || "bronze"}`
          },
          {
            role: "user",
            content: `User: "${user_query}"
Intent: ${plan.intent}
Context: ${JSON.stringify(workerResult, null, 2)}`
          }
        ],
        temperature: 0.7,
        max_tokens: 300
      });

      replyText = response.choices[0].message.content;
    }

    // 7. Update customer context
    sessionContext.cart = cart;
    await updateCustomerChannel(customer.id, channel, sessionContext);

    return {
      reply: replyText,
      structured: {
        plan,
        workerResult,
        customer: {
          id: customer.id,
          name: customer.name,
          loyalty_tier: customer.loyalty_tier
        },
        sessionContext,
        channelSwitched
      }
    };

  } catch (err) {
    console.error("Orchestrator error:", err);
    return {
      reply: "I apologize, but I'm having trouble processing your request. Please try again or contact support.",
      structured: { error: err.message, plan: { intent: "error" } }
    };
  }
}

// ============================================================================
// WORKER AGENTS
// ============================================================================

async function recommendationAgent(customer, userQuery) {
  try {
    const lowerQ = userQuery.toLowerCase();
    let category = null;

    if (lowerQ.includes("shirt") || lowerQ.includes("top")) category = "shirts";
    else if (lowerQ.includes("pant") || lowerQ.includes("trouser")) category = "pants";
    else if (lowerQ.includes("shoe") || lowerQ.includes("sneaker") || lowerQ.includes("footwear")) category = "footwear";
    else if (lowerQ.includes("dress") || lowerQ.includes("gown")) category = "dresses";
    else if (lowerQ.includes("jean")) category = "jeans";
    else if (lowerQ.includes("jacket") || lowerQ.includes("coat")) category = "outerwear";

    const products = await searchProducts(category);
    return products.slice(0, 5);
  } catch (err) {
    console.error("Recommendation agent error:", err);
    return [];
  }
}

function loyaltyAgent(customer, cartTotal, couponCode) {
  try {
    const tier = customer.loyalty_tier || "bronze";
    const tierRules = loyaltyRules.tiers?.[tier] || { max_discount_percent: 5, points_multiplier: 1 };
    
    let discount = (cartTotal * tierRules.max_discount_percent) / 100;

    if (couponCode) {
      const promo = promotions.find(p => p.id === couponCode);
      if (promo?.flat_discount) discount += parseFloat(promo.flat_discount) || 0;
    }

    const finalAmount = Math.max(0, cartTotal - discount);
    const pointsEarned = cartTotal * (loyaltyRules.earn_rate?.per_rpee || 0.1) * tierRules.points_multiplier;

    return {
      discount,
      finalAmount,
      pointsEarned: Math.round(pointsEarned),
      loyaltyTier: tier
    };
  } catch (err) {
    console.error("Loyalty agent error:", err);
    return {
      discount: 0,
      finalAmount: cartTotal,
      pointsEarned: 0,
      loyaltyTier: customer.loyalty_tier || "bronze"
    };
  }
}

async function paymentAgent({ customerId, amount, method = "upi" }) {
  try {
    // Simulate payment processing
    const fail = Math.random() < 0.1; // 10% failure rate
    
    if (fail) {
      return {
        status: "declined",
        reason: "Payment gateway timeout",
        retry_supported: true,
        transactionId: null
      };
    }
    
    return {
      status: "success",
      transactionId: "TXN-" + Date.now() + "-" + Math.random().toString(36).substr(2, 8),
      message: "Payment processed successfully",
      method,
      amount
    };
  } catch (err) {
    console.error("Payment agent error:", err);
    return {
      status: "failed",
      reason: "Internal payment error",
      retry_supported: false
    };
  }
}

function fulfillmentAgent({ orderId, mode = "reserve_in_store", storeLocation = "Mumbai", slot = "6pm-8pm" }) {
  try {
    const fail = Math.random() < 0.05; // 5% failure rate
    
    if (fail) {
      return {
        status: "failed",
        reason: "Slot unavailable",
        alternate_slots: fulfillmentRules.delivery?.slot_windows || ["10am-12pm", "2pm-4pm", "6pm-8pm"]
      };
    }

    if (mode === "reserve_in_store" || mode === "click_and_collect") {
      return {
        status: "scheduled",
        orderId,
        pickupCode: "PICK-" + Math.floor(100000 + Math.random() * 900000),
        message: `Order reserved at ${storeLocation} for ${slot}`,
        mode,
        storeLocation
      };
    }

    return {
      status: "scheduled",
      orderId,
      deliveryEstimateDays: fulfillmentRules.delivery?.default_eta_days || 3,
      message: "Delivery scheduled successfully",
      mode
    };
  } catch (err) {
    console.error("Fulfillment agent error:", err);
    return {
      status: "failed",
      reason: "Fulfillment system error",
      retry_supported: true
    };
  }
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * GET /api/me - Get current user profile
 */
app.get("/api/me", verifyUser, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    
    const customer = await fetchCustomer(authUserId);
    
    if (!customer) {
      return res.status(404).json({ 
        error: "Customer profile not found",
        reply: "Please complete your profile setup."
      });
    }

    res.json({
      id: customer.id,
      name: customer.name,
      email: req.authUser.email,
      loyalty_tier: customer.loyalty_tier,
      store_location: customer.store_location,
      total_spend: customer.total_spend,
      last_seen_channel: customer.last_seen_channel
    });
    
  } catch (err) {
    console.error("GET /api/me error:", err);
    res.status(500).json({ 
      error: "Failed to fetch profile",
      reply: "Something went wrong. Please try again."
    });
  }
});

/**
 * GET /api/customers/:id - Get customer by ID (admin/testing)
 */
app.get("/api/customers/:id", async (req, res) => {
  try {
    const customer = await fetchCustomerById(req.params.id);
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }
    
    res.json(customer);
  } catch (err) {
    console.error("GET /api/customers/:id error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/products - Search products
 */
app.get("/api/products", async (req, res) => {
  try {
    const { category, occasion, limit = 20 } = req.query;
    
    let query = supabase
      .from("products")
      .select("*")
      .limit(parseInt(limit));

    if (category) {
      query = query.eq("category", category);
    }

    if (occasion) {
      query = query.contains("attributes", { occasion: [occasion] });
    }

    const { data, error } = await query;

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error("GET /api/products error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/products/:sku - Get product by SKU
 */
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
    console.error("GET /api/products/:sku error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/inventory/:sku - Check inventory
 */
app.get("/api/inventory/:sku", async (req, res) => {
  try {
    const { location } = req.query;
    
    let query = supabase
      .from("inventory")
      .select("*")
      .eq("sku", req.params.sku);

    if (location) {
      query = query.eq("location", location);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error("GET /api/inventory/:sku error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/cart - Add item to cart
 */
app.post("/api/cart", verifyUser, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    const { sku, qty = 1, price, channel = "web" } = req.body;
    
    if (!sku || !price) {
      return res.status(400).json({ 
        error: "Missing required fields: sku and price are required",
        reply: "Please provide product details."
      });
    }

    // Get customer
    const customer = await fetchCustomer(authUserId);
    
    if (!customer) {
      return res.status(404).json({ 
        error: "Customer not found",
        reply: "Please complete your profile first."
      });
    }

    // Load or initialize session context
    const sessionContext = customer.session_context || {};
    let cart = sessionContext.cart || [];

    // Add or update item in cart
    const existingItemIndex = cart.findIndex(item => item.sku === sku);
    
    if (existingItemIndex >= 0) {
      cart[existingItemIndex].qty += qty;
    } else {
      // Get product name for better UX
      const { data: product } = await supabase
        .from("products")
        .select("name")
        .eq("sku", sku)
        .single();
      
      cart.push({
        sku,
        qty,
        price,
        name: product?.name || "Product",
        added_at: new Date().toISOString()
      });
    }

    // Update session context
    const updatedContext = {
      ...sessionContext,
      cart,
      last_updated: new Date().toISOString()
    };

    // Save to database
    await updateCustomerChannel(customer.id, channel, updatedContext);

    const cartTotal = cart.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
    
    res.json({
      success: true,
      cart,
      cart_total: cartTotal,
      item_count: cart.length,
      message: "Item added to cart successfully"
    });
    
  } catch (err) {
    console.error("POST /api/cart error:", err);
    res.status(500).json({ 
      error: err.message,
      reply: "Failed to update cart. Please try again."
    });
  }
});

/**
 * GET /api/cart - Get cart contents
 */
app.get("/api/cart", verifyUser, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    
    const customer = await fetchCustomer(authUserId);
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const cart = customer.session_context?.cart || [];
    const cartTotal = cart.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
    
    res.json({
      cart,
      cart_total: cartTotal,
      item_count: cart.length
    });
    
  } catch (err) {
    console.error("GET /api/cart error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/cart/:sku - Remove item from cart
 */
app.delete("/api/cart/:sku", verifyUser, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    const { sku } = req.params;
    
    const customer = await fetchCustomer(authUserId);
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const sessionContext = customer.session_context || {};
    let cart = sessionContext.cart || [];

    // Remove item
    cart = cart.filter(item => item.sku !== sku);

    // Update session context
    const updatedContext = {
      ...sessionContext,
      cart,
      last_updated: new Date().toISOString()
    };

    await updateCustomerChannel(customer.id, "web", updatedContext);
    
    res.json({
      success: true,
      cart,
      message: "Item removed from cart"
    });
    
  } catch (err) {
    console.error("DELETE /api/cart/:sku error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/retail-orchestrator - Main chat endpoint
 */
app.post("/api/retail-orchestrator", verifyUser, async (req, res) => {
  try {
    console.log("🔵 Orchestrator called:", {
      user: req.authUser?.email,
      body: req.body
    });

    const { user_query, channel = "web" } = req.body;

    if (!user_query || typeof user_query !== 'string') {
      return res.status(400).json({
        reply: "Please provide a message to process.",
        structured: { error: "Missing or invalid user_query" }
      });
    }

    // Get customer
    const authUserId = req.authUser.id;
    const customer = await fetchCustomer(authUserId);
    
    if (!customer) {
      return res.status(404).json({
        reply: "I couldn't find your profile. Please complete your setup first.",
        structured: { error: "Customer not found" }
      });
    }

    console.log("🟡 Processing for customer:", customer.id, customer.name);

    // Run orchestrator
    const result = await runRetailOrchestrator(
      user_query.trim(),
      customer.id,
      channel
    );

    console.log("🟢 Orchestrator result:", {
      reply_length: result.reply?.length,
      intent: result.structured?.plan?.intent
    });

    res.json(result);
    
  } catch (err) {
    console.error("❌ POST /api/retail-orchestrator error:", err);
    
    res.status(500).json({
      reply: "I apologize, but I'm experiencing technical difficulties. Please try again in a moment.",
      structured: {
        error: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      }
    });
  }
});

/**
 * GET /api/health - Health check endpoint
 */
app.get("/api/health", async (req, res) => {
  try {
    // Check database connection
    const { error: dbError } = await supabase
      .from('customers')
      .select('count')
      .limit(1);

    // Check OpenAI if configured
    let openaiStatus = "not_configured";
    if (openai) {
      try {
        await openai.models.list();
        openaiStatus = "connected";
      } catch (err) {
        openaiStatus = "error";
      }
    }

    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      services: {
        database: dbError ? "error" : "connected",
        openai: openaiStatus,
        express: "running"
      },
      environment: process.env.NODE_ENV || "development"
    });
  } catch (err) {
    res.status(500).json({
      status: "unhealthy",
      error: err.message
    });
  }
});

/**
 * GET / - Root endpoint
 */
app.get("/", (req, res) => {
  res.json({
    name: "Retail Orchestrator API",
    version: "1.0.0",
    status: "running",
    endpoints: {
      auth: "/api/me (GET)",
      chat: "/api/retail-orchestrator (POST)",
      cart: "/api/cart (GET, POST, DELETE)",
      products: "/api/products (GET)",
      health: "/api/health (GET)"
    },
    documentation: "See README for API usage"
  });
});

// ============================================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    path: req.path,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("🚨 Global error handler:", err);
  
  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === 'development' ? err.message : "Something went wrong",
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// ============================================================================
// SERVER START
// ============================================================================

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, async () => {
  console.log(`
🚀 Retail Orchestrator Backend Started!
────────────────────────────────────────
✅ Server: http://${HOST}:${PORT}
✅ Health: http://${HOST}:${PORT}/api/health
✅ Environment: ${process.env.NODE_ENV || 'development'}
────────────────────────────────────────
📊 Endpoints:
   GET  /                    - API info
   GET  /api/health          - Health check
   GET  /api/me              - User profile (requires auth)
   POST /api/cart            - Add to cart (requires auth)
   GET  /api/cart            - View cart (requires auth)
   POST /api/retail-orchestrator - Chat endpoint (requires auth)
   GET  /api/products        - Browse products
────────────────────────────────────────
  `);

  // Test connections
  try {
    // Test Supabase
    const { data, error } = await supabase
      .from('customers')
      .select('count')
      .limit(1);
    
    if (error) {
      console.warn('⚠️  Supabase connection test failed:', error.message);
    } else {
      console.log('✅ Supabase connection successful');
    }

    // Test OpenAI if configured
    if (openai) {
      try {
        await openai.models.list();
        console.log('✅ OpenAI connection successful');
      } catch (err) {
        console.warn('⚠️  OpenAI connection failed:', err.message);
      }
    }
  } catch (err) {
    console.warn('⚠️  Initial connection tests failed:', err.message);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

module.exports = app;