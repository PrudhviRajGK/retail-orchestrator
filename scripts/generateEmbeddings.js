require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateEmbeddings() {
  console.log("🚀 Fetching products needing embeddings...");

  const { data: products, error } = await supabase
    .from("products")
    .select("sku, name, category, image, attributes, embedding")
    .is("embedding", null);

  if (error) {
    console.error("❌ Failed to fetch products:", error);
    return;
  }

  if (!products.length) {
    console.log("✨ All products have embeddings already.");
    return;
  }

  console.log(`📦 Generating embeddings for ${products.length} products...\n`);

  for (const product of products) {
    try {

      // Create text for embedding — AI loves structured meaning
      let attributeText = "";

      if (product.attributes) {
        if (typeof product.attributes === "object") {
          attributeText = Object.entries(product.attributes)
            .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
            .join(", ");
        } else {
          attributeText = product.attributes;
        }
      }

      const text = `
        Product: ${product.name}
        Category: ${product.category}
        Attributes: ${attributeText}
      `.trim();

      // 🔹 Generate embedding
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
      });

      const embedding = embeddingResponse.data[0].embedding;

      // 🔹 Store embedding in Supabase
      const { error: updateError } = await supabase
        .from("products")
        .update({ embedding })
        .eq("sku", product.sku);

      if (updateError) {
        console.error(`❌ Failed to update embedding for ${product.sku}`);
      } else {
        console.log(`✅ Embedded → ${product.sku}`);
      }

    } catch (err) {
      console.error(`❌ Embedding generation failure for ${product.sku}:`, err.message);
    }
  }

  console.log("\n🎯 Embedding generation complete.");
}

generateEmbeddings();
