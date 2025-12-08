# 🛍️ Retail Orchestrator Backend

An intelligent, AI-powered omnichannel retail backend built with Node.js, Express, Supabase, and OpenAI. This system orchestrates customer interactions across web, mobile, WhatsApp, and in-store kiosk channels with intelligent product recommendations, inventory management, and seamless checkout experiences.

---

DEMO : [![Video Title](https://img.youtube.com/vi/m_o3T-n3gVw/0.jpg)](https://www.youtube.com/watch?v=m_o3T-n3gVw)


## 📋 Table of Contents

- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Architecture](#-architecture)
- [Prerequisites](#-prerequisites)
- [Installation](#-installation)
- [Environment Variables](#-environment-variables)
- [API Documentation](#-api-documentation)
- [AI-Powered Features](#-ai-powered-features)
- [Channel Support](#-channel-support)
- [Database Schema](#-database-schema)
- [Agent Architecture](#-agent-architecture)
- [Testing](#-testing)
- [Deployment](#-deployment)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

---

## ✨ Features

### Core Capabilities
- 🤖 **AI-Powered Conversational Commerce** - Natural language product search and recommendations
- 🔍 **Vector Semantic Search** - Find products using natural language queries
- 🛒 **Smart Shopping Cart** - Persistent cart across channels with session management
- 💳 **Payment Integration** - Razorpay payment gateway with verification
- 📦 **Omnichannel Fulfillment** - Ship to home, click & collect, reserve in-store
- 🎁 **Loyalty Program** - Tiered rewards with dynamic discounts
- 📱 **WhatsApp Integration** - Full shopping experience via WhatsApp
- 🖥️ **QR Kiosk Login** - Seamless in-store authentication
- 🎫 **Support Ticketing** - Automated Jira ticket creation
- 📊 **Inventory Management** - Real-time stock checking across locations

### AI Features
- **Intent Classification** - Understands customer queries (recommend, checkout, support, etc.)
- **Product Recommendations** - Context-aware suggestions based on preferences
- **Semantic Search** - Vector embeddings for conceptual product discovery
- **Similar Products** - Find visually and conceptually similar items
- **Channel Awareness** - Adapts responses based on customer channel

---

## 🛠️ Tech Stack

### Backend Framework
- **Node.js** (v16+)
- **Express.js** - Web framework
- **Supabase** - PostgreSQL database with real-time features
- **OpenAI GPT-4** - Natural language processing and embeddings

### Integrations
- **Twilio** - WhatsApp Business API
- **Razorpay** - Payment processing
- **Jira** - Support ticket management
- **Vector Database** - pgvector for semantic search

### Libraries
- `@supabase/supabase-js` - Database client
- `openai` - AI completions and embeddings
- `twilio` - WhatsApp messaging
- `razorpay` - Payment gateway
- `cors` - Cross-origin resource sharing
- `dotenv` - Environment configuration
- `crypto` - Payment signature verification

---

## 🏗️ Architecture

### Multi-Agent System

```
┌─────────────────────────────────────────────────────────────┐
│                    API Gateway (Express)                     │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                  Orchestrator Agent (GPT-4)                  │
│          • Intent Classification                             │
│          • Context Management                                │
│          • Channel Awareness                                 │
└─────────────────────────────────────────────────────────────┘
                              ↓
        ┌─────────────────────┴─────────────────────┐
        ↓                     ↓                      ↓
┌──────────────┐    ┌──────────────┐      ┌──────────────┐
│ Recommendation│    │   Loyalty    │      │  Fulfillment │
│    Agent      │    │    Agent     │      │    Agent     │
└──────────────┘    └──────────────┘      └──────────────┘
        ↓                     ↓                      ↓
┌──────────────┐    ┌──────────────┐      ┌──────────────┐
│   Payment    │    │   Inventory  │      │   Support    │
│    Agent     │    │   Service    │      │   Ticketing  │
└──────────────┘    └──────────────┘      └──────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    Supabase Database                         │
│  • Customers  • Products  • Orders  • Inventory              │
│  • Conversations  • Payments  • Vector Embeddings            │
└─────────────────────────────────────────────────────────────┘
```

---

## 📦 Prerequisites

- **Node.js** v16 or higher
- **npm** or **yarn**
- **Supabase** account (free tier works)
- **OpenAI API** key (GPT-4 access)
- **Twilio** account (for WhatsApp)
- **Razorpay** account (for payments)
- **Jira** account (optional, for support tickets)

---

## 🚀 Installation

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/retail-orchestrator-backend.git
cd retail-orchestrator-backend
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Environment Variables

Create a `.env` file in the root directory:

```bash
cp .env.example .env
```

Edit `.env` with your credentials (see [Environment Variables](#-environment-variables))

### 4. Set Up Supabase Database

Run the SQL migrations in your Supabase SQL Editor:

```sql
-- Create customers table
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  auth_user_id UUID REFERENCES auth.users(id),
  name TEXT,
  email TEXT,
  phone_number TEXT,
  loyalty_tier TEXT DEFAULT 'bronze',
  store_location TEXT DEFAULT 'Mumbai',
  total_spend DECIMAL DEFAULT 0,
  last_seen_channel TEXT,
  session_context JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create products table with vector embeddings
CREATE TABLE products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  price DECIMAL NOT NULL,
  description TEXT,
  images TEXT[],
  attributes JSONB DEFAULT '{}',
  embedding VECTOR(1536), -- For semantic search
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create inventory table
CREATE TABLE inventory (
  id SERIAL PRIMARY KEY,
  sku TEXT REFERENCES products(sku),
  location TEXT,
  stock INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create orders table
CREATE TABLE orders (
  order_id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES customers(id),
  sku_list TEXT[],
  total_amount DECIMAL,
  status TEXT DEFAULT 'pending',
  fulfillment_mode TEXT,
  store_location TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Create payment_transactions table
CREATE TABLE payment_transactions (
  txn_id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(order_id),
  customer_id TEXT REFERENCES customers(id),
  status TEXT,
  method TEXT,
  amount DECIMAL,
  message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create conversation_memory table
CREATE TABLE conversation_memory (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  customer_id TEXT REFERENCES customers(id),
  channel TEXT,
  last_message TEXT,
  last_intent TEXT,
  context JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create vector similarity search function
CREATE OR REPLACE FUNCTION match_products(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  sku TEXT,
  name TEXT,
  category TEXT,
  price DECIMAL,
  description TEXT,
  images TEXT[],
  attributes JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    products.sku,
    products.name,
    products.category,
    products.price,
    products.description,
    products.images,
    products.attributes,
    1 - (products.embedding <=> query_embedding) AS similarity
  FROM products
  WHERE 1 - (products.embedding <=> query_embedding) > match_threshold
  ORDER BY products.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

### 5. Start the Server

```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

The server will start at `http://localhost:4000`

---

## 🔑 Environment Variables

Create a `.env` file with the following variables:

```bash
# Server Configuration
PORT=4000
HOST=0.0.0.0
NODE_ENV=development
FRONTEND_URL=http://localhost:3000

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# OpenAI Configuration
OPENAI_API_KEY=sk-your-openai-api-key

# Twilio WhatsApp Configuration
TWILIO_ACCOUNT_SID=your-twilio-account-sid
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886

# Razorpay Payment Configuration
RAZORPAY_KEY_ID=your-razorpay-key-id
RAZORPAY_KEY_SECRET=your-razorpay-key-secret

# Jira Integration (Optional)
JIRA_HOST=your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT_KEY=SUPPORT
```

### Getting API Keys

- **Supabase**: https://supabase.com → Create project → Settings → API
- **OpenAI**: https://platform.openai.com → API Keys
- **Twilio**: https://console.twilio.com → WhatsApp → Sandbox
- **Razorpay**: https://dashboard.razorpay.com → Settings → API Keys
- **Jira**: https://id.atlassian.com → Security → API tokens

---

## 📡 API Documentation

### Base URL
```
http://localhost:4000/api
```

### Authentication
Most endpoints require a JWT token from Supabase Auth:

```bash
Authorization: Bearer <your-supabase-jwt-token>
```

---

### 🔐 Authentication Endpoints

#### Get User Profile
```http
GET /api/me
Authorization: Bearer <token>
```

**Response:**
```json
{
  "id": "cust_123",
  "name": "John Doe",
  "email": "john@example.com",
  "loyalty_tier": "gold",
  "store_location": "Mumbai",
  "total_spend": 15000,
  "session_context": {
    "cart": [],
    "lastRecommended": null
  }
}
```

---

### 🛒 Cart Endpoints

#### Add to Cart
```http
POST /api/cart
Authorization: Bearer <token>
Content-Type: application/json

{
  "sku": "SHIRT-001",
  "qty": 1,
  "price": 1999,
  "channel": "web"
}
```

**Response:**
```json
{
  "success": true,
  "cart": [
    {
      "sku": "SHIRT-001",
      "name": "Classic White Shirt",
      "qty": 1,
      "price": 1999,
      "image": "https://example.com/shirt.jpg"
    }
  ],
  "cart_total": 1999,
  "item_count": 1
}
```

#### Get Cart
```http
GET /api/cart
Authorization: Bearer <token>
```

#### Remove from Cart
```http
DELETE /api/cart/:sku
Authorization: Bearer <token>
```

---

### 💬 Chat/Orchestrator Endpoint

#### Process Customer Query
```http
POST /api/retail-orchestrator
Authorization: Bearer <token>
Content-Type: application/json

{
  "user_query": "Show me casual shirts for office",
  "channel": "web"
}
```

**Response:**
```json
{
  "message": "I found 5 great casual shirts perfect for office wear!",
  "products": [
    {
      "sku": "SHIRT-001",
      "name": "Classic White Shirt",
      "price": 1999,
      "category": "shirts",
      "images": ["https://example.com/shirt.jpg"],
      "availability": {
        "inStock": true,
        "fulfillmentOptions": ["ship_to_home", "click_and_collect"]
      }
    }
  ],
  "actions": ["Add to cart", "See similar", "Reserve in store"],
  "raw": {
    "plan": {
      "intent": "recommend",
      "target_skus": [],
      "occasion": "formal"
    }
  }
}
```

---

### 🔍 Search Endpoints

#### Semantic Search
```http
POST /api/semantic-search
Authorization: Bearer <token>
Content-Type: application/json

{
  "query": "comfortable shoes for long walks",
  "limit": 5
}
```

#### Similar Products
```http
GET /api/similar/:sku?limit=6
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "original_sku": "SHOE-001",
  "similar_products": [
    {
      "sku": "SHOE-002",
      "name": "Similar Sneaker",
      "price": 2999,
      "similarity_score": 0.87
    }
  ]
}
```

#### Concept Search with Filters
```http
POST /api/concept-search
Authorization: Bearer <token>
Content-Type: application/json

{
  "query": "summer party outfits",
  "limit": 10,
  "category": "dresses",
  "min_price": 1000,
  "max_price": 5000,
  "in_stock_only": true
}
```

---

### 📦 Product Endpoints

#### Get All Products
```http
GET /api/products?category=shirts&occasion=casual&limit=20
```

#### Get Product by SKU
```http
GET /api/products/:sku
```

#### Get Inventory
```http
GET /api/inventory/:sku?location=Mumbai
```

---

### 💳 Payment Endpoints

#### Create Payment Order
```http
POST /api/payment/payment-order
Authorization: Bearer <token>
Content-Type: application/json

{
  "amount": 1999
}
```

**Response:**
```json
{
  "success": true,
  "orderId": "order_abc123",
  "amount": 1999,
  "currency": "INR",
  "razorpayKey": "rzp_test_..."
}
```

#### Verify Payment
```http
POST /api/payment/verify
Content-Type: application/json

{
  "razorpay_payment_id": "pay_xyz",
  "razorpay_order_id": "order_abc",
  "razorpay_signature": "signature_hash"
}
```

---

### 🎫 Support Endpoints

#### Create Support Ticket
```http
POST /api/support/create-ticket
Content-Type: application/json

{
  "summary": "Payment issue",
  "description": "Payment failed but amount was deducted"
}
```

---

### 📱 WhatsApp Webhook

#### Receive WhatsApp Messages
```http
POST /api/whatsapp
Content-Type: application/x-www-form-urlencoded

Body=Hello, I want to buy shoes
From=whatsapp:+919876543210
ProfileName=John Doe
```

**Note:** This endpoint is called by Twilio automatically. Configure it in your Twilio Console:
- Webhook URL: `https://your-domain.com/api/whatsapp`
- Method: POST

---

### 🔐 QR Kiosk Login

#### Generate QR Token
```http
GET /api/qr-login-token
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "token": "eyJhbGc...",
  "qrUrl": "http://localhost:3000/kiosk-login?token=eyJhbGc...",
  "expires_in": "5 minutes"
}
```

#### Verify QR Token
```http
POST /api/qr-login-verify
Content-Type: application/json

{
  "token": "eyJhbGc..."
}
```

---

### 🏥 Health Check

#### Check System Health
```http
GET /api/health
```

**Response:**
```json
{
  "status": "healthy",
  "timestamp": "2025-12-08T10:30:00.000Z",
  "services": {
    "database": "connected",
    "openai": "connected",
    "vector_search": "available",
    "express": "running"
  },
  "environment": "development"
}
```

---

## 🤖 AI-Powered Features

### Intent Classification

The orchestrator uses GPT-4 to classify customer intents:

- **recommend** - Product discovery and suggestions
- **check_inventory** - Stock availability queries
- **checkout** - Purchase and payment
- **post_purchase** - Order tracking and returns
- **support_issue** - Complaints and escalations
- **smalltalk** - Greetings and casual conversation

### Product Recommendations

The recommendation agent:
1. Analyzes customer query using NLP
2. Detects category and occasion keywords
3. Searches products in the database
4. Checks real-time inventory at customer's location
5. Personalizes results based on purchase history
6. Returns top matches with availability

### Vector Semantic Search

Products are indexed with OpenAI embeddings:
```javascript
// Example: Search using natural language
POST /api/semantic-search
{
  "query": "lightweight breathable running shoes for marathon training"
}

// Returns products ranked by semantic similarity
// Even if exact keywords don't match
```

---

## 📱 Channel Support

### Web/Mobile App
- JWT authentication
- REST API access
- Real-time cart updates
- Session persistence

### WhatsApp
- Automatic customer creation
- Natural language conversations
- Product recommendations
- Order status updates
- Payment links

### In-Store Kiosk
- QR code authentication
- Profile sync across channels
- Store-specific inventory
- Quick checkout

---

## 🗄️ Database Schema

### Key Tables

**customers**
- Stores customer profiles
- Tracks loyalty tier and spend
- Maintains session context across channels

**products**
- Product catalog with metadata
- Vector embeddings for semantic search
- JSONB attributes for flexible filtering

**inventory**
- Multi-location stock tracking
- Real-time availability
- Fulfillment options

**orders**
- Order history
- Status tracking
- Fulfillment mode

**conversation_memory**
- Session history
- Intent tracking
- Context preservation

---

## 🏢 Agent Architecture

### 1. Orchestrator Agent
**Role:** Main coordinator and intent classifier
- Analyzes customer queries
- Routes to appropriate worker agents
- Manages conversation context
- Generates natural language responses

### 2. Recommendation Agent
**Role:** Product discovery and suggestions
- Category and occasion detection
- Inventory-aware recommendations
- Personalization based on location and history

### 3. Loyalty Agent
**Role:** Discount and rewards calculation
- Tier-based discounts
- Coupon code validation
- Points earning calculation

### 4. Payment Agent
**Role:** Payment processing
- Razorpay integration
- Transaction logging
- Retry handling

### 5. Fulfillment Agent
**Role:** Order fulfillment coordination
- Mode selection (ship/collect/reserve)
- Store availability
- Delivery scheduling

---

## 🧪 Testing

### Run Tests
```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# Coverage report
npm run test:coverage
```

### Manual Testing with cURL

**Test Chat Endpoint:**
```bash
curl -X POST http://localhost:4000/api/retail-orchestrator \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_query": "Show me casual shirts",
    "channel": "web"
  }'
```

**Test WhatsApp Webhook:**
```bash
curl -X POST http://localhost:4000/api/whatsapp \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Body=Hello&From=whatsapp:+919876543210&ProfileName=Test User"
```

---

## 🚀 Deployment

### Deploy to Heroku

```bash
# Login to Heroku
heroku login

# Create app
heroku create retail-orchestrator

# Set environment variables
heroku config:set SUPABASE_URL=your-url
heroku config:set SUPABASE_SERVICE_ROLE_KEY=your-key
heroku config:set OPENAI_API_KEY=your-key

# Deploy
git push heroku main

# Check logs
heroku logs --tail
```

### Deploy to Railway

1. Connect your GitHub repository
2. Add environment variables in Railway dashboard
3. Deploy automatically on push

### Deploy to Render

1. Create new Web Service
2. Connect repository
3. Add environment variables
4. Deploy

### Deploy to AWS EC2

```bash
# SSH into EC2 instance
ssh -i your-key.pem ubuntu@your-ec2-ip

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Clone and setup
git clone your-repo
cd retail-orchestrator-backend
npm install

# Use PM2 for process management
npm install -g pm2
pm2 start server.js --name retail-orchestrator
pm2 startup
pm2 save
```

---

## 🔧 Troubleshooting

### Common Issues

**1. OpenAI API Errors**
```
Error: gpt-4o-mini not found
```
**Solution:** Use `gpt-4o` or `gpt-4-turbo` model name

**2. Supabase Connection Issues**
```
Error: Invalid API key
```
**Solution:** Use the `service_role` key, not the `anon` key

**3. WhatsApp Not Receiving Messages**
```
Error: Webhook validation failed
```
**Solution:** Ensure your webhook URL is publicly accessible (use ngrok for local testing)

**4. Vector Search Not Working**
```
Error: function match_products does not exist
```
**Solution:** Run the pgvector SQL migration in Supabase

**5. CORS Errors**
```
Error: CORS policy blocked
```
**Solution:** Add your frontend URL to CORS whitelist or use `cors()` middleware

### Debug Mode

Enable detailed logging:
```bash
NODE_ENV=development npm start
```

---

## 📚 Additional Resources

- [Supabase Documentation](https://supabase.com/docs)
- [OpenAI API Reference](https://platform.openai.com/docs)
- [Twilio WhatsApp Guide](https://www.twilio.com/docs/whatsapp)
- [Razorpay Integration](https://razorpay.com/docs/)
- [pgvector Guide](https://github.com/pgvector/pgvector)

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---



---

## 🙏 Acknowledgments

- OpenAI for GPT-4 and embeddings API
- Supabase for the excellent database platform
- Twilio for WhatsApp Business API
- The open-source community

---

## 📞 Support

For support, email support@yourcompany.com or join our Slack channel.

---

**Happy Coding! 🚀**
