// index.js
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// These come from environment variables on Render
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;     // e.g. "alfiecoffee.myshopify.com"
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

app.use(express.json());

app.use((req, res, next) => {
  const allowedOrigins = [
    "https://alfiecoffee.co.uk",
    "https://alfiecoffee.myshopify.com"
  ];
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "false");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});


// Helper to talk to Shopify Admin GraphQL API
// Helper to talk to Shopify Admin GraphQL API
async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${SHOP}/admin/api/2024-04/graphql.json`;
  console.log("Shopify GraphQL URL:", url);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": ADMIN_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });

  const json = await res.json();
  // ... leave the rest as we already have it ...


  const json = await res.json();

  // If HTTP itself failed (bad token, bad shop, etc.)
  if (!res.ok) {
    console.error("HTTP error from Shopify:", res.status, json);
    throw new Error(`HTTP ${res.status} from Shopify`);
  }

  // If GraphQL returned errors
  if (json.errors && json.errors.length) {
    console.error("GraphQL errors:", JSON.stringify(json.errors, null, 2));
    // Use the first error message if there is one
    const msg = json.errors[0]?.message || "Shopify GraphQL error";
    throw new Error(msg);
  }

  return json.data;
}


// Get existing passport metafield for a customer
async function getPassport(customerId) {
  const gid = `gid://shopify/Customer/${customerId}`;

  const query = `
    query GetPassport($id: ID!) {
      customer(id: $id) {
        metafield(namespace: "tastetracker", key: "passport") {
          value
        }
      }
    }
  `;

  const data = await shopifyGraphQL(query, { id: gid });
  const metafield = data.customer && data.customer.metafield;

  if (!metafield || !metafield.value) {
    return {};
  }

  try {
    return JSON.parse(metafield.value);
  } catch (e) {
    console.error("Failed to parse passport JSON", e);
    return {};
  }
}

// Save updated passport metafield for a customer
async function savePassport(customerId, passport) {
  const gid = `gid://shopify/Customer/${customerId}`;

  const mutation = `
    mutation SavePassport($id: ID!, $value: String!) {
      customerUpdate(input: {
        id: $id,
        metafields: [{
          namespace: "tastetracker",
          key: "passport",
          type: "json",
          value: $value
        }]
      }) {
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    id: gid,
    value: JSON.stringify(passport)
  };

  const data = await shopifyGraphQL(mutation, variables);
  const errors = data.customerUpdate.userErrors;

  if (errors && errors.length > 0) {
    console.error("Metafield save errors:", errors);
    throw new Error(errors[0].message);
  }
}

// Main endpoint: called by your Passport page
app.post("/save", async (req, res) => {
  try {
    const {
      customer_id,
      roast_handle,
      rating,
      brew_method,
      grinding_from_whole_bean,
      grind_notes,
      notes
    } = req.body;

    if (!customer_id || !roast_handle) {
      return res.status(400).json({ ok: false, error: "Missing customer_id or roast_handle" });
    }

    // Load existing passport (all roasts) for this customer
    const passport = await getPassport(customer_id);

    // Update this roast entry
    passport[roast_handle] = {
      ...(passport[roast_handle] || {}),
      rating: Number(rating) || 0,
      brew_method: brew_method || "",
      grinding_from_whole_bean: Boolean(grinding_from_whole_bean),
      grind_notes: grind_notes || "",
      notes: notes || ""
    };

    // Save back to Shopify
    await savePassport(customer_id, passport);

    res.json({ ok: true });
    } catch (e) {
    console.error("Error in /save:", e);
    res.status(500).json({
      ok: false,
      error: e.message || "Server error"
    });
  }
});


// Simple health check route
app.get("/", (req, res) => {
  res.send("Alfie Taste Tracker app is running.");
});

app.listen(PORT, () => {
  console.log(`Taste Tracker app listening on port ${PORT}`);
});
