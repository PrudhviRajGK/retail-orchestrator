require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require("openai");
const MessagingResponse = require("twilio").twiml.MessagingResponse;
const { createJiraTicket } = require("./services/jira");
const { paymentOrder } = require("./services/payments");
const crypto = require("crypto");

const { generateQRToken, verifyQRToken } = require("./utils/qrcodeToken");


const app = express();

// Middleware - FIXED: Added proper URL-encoded parsing for Twilio
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false })); // FIXED: For Twilio webhooks

//router here
const router = express.Router();

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

    const { data, error } = await supabase.auth.getUser(token);
    
    if (error || !data?.user) {
      console.error("JWT verification failed:", error?.message || "No user data");
      return res.status(401).json({ 
        error: "Invalid or expired token",
        reply: "Your session has expired. Please log in again."
      });
    }

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
// DATABASE HELPER FUNCTIONS (DEFINED FIRST!)
// ============================================================================

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
 * Find or create customer by WhatsApp phone number
 */
async function findOrCreateWhatsAppCustomer(phoneNumber) {
  try {
    console.log("🔍 Looking up WhatsApp customer with phone:", phoneNumber);
    
    // First, try to find existing customer by phone
    const { data: existingCustomer, error: findError } = await supabase
      .from("customers")
      .select("*")
      .eq("phone_number", phoneNumber)
      .single();

    if (!findError && existingCustomer) {
      console.log("✅ Found existing customer:", existingCustomer.id);
      return existingCustomer;
    }

    // If not found, create a new customer
    console.log("📝 Creating new WhatsApp customer for phone:", phoneNumber);
    
    const newCustomerId = `cust_wa_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const profileName = "WhatsApp User"; // Could be enhanced with WhatsApp profile name later
    
    const { data: newCustomer, error: createError } = await supabase
      .from("customers")
      .insert({
        id: newCustomerId,
        name: profileName,
        phone_number: phoneNumber,
        loyalty_tier: "bronze",
        store_location: "Mumbai", // Default location
        total_spend: 0,
        last_seen_channel: "whatsapp",
        session_context: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (createError) {
      console.error("❌ Failed to create WhatsApp customer:", createError.message);
      return null;
    }

    console.log("✅ Created new WhatsApp customer:", newCustomerId);
    return newCustomer;
    
  } catch (err) {
    console.error("❌ findOrCreateWhatsAppCustomer exception:", err);
    return null;
  }
}

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
 * Search products by category or occasion - FIXED ATTRIBUTES QUERY
 */
async function searchProducts(category = null, occasion = null) {
  try {
    console.log("🔍 Searching products:", { category, occasion });
    
    let query = supabase.from("products").select("*");

    if (category) {
      console.log("Filtering by category:", category);
      query = query.eq("category", category);
    }

    if (occasion) {
      console.log("Filtering by occasion:", occasion);
      // Try different ways to query JSONB
      // Method 1: Using contains with proper format
      query = query.or(`attributes.occasion.cs.{"${occasion}"},attributes->>occasion.like.%${occasion}%`);
    }

    const { data, error } = await query;
    
    if (error) {
      console.error("❌ Product search error:", error.message);
      return [];
    }

    console.log(`✅ Found ${data?.length || 0} products`);
    return data || [];
  } catch (err) {
    console.error("❌ Product search exception:", err);
    return [];
  }
}

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

async function updateCustomerSpend(customerId, increment) {
  try {
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
// WORKER AGENTS (DEFINED AFTER HELPER FUNCTIONS!)
// ============================================================================

/**
 * Recommendation Agent - FIXED: Now has access to searchProducts
 */
async function recommendationAgent(customer, userQuery) {
  try {
    console.log("🤖 Recommendation Agent called for:", userQuery);
    console.log("Customer location:", customer?.store_location);
    
    const lowerQ = userQuery.toLowerCase();
    let category = null;
    let occasion = null;

    // Category detection
    if (lowerQ.includes("shirt") || lowerQ.includes("top")) category = "shirts";
    else if (lowerQ.includes("pant") || lowerQ.includes("trouser")) category = "pants";
    else if (lowerQ.includes("shoe") || lowerQ.includes("sneaker") || lowerQ.includes("footwear")) category = "footwear";
    else if (lowerQ.includes("dress") || lowerQ.includes("gown")) category = "dresses";
    else if (lowerQ.includes("jean")) category = "jeans";
    else if (lowerQ.includes("jacket") || lowerQ.includes("coat")) category = "outerwear";

    // Occasion detection
    if (lowerQ.includes("party") || lowerQ.includes("night")) occasion = "party";
    else if (lowerQ.includes("work") || lowerQ.includes("office")) occasion = "formal";
    else if (lowerQ.includes("casual") || lowerQ.includes("everyday")) occasion = "casual";
    else if (lowerQ.includes("wedding") || lowerQ.includes("festive")) occasion = "festive";

    console.log("Detected category:", category, "occasion:", occasion);

    const products = await searchProducts(category, occasion);
    
    // Personalize by store location (inventory availability)
    const personalizedProducts = [];
    
    for (const product of products.slice(0, 10)) {
      const inventory = await checkInventory([product.sku], customer?.store_location);
      if (inventory.length > 0) {
        const available = inventory[0];
        product.availability = available;
        product.inStock = available.onlineStock > 0 || available.storeStock > 0;
        personalizedProducts.push(product);
      }
    }

    // If no personalized results, return all products
    const finalProducts = personalizedProducts.length > 0 ? personalizedProducts : products.slice(0, 5);
    
    console.log(`✅ Returning ${finalProducts.length} recommendations`);
    return finalProducts;
  } catch (err) {
    console.error("❌ Recommendation agent error:", err);
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
    const fail = Math.random() < 0.1;
    
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
    const fail = Math.random() < 0.05;
    
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
// ORCHESTRATOR LOGIC
// ============================================================================

/**
 * Classify user intent - FIXED: Using gpt-4o (not gpt-4o-mini)
 */
async function classifyIntent(userQuery, customer, recentSessions) {
  const defaultIntent = {
    intent: "recommend",
    target_skus: [],
    occasion: null,
    payment_method: null,
    fulfillment_mode: null
  };

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
      model: "gpt-4o", // FIXED: Changed from gpt-4o-mini to gpt-4o
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
    
    const validIntents = ["recommend", "check_inventory", "checkout", "post_purchase", "smalltalk" , "support_issue"];
    if (!validIntents.includes(parsed.intent)) {
      parsed.intent = "recommend";
    }
    
    return parsed;
  } catch (err) {
    console.error("❌ OpenAI Intent classification failed:", err.response?.data || err.message);
    console.error("Full error:", err);
    return defaultIntent;
  }
}

/**
 * Main orchestrator function
 */
async function runRetailOrchestrator(user_query, customer_id, channel = "web") {
  try {
    console.log("\n" + "=".repeat(60));
    console.log("🚀 RUNNING ORCHESTRATOR");
    console.log("Query:", user_query);
    console.log("Customer ID:", customer_id);
    console.log("Channel:", channel);
    
    const customer = await fetchCustomerById(customer_id);
    
    if (!customer) {
      console.error("❌ Customer not found");
      return {
        reply: "I couldn't find your customer profile. Please contact support.",
        structured: { error: "Customer not found", plan: { intent: "error" } }
      };
    }

    console.log("Customer found:", customer.name);
    
    const recentSessions = await getRecentSessions(customer_id, 3);
    const previousContext = customer.session_context || {};
    const lastChannel = customer.last_seen_channel;
    const channelSwitched = lastChannel && lastChannel !== channel;
    
    let sessionContext = {
      cart: previousContext.cart || [],
      lastRecommended: previousContext.lastRecommended || null,
      lastBrowsedCategory: previousContext.lastBrowsedCategory || null,
      channel_switched: channelSwitched,
      previous_channel: lastChannel || null,
      current_channel: channel,
      persona_traits: previousContext.persona_traits || {}
    };

    console.log("📋 Session Context:", JSON.stringify(sessionContext, null, 2));
    
    const plan = await classifyIntent(user_query, customer, recentSessions);
    console.log("🎯 Intent Plan:", JSON.stringify(plan, null, 2));
    
    let workerResult = {};
    let cart = sessionContext.cart || [];

    // Process based on intent
    console.log("🔄 Processing intent:", plan.intent);
    
    switch (plan.intent) {
      case "recommend":
        const recs = await recommendationAgent(customer, user_query);
        workerResult.recommendations = recs;
        console.log(`✅ Recommendations found: ${recs?.length || 0}`);
        
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
        
        console.log("Checking inventory for SKUs:", skuList);
        
        if (skuList.length > 0) {
          workerResult.inventory = await checkInventory(skuList, customer.store_location);
          console.log(`✅ Inventory results: ${workerResult.inventory?.length || 0}`);
        } else {
          workerResult.inventory = [];
          console.log("⚠️ No SKUs to check inventory for");
        }
        break;

      case "support_issue":
  console.log("🛠 Support issue detected — creating Jira ticket");

  try {
    const ticket = await createJiraTicket(
      `Customer Issue - ${customer.name}`,
      user_query
    );

    workerResult.support_ticket = ticket;

    console.log("📌 Jira ticket created:", ticket);
  } catch (err) {
    console.error("❌ Failed to create Jira ticket:", err);
    workerResult.support_ticket = {
      success: false,
      error: err.message
    };
  }
  break;


      case "checkout":
        if (cart.length === 0) {
          workerResult.checkout = { error: "Cart is empty" };
          console.log("⚠️ Checkout attempted with empty cart");
        } else {
          const cartTotal = cart.reduce((sum, item) => sum + (item.price || 0) * (item.qty || 1), 0);
          console.log("💰 Cart total:", cartTotal);
          
          const loyalty = loyaltyAgent(customer, cartTotal, null);
          workerResult.loyalty = loyalty;
          console.log("🎫 Loyalty applied:", loyalty);

          const payment = await paymentAgent({
            customerId: customer.id,
            amount: loyalty.finalAmount,
            method: plan.payment_method || "upi"
          });
          
          workerResult.payment = payment;
          console.log("💳 Payment result:", payment.status);

          if (payment.status === "success") {
            const skuList = cart.map(i => i.sku);
            const orderId = await createOrder(
              customer,
              skuList,
              plan.fulfillment_mode || "reserve_in_store",
              loyalty.finalAmount
            );

            if (orderId) {
              console.log("📦 Order created:", orderId);
              
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
              console.log("🚚 Fulfillment:", fulfillment.status);
              
              cart = [];
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
        console.log("📦 Post-purchase:", workerResult.post_purchase.message);
        break;

      case "smalltalk":
        workerResult.smalltalk = {
          greeting: true,
          message: `Hello ${customer.name || "there"}! How can I help you today?`
        };
        console.log("👋 Smalltalk response generated");
        break;
    }

    console.log("📊 Worker Result Summary:", Object.keys(workerResult));
    
    await updateSession(customer.id, channel, plan.intent, {
      last_user_message: user_query,
      cart,
      plan,
      channel_switched: channelSwitched
    });

    // Generate response
    let replyText;
    
    if (!openai) {
      console.log("🤖 Using fallback response (no OpenAI)");
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
      console.log("🤖 Generating AI response with OpenAI");
      const channelAwareness = channelSwitched 
        ? `Note: Customer switched from ${lastChannel} to ${channel}. Acknowledge naturally if relevant.`
        : "";

      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4o", // FIXED: Changed from gpt-4o-mini to gpt-4o
          messages: [
            {
              role: "system",
              content: `You are a friendly retail assistant for a fashion store. Be helpful, concise, and personal.
${channelAwareness}
Customer name: ${customer.name || "Customer"}
Loyalty tier: ${customer.loyalty_tier || "bronze"}

Use this context to inform your response:
- Plan: ${JSON.stringify(plan)}
- Worker Results: ${JSON.stringify(workerResult, null, 2)}
- Cart: ${JSON.stringify(cart)}

Keep responses under 3 sentences. Be enthusiastic and helpful.`
            },
            {
              role: "user",
              content: `Customer says: "${user_query}"`
            }
          ],
          temperature: 0.7,
          max_tokens: 300
        });

        replyText = response.choices[0].message.content;
        console.log("✅ AI Response generated:", replyText.substring(0, 100) + "...");
      } catch (openaiErr) {
        console.error("❌ OpenAI response generation failed:", openaiErr.response?.data || openaiErr.message);
        replyText = `I understand you're asking about ${user_query}. Based on your request, I found ${workerResult.recommendations?.length || 0} recommendations. How can I help you further?`;
      }
    }

    sessionContext.cart = cart;
    await updateCustomerChannel(customer.id, channel, sessionContext);

    console.log("✅ Orchestrator completed successfully");
    console.log("=".repeat(60) + "\n");

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
    console.error("❌ Orchestrator error:", err);
    console.error("Stack trace:", err.stack);
    return {
      reply: "I apologize, but I'm having trouble processing your request. Please try again or contact support.",
      structured: { error: err.message, plan: { intent: "error" } }
    };
  }
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * GET /api/me - FIXED: Returns session_context
 */
router.get("/me", verifyUser, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    
    const customer = await fetchCustomer(authUserId);
    
    if (!customer) {
      return res.status(404).json({ 
        error: "Customer profile not found",
        reply: "Please complete your profile setup."
      });
    }

    // FIXED: Now includes session_context
    res.json({
      id: customer.id,
      name: customer.name,
      email: req.authUser.email,
      loyalty_tier: customer.loyalty_tier,
      store_location: customer.store_location,
      total_spend: customer.total_spend,
      last_seen_channel: customer.last_seen_channel,
      session_context: customer.session_context || {} // FIXED: Added this
    });
    
  } catch (err) {
    console.error("GET /api/me error:", err);
    res.status(500).json({ 
      error: "Failed to fetch profile",
      reply: "Something went wrong. Please try again."
    });
  }
});

// NEW: Public-facing /profile endpoint (same as /api/me)
router.get("/profile", verifyUser, async (req, res) => {
  try {
    const authUserId = req.authUser.id;

    const customer = await fetchCustomer(authUserId);

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found",
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
      last_seen_channel: customer.last_seen_channel,
      session_context: customer.session_context || {}
    });

  } catch (err) {
    console.error("GET /profile error:", err);
    res.status(500).json({
      error: "Failed to fetch profile"
    });
  }
});


router.get("/customers/:id", async (req, res) => {
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

router.get("/products", async (req, res) => {
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

router.get("/products/:sku", async (req, res) => {
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

router.get("/inventory/:sku", async (req, res) => {
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

router.post("/support/create-ticket", async (req, res) => {
  try {
    const { summary, description } = req.body;

    if (!summary || !description) {
      return res.status(400).json({
        success: false,
        message: "summary and description required"
      });
    }

    const result = await createJiraTicket(summary, description);

    if (!result.success) {
      return res.status(500).json({
        success: false,
        message: "Failed to create Jira ticket",
        error: result.error
      });
    }

    res.json({
      success: true,
      ticket_id: result.issueKey,
      message: "Support ticket submitted successfully!"
    });
    
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Server error creating Jira ticket",
      error: err.message
    });
  }
});

router.post("/payment/payment-order", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount) return res.status(400).json({ success: false, message: "Amount required" });

    const order = await paymentOrder(amount);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      razorpayKey: process.env.RAZORPAY_KEY_ID
    });

  } catch (err) {
    console.error("Razorpay Order Error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to create order"
    });
  }
});



router.post("/payment/verify", async (req, res) => {
  try {
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest("hex");

    const verified = expectedSignature === razorpay_signature;

    if (verified) {
      return res.json({ success: true, message: "Payment verified" });
    }

    res.json({ success: false, message: "Payment verification failed" });

  } catch (err) {
    res.status(500).json({ success: false, message: "Verification error" });
  }
});



router.post("/cart", verifyUser, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    const { sku, qty = 1, price, channel = "web" } = req.body;
    
    if (!sku || !price) {
      return res.status(400).json({ 
        error: "Missing required fields: sku and price are required",
        reply: "Please provide product details."
      });
    }

    const customer = await fetchCustomer(authUserId);
    
    if (!customer) {
      return res.status(404).json({ 
        error: "Customer not found",
        reply: "Please complete your profile first."
      });
    }

    const sessionContext = customer.session_context || {};
    let cart = sessionContext.cart || [];

    const existingItemIndex = cart.findIndex(item => item.sku === sku);
    
    if (existingItemIndex >= 0) {
      cart[existingItemIndex].qty += qty;
    } else {
      const { data: product } = await supabase
        .from("products")
        .select("name , images")
        .eq("sku", sku)
        .single();
      
      cart.push({
          sku,
          qty,
          price,
          name: product?.name || "Product",
          image: product?.images?.[0] || null,
          added_at: new Date().toISOString()
              });

    }

    const updatedContext = {
      ...sessionContext,
      cart,
      last_updated: new Date().toISOString()
    };

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

router.get("/cart", verifyUser, async (req, res) => {
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

router.delete("/cart/:sku", verifyUser, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    const { sku } = req.params;
    
    const customer = await fetchCustomer(authUserId);
    
    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    const sessionContext = customer.session_context || {};
    let cart = sessionContext.cart || [];

    cart = cart.filter(item => item.sku !== sku);

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
router.post("/retail-orchestrator", verifyUser, async (req, res) => {
  try {
    console.log("\n" + "🔥".repeat(20) + " NEW CHAT REQUEST " + "🔥".repeat(20));
    console.log("User:", req.authUser?.email);
    console.log("Body:", JSON.stringify(req.body, null, 2));

    const { user_query, channel = "web" } = req.body;

    if (!user_query || typeof user_query !== 'string' || user_query.trim().length === 0) {
      console.error("❌ Invalid user_query");
      return res.status(400).json({
        reply: "Please provide a message to process.",
        structured: { error: "Missing or invalid user_query" }
      });
    }

    

    const authUserId = req.authUser.id;
    const customer = await fetchCustomer(authUserId);
    
    if (!customer) {
      console.error("❌ Customer not found for auth user:", authUserId);
      return res.status(404).json({
        reply: "I couldn't find your profile. Please complete your setup first.",
        structured: { error: "Customer not found" }
      });
    }

    console.log("✅ Customer found:", customer.name, "ID:", customer.id);

    const result = await runRetailOrchestrator(
      user_query.trim(),
      customer.id,
      channel
    );

    console.log("✅ Orchestrator completed, sending response");
    console.log("🔥".repeat(60) + "\n");

    res.json(result);
    
  } catch (err) {
    console.error("❌ POST /api/retail-orchestrator FATAL ERROR:", err);
    console.error("Stack trace:", err.stack);
    
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
 * POST /api/whatsapp - Twilio WhatsApp webhook endpoint
 * NO verifyUser middleware - Twilio sends raw form data
 */
router.post("/whatsapp", async (req, res) => {
  try {
    // Log full webhook body for debugging
    console.log("📥 WhatsApp webhook received - Full body:", req.body);
    
    // Extract WhatsApp data (Twilio sends form-urlencoded)
    const incomingMsg = req.body.Body || "";
    const fromNumber = req.body.From || ""; // e.g., "whatsapp:+919876543210"
    const profileName = req.body.ProfileName || "";
    const waId = req.body.WaId || "";
    
    console.log("📱 WhatsApp details:", {
      message: incomingMsg,
      from: fromNumber,
      profileName,
      waId
    });

    if (!incomingMsg.trim()) {
      console.warn("⚠️ Empty WhatsApp message received");
      const twiml = new MessagingResponse();
      twiml.message("Hi! I didn't receive your message. How can I help you today?");
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // Extract phone number from Twilio format
    let phoneNumber = fromNumber;
    if (fromNumber.startsWith("whatsapp:")) {
      phoneNumber = fromNumber.replace("whatsapp:", "");
    }
    
    console.log("📞 Extracted phone number:", phoneNumber);

    // Find or create customer based on WhatsApp phone number
    const customer = await findOrCreateWhatsAppCustomer(phoneNumber);
    
    if (!customer) {
      console.error("❌ Failed to find/create WhatsApp customer");
      const twiml = new MessagingResponse();
      twiml.message("Sorry, I'm having trouble accessing your account. Please try again later.");
      res.type("text/xml");
      return res.send(twiml.toString());
    }

    // Update profile name if available and not set
    if (profileName && (!customer.name || customer.name === "WhatsApp User")) {
      await supabase
        .from("customers")
        .update({ name: profileName })
        .eq("id", customer.id);
      console.log("👤 Updated customer name to:", profileName);
    }

    console.log("✅ Processing WhatsApp message for customer:", customer.id, customer.name);
    
    // Run the orchestrator
    const result = await runRetailOrchestrator(
      incomingMsg.trim(),
      customer.id,
      "whatsapp"
    );

    // Send WhatsApp response
    const twiml = new MessagingResponse();
    twiml.message(result.reply);
    
    res.type("text/xml");
    res.send(twiml.toString());

    console.log("✅ WhatsApp response sent successfully");

  } catch (err) {
    console.error("❌ WhatsApp webhook error:", err);
    console.error("Stack trace:", err.stack);
    
    const twiml = new MessagingResponse();
    twiml.message("Oops! Something went wrong on our end. Please try again in a moment.");
    
    res.type("text/xml");
    res.send(twiml.toString());
  }
});

// ============================================================================
// VECTOR SEARCH ENDPOINTS
// ============================================================================

/**
 * POST /api/semantic-search - Vector similarity search
 */
router.post("/semantic-search", verifyUser, async (req, res) => {
  try {
    const { query, limit = 5 } = req.body;

    if (!query || typeof query !== 'string') {
      return res.status(400).json({ 
        success: false, 
        message: "Query string is required" 
      });
    }

    if (!openai) {
      return res.status(500).json({
        success: false,
        message: "OpenAI not configured for embeddings"
      });
    }

    console.log("🔍 Semantic search for query:", query);

    // Generate query embedding
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query.trim(),
    });

    const queryEmbedding = embeddingResponse.data[0].embedding;

    // Run vector match in Supabase
    const { data, error } = await supabase.rpc("match_products", {
      query_embedding: queryEmbedding,
      match_threshold: 0.3, // Lower threshold for broader matches
      match_count: parseInt(limit)
    });

    if (error) {
      console.error("❌ Vector search error:", error);
      return res.status(500).json({ 
        success: false, 
        message: "Vector search failed",
        error: error.message 
      });
    }

    console.log(`✅ Found ${data?.length || 0} vector matches`);

    // If results are found, check inventory for availability
    let enrichedResults = data || [];
    if (enrichedResults.length > 0) {
      // Get customer for location context
      const authUserId = req.authUser.id;
      const customer = await fetchCustomer(authUserId);
      const storeLocation = customer?.store_location || "Mumbai";

      // Check inventory for all matched products
      const skuList = enrichedResults.map(p => p.sku);
      const inventoryData = await checkInventory(skuList, storeLocation);
      
      // Create inventory map for quick lookup
      const inventoryMap = {};
      inventoryData.forEach(inv => {
        inventoryMap[inv.sku] = {
          inStock: inv.onlineStock > 0 || inv.storeStock > 0,
          fulfillmentOptions: inv.fulfillmentOptions,
          onlineStock: inv.onlineStock,
          storeStock: inv.storeStock
        };
      });

      // Enrich results with inventory info
      enrichedResults = enrichedResults.map(product => ({
        ...product,
        availability: inventoryMap[product.sku] || {
          inStock: false,
          fulfillmentOptions: ["ship_to_home"]
        },
        similarity_score: product.similarity || 0
      }));
    }

    res.json({
      success: true,
      query,
      results: enrichedResults,
      count: enrichedResults.length
    });

  } catch (err) {
    console.error("❌ Semantic search exception:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error during semantic search",
      error: err.message 
    });
  }
});

/**
 * GET /api/similar/:sku - Find similar products by embedding
 */
router.get("/similar/:sku", async (req, res) => {
  try {
    const { sku } = req.params;
    const { limit = 6 } = req.query;

    console.log("🔍 Finding similar products for SKU:", sku);

    // First, get the product and its embedding
    const { data: product, error: productError } = await supabase
      .from("products")
      .select("embedding, name, category, price")
      .eq("sku", sku)
      .single();

    if (productError || !product) {
      return res.status(404).json({ 
        success: false, 
        message: "Product not found" 
      });
    }

    if (!product.embedding) {
      return res.status(404).json({ 
        success: false, 
        message: "No embedding found for this product" 
      });
    }

    // Find similar products using vector similarity
    const { data, error } = await supabase.rpc("match_products", {
      query_embedding: product.embedding,
      match_threshold: 0.4, // Higher threshold for similar items
      match_count: parseInt(limit) + 1 // +1 to exclude self
    });

    if (error) {
      console.error("❌ Similar products error:", error);
      return res.status(500).json({ 
        success: false, 
        message: "Similar products search failed",
        error: error.message 
      });
    }

    // Filter out the original product
    const similarProducts = (data || [])
      .filter(p => p.sku !== sku)
      .slice(0, parseInt(limit))
      .map(p => ({
        ...p,
        similarity_score: p.similarity || 0
      }));

    console.log(`✅ Found ${similarProducts.length} similar products`);

    res.json({
      success: true,
      original_sku: sku,
      original_name: product.name,
      similar_products: similarProducts,
      count: similarProducts.length
    });

  } catch (err) {
    console.error("❌ Similar products exception:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error finding similar products",
      error: err.message 
    });
  }
});

/**
 * POST /api/concept-search - Advanced concept search with filters
 */
router.post("/concept-search", verifyUser, async (req, res) => {
  try {
    const { 
      query, 
      limit = 10,
      min_price,
      max_price,
      category,
      in_stock_only = false
    } = req.body;

    if (!query) {
      return res.status(400).json({ 
        success: false, 
        message: "Query is required" 
      });
    }

    if (!openai) {
      return res.status(500).json({
        success: false,
        message: "OpenAI not configured"
      });
    }

    console.log("🔍 Concept search with filters:", { query, category, min_price, max_price });

    // Generate embedding for the query
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query.trim(),
    });

    const queryEmbedding = embeddingResponse.data[0].embedding;

    // Get customer for location context
    const authUserId = req.authUser.id;
    const customer = await fetchCustomer(authUserId);
    const storeLocation = customer?.store_location || "Mumbai";

    // First, get vector matches
    const { data: vectorMatches, error: vectorError } = await supabase.rpc("match_products", {
      query_embedding: queryEmbedding,
      match_threshold: 0.25, // Lower threshold for broader concept matching
      match_count: 50 // Get more results for filtering
    });

    if (vectorError) {
      console.error("❌ Vector search error:", vectorError);
      return res.status(500).json({ 
        success: false, 
        message: "Concept search failed",
        error: vectorError.message 
      });
    }

    if (!vectorMatches || vectorMatches.length === 0) {
      return res.json({
        success: true,
        query,
        results: [],
        count: 0,
        message: "No matching products found"
      });
    }

    // Get SKUs from vector matches
    const skuList = vectorMatches.map(p => p.sku);
    
    // Build base query for filtering
    let queryBuilder = supabase
      .from("products")
      .select("*")
      .in("sku", skuList);

    // Apply filters
    if (category) {
      queryBuilder = queryBuilder.eq("category", category);
    }
    if (min_price) {
      queryBuilder = queryBuilder.gte("price", parseFloat(min_price));
    }
    if (max_price) {
      queryBuilder = queryBuilder.lte("price", parseFloat(max_price));
    }

    const { data: filteredProducts, error: filterError } = await queryBuilder;

    if (filterError) {
      console.error("❌ Filter error:", filterError);
      return res.status(500).json({ 
        success: false, 
        message: "Failed to apply filters",
        error: filterError.message 
      });
    }

    // Check inventory if needed
    let finalResults = filteredProducts || [];
    if (in_stock_only && finalResults.length > 0) {
      const inventoryData = await checkInventory(
        finalResults.map(p => p.sku),
        storeLocation
      );
      
      const inventoryMap = {};
      inventoryData.forEach(inv => {
        inventoryMap[inv.sku] = (inv.onlineStock > 0 || inv.storeStock > 0);
      });

      finalResults = finalResults.filter(p => inventoryMap[p.sku]);
    }

    // Sort by original similarity score from vector matches
    const similarityMap = {};
    vectorMatches.forEach(p => {
      similarityMap[p.sku] = p.similarity || 0;
    });

    finalResults.sort((a, b) => {
      const scoreA = similarityMap[a.sku] || 0;
      const scoreB = similarityMap[b.sku] || 0;
      return scoreB - scoreA;
    });

    // Limit results
    finalResults = finalResults.slice(0, parseInt(limit));

    // Enrich with availability
    if (finalResults.length > 0) {
      const inventoryData = await checkInventory(
        finalResults.map(p => p.sku),
        storeLocation
      );
      
      const inventoryMap = {};
      inventoryData.forEach(inv => {
        inventoryMap[inv.sku] = {
          inStock: inv.onlineStock > 0 || inv.storeStock > 0,
          fulfillmentOptions: inv.fulfillmentOptions,
          onlineStock: inv.onlineStock,
          storeStock: inv.storeStock
        };
      });

      finalResults = finalResults.map(product => ({
        ...product,
        availability: inventoryMap[product.sku] || {
          inStock: false,
          fulfillmentOptions: ["ship_to_home"]
        },
        similarity_score: similarityMap[product.sku] || 0
      }));
    }

    console.log(`✅ Concept search returned ${finalResults.length} products`);

    res.json({
      success: true,
      query,
      filters_applied: {
        category,
        price_range: min_price || max_price ? `${min_price || '0'}-${max_price || '∞'}` : null,
        in_stock_only
      },
      results: finalResults,
      count: finalResults.length
    });

  } catch (err) {
    console.error("❌ Concept search exception:", err);
    res.status(500).json({ 
      success: false, 
      message: "Server error during concept search",
      error: err.message 
    });
  }
});

/**
 * GET /api/qr-login-token - Generate QR token for kiosk login
 */
router.get("/qr-login-token", verifyUser, async (req, res) => {
  try {
    const authUserId = req.authUser.id;
    
    const token = generateQRToken(authUserId);

    res.json({
      success: true,
      token,
      qrUrl: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/kiosk-login?token=${token}`,
      expires_in: "5 minutes"
    });

  } catch (err) {
    console.error("❌ QR token generation error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to generate QR login token"
    });
  }
});

/**
 * POST /api/qr-login-verify - Verify QR token for kiosk login
 */
router.post("/qr-login-verify", async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: "QR token is required"
      });
    }

    // Decode QR token
    const userId = verifyQRToken(token);

    if (!userId) {
      return res.status(401).json({
        success: false,
        message: "QR token invalid or expired"
      });
    }

    // Fetch customer by kiosk token identity
    const customer = await fetchCustomerById(userId);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer profile not found"
      });
    }

    // Fetch supabase auth record using stored auth_user_id
    const { data: userData, error: userError } =
      await supabase.auth.admin.getUserById(customer.auth_user_id);

    if (userError || !userData?.user) {
      return res.status(404).json({
        success: false,
        message: "User not found in auth"
      });
    }

    return res.json({
      success: true,
      user: {
        id: userData.user.id,
        email: userData.user.email,
        name: customer.name || "Customer",
        loyalty_tier: customer.loyalty_tier || "bronze",
        store_location: customer.store_location || "Mumbai"
      },
      session_token: token // front-end will store this as logged-in kiosk session
    });

  } catch (err) {
    console.error("❌ QR login verification error:", err);
    res.status(500).json({
      success: false,
      message: "QR login verification failed"
    });
  }
});
 

router.get("/health", async (req, res) => {
  try {
    const { error: dbError } = await supabase
      .from('customers')
      .select('count')
      .limit(1);

    let openaiStatus = "not_configured";
    if (openai) {
      try {
        await openai.models.list();
        openaiStatus = "connected";
      } catch (err) {
        openaiStatus = "error: " + (err.response?.data?.error?.message || err.message);
      }
    }

    // Check vector search function
    let vectorSearchStatus = "not_available";
    try {
      const { error: rpcError } = await supabase.rpc('match_products', {
        query_embedding: Array(1536).fill(0), // dummy embedding
        match_count: 1
      }).limit(0);
      
      if (rpcError && rpcError.message.includes('function') && rpcError.message.includes('does not exist')) {
        vectorSearchStatus = "function_not_created";
      } else {
        vectorSearchStatus = "available";
      }
    } catch (err) {
      vectorSearchStatus = "error: " + err.message;
    }

    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      services: {
        database: dbError ? "error: " + dbError.message : "connected",
        openai: openaiStatus,
        vector_search: vectorSearchStatus,
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

app.use("/api", router);

app.get("/", (req, res) => {
  res.json({
    name: "Retail Orchestrator API",
    version: "1.0.0",
    status: "running",
    ai_features: {
      semantic_search: "Available",
      similar_products: "Available",
      concept_search: "Available"
    },
    endpoints: {
      auth: "/api/me (GET)",
      chat: "/api/retail-orchestrator (POST)",
      whatsapp: "/api/whatsapp (POST)",
      cart: "/api/cart (GET, POST, DELETE)",
      products: "/api/products (GET)",
      ai_search: {
        semantic_search: "/api/semantic-search (POST)",
        similar_products: "/api/similar/:sku (GET)",
        concept_search: "/api/concept-search (POST)"
      },
      qr_login: {
        get_token: "/api/qr-login-token (GET)",
        verify: "/api/qr-login-verify (POST)"
      },
      health: "/api/health (GET)"
    },
    documentation: "See README for API usage"
  });
});

// Error handling
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
    path: req.path,
    method: req.method
  });
});

app.use((err, req, res, next) => {
  console.error("🚨 Global error handler:", err);
  
  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === 'development' ? err.message : "Something went wrong",
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Server start
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
   POST /api/whatsapp        - WhatsApp webhook (no auth required)
   GET  /api/products        - Browse products
────────────────────────────────────────
  `);

  // Test connections
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('count')
      .limit(1);
    
    if (error) {
      console.warn('⚠️  Supabase connection test failed:', error.message);
    } else {
      console.log('✅ Supabase connection successful');
    }

    if (openai) {
      try {
        await openai.models.list();
        console.log('✅ OpenAI connection successful');
      } catch (err) {
        console.warn('⚠️  OpenAI connection failed:', err.response?.data?.error?.message || err.message);
      }
    }
  } catch (err) {
    console.warn('⚠️  Initial connection tests failed:', err.message);
  }
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  process.exit(0);
});

module.exports = app;